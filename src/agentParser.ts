import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  id: string;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface TextBlock {
  type: 'text';
  text: string;
  timestamp: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  id: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
  timestamp: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AgentTask {
  agentId: string;
  sessionId: string;
  description: string;
  prompt: string;
  status: 'running' | 'completed' | 'errored';
  startedAt: string;
  lastActivity: string;
  contentBlocks: ContentBlock[];
  model?: string;
  slug?: string;
  /** Byte offset for incremental reads */
  _readOffset: number;
  /** File mtime for staleness detection */
  _lastMtime: number;
}

/**
 * Discover the tasks directory for a given project+session.
 * Claude Code stores agent outputs at /tmp/claude-{uid}/{project-path}/{session-id}/tasks/
 */
export function getTasksDir(projectPath: string, sessionId: string): string {
  const uid = process.getuid?.() ?? 501;
  const sanitized = projectPath.replace(/\//g, '-');
  return path.join('/private/tmp', `claude-${uid}`, sanitized, sessionId, 'tasks');
}

/**
 * Find the current Claude Code session for a workspace folder.
 * Looks at the project JSONL files and finds the most recent one.
 */
export function findCurrentSession(workspacePath: string): { sessionId: string; projectKey: string } | null {
  const projectKey = workspacePath.replace(/\//g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        sessionId: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;
    return { sessionId: files[0].sessionId, projectKey };
  } catch {
    return null;
  }
}

/**
 * Find all sessions that have active task directories (not just the latest JSONL).
 */
export function findSessionsWithTasks(workspacePath: string): string[] {
  const uid = process.getuid?.() ?? 501;
  const projectKey = workspacePath.replace(/\//g, '-');
  const baseDir = path.join('/private/tmp', `claude-${uid}`, projectKey);

  try {
    return fs.readdirSync(baseDir)
      .filter(d => {
        const tasksDir = path.join(baseDir, d, 'tasks');
        return fs.existsSync(tasksDir) && fs.readdirSync(tasksDir).length > 0;
      })
      .sort((a, b) => {
        // Sort by most recent task file modification
        const aDir = path.join(baseDir, a, 'tasks');
        const bDir = path.join(baseDir, b, 'tasks');
        const aMtime = getLatestMtime(aDir);
        const bMtime = getLatestMtime(bDir);
        return bMtime - aMtime;
      });
  } catch {
    return [];
  }
}

function getLatestMtime(dir: string): number {
  try {
    const files = fs.readdirSync(dir);
    let max = 0;
    for (const f of files) {
      const mt = fs.statSync(path.join(dir, f)).mtimeMs;
      if (mt > max) max = mt;
    }
    return max;
  } catch {
    return 0;
  }
}

/**
 * List all agent output files in a tasks directory.
 * Agent files have JSONL content starting with a JSON object.
 * Filter out persisted bash output files (which start with plain text).
 */
export function listAgentFiles(tasksDir: string): string[] {
  try {
    return fs.readdirSync(tasksDir)
      .filter(f => f.endsWith('.output'))
      .filter(f => {
        // Quick check: agent JSONL files start with '{'
        try {
          const fd = fs.openSync(path.join(tasksDir, f), 'r');
          const buf = Buffer.alloc(1);
          fs.readSync(fd, buf, 0, 1, 0);
          fs.closeSync(fd);
          return buf[0] === 0x7b; // '{'
        } catch {
          return false;
        }
      })
      .map(f => path.join(tasksDir, f));
  } catch {
    return [];
  }
}

/**
 * Parse an agent output file into an AgentTask.
 * Supports incremental parsing via _readOffset.
 */
export function parseAgentFile(filePath: string, existing?: AgentTask): AgentTask {
  const agentId = path.basename(filePath, '.output');
  const offset = existing?._readOffset ?? 0;

  let raw: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (offset >= stat.size) {
      fs.closeSync(fd);
      return existing ?? createEmptyTask(agentId, filePath);
    }
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    raw = buf.toString('utf-8');
  } catch {
    return existing ?? createEmptyTask(agentId, filePath);
  }

  const lines = raw.split('\n').filter(Boolean);
  const newBlocks: ContentBlock[] = [];
  let lastTimestamp = existing?.lastActivity ?? '';
  let sessionId = existing?.sessionId ?? '';
  let description = existing?.description ?? '';
  let prompt = existing?.prompt ?? '';
  let model = existing?.model;
  let slug = existing?.slug;
  let status: AgentTask['status'] = existing?.status ?? 'running';
  let startedAt = existing?.startedAt ?? '';

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry['type'] as string;
    const ts = (entry['timestamp'] as string) ?? '';
    if (ts) lastTimestamp = ts;
    if (!sessionId) sessionId = (entry['sessionId'] as string) ?? '';
    if (!slug) slug = (entry['slug'] as string) ?? '';

    if (type === 'user') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      const content = msg['content'] as unknown;

      // First user message = the prompt
      if (!prompt && typeof content === 'string') {
        prompt = content;
        description = content.slice(0, 120);
        startedAt = ts;
      } else if (!prompt && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            prompt = block.text;
            description = block.text.slice(0, 120);
            startedAt = ts;
            break;
          }
        }
      }

      // Tool results
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultText = extractToolResultText(block.content);
            if (resultText) {
              newBlocks.push({
                type: 'tool_result',
                toolUseId: block.tool_use_id ?? '',
                content: resultText,
                isError: block.is_error === true,
                timestamp: ts,
              });
            }
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;

      if (!model) model = (msg['model'] as string) ?? undefined;

      const content = msg['content'] as unknown[];
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        const btype = (block as Record<string, unknown>)['type'] as string;
        if (btype === 'text') {
          const text = (block as Record<string, unknown>)['text'] as string;
          if (text?.trim()) {
            newBlocks.push({ type: 'text', text, timestamp: ts });
          }
        } else if (btype === 'tool_use') {
          const b = block as Record<string, unknown>;
          newBlocks.push({
            type: 'tool_use',
            name: (b['name'] as string) ?? '',
            id: (b['id'] as string) ?? '',
            input: (b['input'] as Record<string, unknown>) ?? {},
            timestamp: ts,
          });
        }
      }
    }
  }

  // Detect completion using multiple signals
  if (status === 'running') {
    // Signal 1: last assistant message has stop_reason=end_turn with no pending tool calls
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn') {
          const content = entry.message?.content ?? [];
          const hasToolUse = content.some((b: Record<string, unknown>) => b.type === 'tool_use');
          if (!hasToolUse) {
            status = 'completed';
            break;
          }
        }
      } catch {}
    }

    // Signal 2: file hasn't been modified in 30+ seconds and we have content
    if (status === 'running') {
      try {
        const stat = fs.statSync(filePath);
        const staleMs = Date.now() - stat.mtimeMs;
        if (staleMs > 30_000 && lines.length > 1) {
          status = 'completed';
        }
      } catch {}
    }
  }

  // Track file mtime
  let mtime = existing?._lastMtime ?? 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch {}

  const newOffset = offset + Buffer.byteLength(raw, 'utf-8');

  return {
    agentId,
    sessionId,
    description,
    prompt,
    status,
    startedAt: startedAt || existing?.startedAt || '',
    lastActivity: lastTimestamp,
    contentBlocks: [...(existing?.contentBlocks ?? []), ...newBlocks],
    model,
    slug,
    _readOffset: newOffset,
    _lastMtime: mtime,
  };
}

function createEmptyTask(agentId: string, _filePath: string): AgentTask {
  return {
    agentId,
    sessionId: '',
    description: '',
    prompt: '',
    status: 'running',
    startedAt: '',
    lastActivity: '',
    contentBlocks: [],
    _readOffset: 0,
    _lastMtime: 0,
  };
}

const SESSION_READ_BYTES = 64 * 1024;

/**
 * Extract a display name for a session, matching Claude Code's logic:
 * customTitle > aiTitle > lastPrompt > summary (from tail) > first user message (from head)
 */
export function getSessionDisplayName(workspacePath: string, sessionId: string): string {
  const projectKey = workspacePath.replace(/\//g, '-');
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);

  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    const headBuf = Buffer.alloc(Math.min(SESSION_READ_BYTES, stat.size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('utf-8');

    // Read tail if file is larger than buffer
    let tail = head;
    if (stat.size > SESSION_READ_BYTES) {
      const tailBuf = Buffer.alloc(SESSION_READ_BYTES);
      fs.readSync(fd, tailBuf, 0, tailBuf.length, stat.size - SESSION_READ_BYTES);
      tail = tailBuf.toString('utf-8');
    }
    fs.closeSync(fd);

    // Priority 1: customTitle or aiTitle (check tail first for most recent)
    const customTitle = extractJsonField(tail, 'customTitle') || extractJsonField(head, 'customTitle');
    if (customTitle) return truncateDisplay(customTitle);

    const aiTitle = extractJsonField(tail, 'aiTitle') || extractJsonField(head, 'aiTitle');
    if (aiTitle) return truncateDisplay(aiTitle);

    // Priority 2: lastPrompt or summary from tail
    const lastPrompt = extractJsonField(tail, 'lastPrompt');
    if (lastPrompt) return truncateDisplay(lastPrompt);

    const summary = extractJsonField(tail, 'summary');
    if (summary) return truncateDisplay(summary);

    // Priority 3: First real user message from head
    const firstMsg = extractFirstUserMessage(head);
    if (firstMsg) return truncateDisplay(firstMsg);
  } catch {}

  return sessionId.slice(0, 8);
}

function truncateDisplay(s: string): string {
  const line = s.replace(/\n/g, ' ').trim();
  return line.length > 80 ? line.slice(0, 77) + '...' : line;
}

/** Fast string-based field extraction (matches Claude Code's B5 function) */
function extractJsonField(text: string, field: string): string | undefined {
  const patterns = [`"${field}":"`, `"${field}": "`];
  for (const pat of patterns) {
    let pos = 0;
    while (true) {
      const idx = text.indexOf(pat, pos);
      if (idx < 0) break;
      const start = idx + pat.length;
      let end = start;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === '"') {
          const val = text.slice(start, end).replace(/\\"/g, '"').replace(/\\n/g, ' ');
          if (val) return val;
          break;
        }
        end++;
      }
      pos = end + 1;
    }
  }
  return undefined;
}

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;
const SKIP_MESSAGE_RE = /^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user[^\]]*\]|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/;

/** Extract first non-meta, non-tool_result user message text (matches Claude Code's Y66) */
function extractFirstUserMessage(head: string): string | undefined {
  let commandFallback = '';
  const lines = head.split('\n');
  for (const line of lines) {
    if (!line) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          }
        }
      }
      for (const raw of texts) {
        const trimmed = raw.replace(/\n/g, ' ').trim();
        if (!trimmed) continue;
        // <command-name>X</command-name> → store X as fallback, skip
        const cmdMatch = COMMAND_NAME_RE.exec(trimmed);
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1];
          continue;
        }
        // Skip system/meta messages
        if (SKIP_MESSAGE_RE.test(trimmed)) continue;
        return trimmed;
      }
    } catch {}
  }
  return commandFallback || undefined;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Record<string, unknown>) => {
        if (c.type === 'text') return c.text as string;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Find agent descriptions from the main session JSONL.
 * Maps agentId -> description from Agent tool calls.
 */
export function findAgentDescriptions(workspacePath: string, sessionId: string): Map<string, string> {
  const projectKey = workspacePath.replace(/\//g, '-');
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectKey, `${sessionId}.jsonl`);
  const map = new Map<string, string>();

  try {
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);

    // First pass: collect Agent tool_use calls with their tool_use_id -> description
    const toolUseToDesc = new Map<string, { description: string; runInBg: boolean }>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'assistant') continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Agent') {
            toolUseToDesc.set(block.id, {
              description: block.input?.description ?? block.input?.prompt?.slice(0, 100) ?? '',
              runInBg: block.input?.run_in_background === true,
            });
          }
        }
      } catch {}
    }

    // Second pass: find tool_results that contain agentId references
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (block.type === 'tool_result' && toolUseToDesc.has(block.tool_use_id)) {
            const text = extractToolResultText(block.content);
            const agentIdMatch = text.match(/agentId:\s*(\S+)/);
            if (agentIdMatch) {
              const desc = toolUseToDesc.get(block.tool_use_id)!;
              map.set(agentIdMatch[1], desc.description);
            }
          }
        }
      } catch {}
    }
  } catch {}

  return map;
}
