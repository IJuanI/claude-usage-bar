import { AgentTask, ContentBlock } from './agentParser';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortenPath(p?: string): string | undefined {
  if (!p) return undefined;
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function timeAgo(ts: string): string {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return (input['command'] as string) ?? JSON.stringify(input, null, 2);
    case 'Read':
      return (input['file_path'] as string) ?? JSON.stringify(input, null, 2);
    case 'Write':
    case 'Edit':
      return (input['file_path'] as string) ?? JSON.stringify(input, null, 2);
    case 'Grep':
      return `${input['pattern'] ?? ''} ${input['path'] ?? ''}`.trim() || JSON.stringify(input, null, 2);
    case 'Glob':
      return `${input['pattern'] ?? ''} ${input['path'] ?? ''}`.trim() || JSON.stringify(input, null, 2);
    case 'Agent':
      return (input['description'] as string) ?? (input['prompt'] as string)?.slice(0, 200) ?? JSON.stringify(input, null, 2);
    default:
      return JSON.stringify(input, null, 2);
  }
}

function formatMarkdown(text: string): string {
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre class="codeblock">${code}</pre>`
  );
  result = result.replace(/^---$/gm, '<hr class="md-hr">');
  result = result.replace(/^#### (.+)$/gm, '<div class="md-h4">$1</div>');
  result = result.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  result = result.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  result = result.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');
  result = result.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  result = result.replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>');
  result = result.replace(/^\d+\. (.+)$/gm, '<div class="md-li">$1</div>');
  result = result.replace(/^(\|.+\|)$/gm, (_m, row) => {
    if (/^\|[\s\-:]+\|$/.test(row)) return '';
    const cells = row.split('|').filter(Boolean).map((c: string) => c.trim());
    return '<div class="md-table-row">' + cells.map((c: string) => `<span class="md-cell">${c}</span>`).join('') + '</div>';
  });
  result = result.replace(/\n/g, '<br>');
  result = result.replace(/<br>\s*(<(?:pre|div|hr))/g, '$1');
  result = result.replace(/(<\/(?:pre|div)>)\s*<br>/g, '$1');
  return result;
}

const COLLAPSE_LINE_THRESHOLD = 10;

function renderContentBlock(block: ContentBlock, index: number): string {
  switch (block.type) {
    case 'text': {
      const rendered = formatMarkdown(esc(block.text));
      const lineCount = block.text.split('\n').length;
      if (lineCount > COLLAPSE_LINE_THRESHOLD) {
        const uid = `txt-${index}-${Date.now()}`;
        return `<div class="block block-text collapsible collapsed" data-uid="${uid}">
          <div class="text-content">${rendered}</div>
          <div class="collapse-bar" onclick="toggleCollapse(this)">
            <span class="collapse-label">Show more</span>
          </div>
        </div>`;
      }
      return `<div class="block block-text">${rendered}</div>`;
    }
    case 'tool_use': {
      const inputStr = formatToolInput(block.name, block.input);
      return `<details class="block block-tool">
        <summary class="tool-header">
          <span class="tool-icon">⚙</span>
          <span class="tool-name">${esc(block.name)}</span>
          <span class="tool-time">${timeAgo(block.timestamp)}</span>
        </summary>
        <div class="tool-body"><pre>${esc(inputStr)}</pre></div>
      </details>`;
    }
    case 'tool_result': {
      const cls = block.isError ? 'tool-result-error' : 'tool-result-ok';
      const truncated = block.content.length > 2000
        ? block.content.slice(0, 2000) + '\n... (truncated)'
        : block.content;
      return `<details class="block block-result ${cls}">
        <summary class="result-header">
          <span class="result-icon">${block.isError ? '✗' : '✓'}</span>
          <span class="result-label">${block.isError ? 'Error' : 'Result'}</span>
        </summary>
        <div class="result-body"><pre>${esc(truncated)}</pre></div>
      </details>`;
    }
  }
}

const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2zm2-2v2h2a2 2 0 0 1 2 2v2h2V2H6zM2 8v6h6V8H2z"/></svg>';

/** Serialize a task to a JSON-safe data object for the webview */
export function serializeTask(task: AgentTask, descOverride?: string, sessionLabel?: string): SerializedTask {
  const isRunning = task.status === 'running';
  const blocks = task.contentBlocks;
  const recentBlocks = isRunning ? blocks.slice(-20) : blocks;
  const hiddenCount = blocks.length - recentBlocks.length;

  // Build searchable text from all blocks (not just recent ones)
  const searchParts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') searchParts.push(b.text.slice(0, 500));
    else if (b.type === 'tool_use') searchParts.push(b.name + ' ' + formatToolInput(b.name, b.input).slice(0, 200));
    else if (b.type === 'tool_result' && b.isError) searchParts.push(b.content.slice(0, 300));
    if (searchParts.join('').length > 3000) break; // cap total search text
  }

  return {
    agentId: task.agentId,
    sessionId: task.sessionId,
    status: task.status,
    description: descOverride || task.description || task.agentId.slice(0, 12),
    model: task.model ? task.model.replace('claude-', '') : undefined,
    startedAt: task.startedAt,
    lastActivity: task.lastActivity,
    sessionLabel,
    hiddenCount,
    blockCount: blocks.length,
    blocksHtml: recentBlocks.map((b, i) => renderContentBlock(b, i)).join(''),
    searchText: searchParts.join(' ').slice(0, 3000),
  };
}

export interface SerializedTask {
  agentId: string;
  sessionId: string;
  status: string;
  description: string;
  model?: string;
  startedAt: string;
  lastActivity?: string;
  sessionLabel?: string;
  hiddenCount: number;
  blockCount: number;
  blocksHtml: string;
  searchText: string;
}

export interface SessionInfo {
  id: string;
  displayName: string;
}

export interface PanelInfo {
  workspace?: string;
  sessions: SessionInfo[];
  sessionNames: Map<string, string>;
  isOverride: boolean;
  isDevMode: boolean;
}

const FOLDER_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 14h13a.5.5 0 0 0 .5-.5V4a.5.5 0 0 0-.5-.5H7.71a.5.5 0 0 1-.36-.15L5.86 1.85A.5.5 0 0 0 5.5 1.7H1.5a.5.5 0 0 0-.5.5v11.3a.5.5 0 0 0 .5.5z"/></svg>';
const SEARCH_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';

function renderToolbar(panel: PanelInfo): string {
  const wsLabel = shortenPath(panel.workspace) ?? 'auto';
  const sessionLabels = panel.sessions.length > 0
    ? panel.sessions.map(s => s.displayName).join(', ')
    : 'auto (latest)';
  const sessionCount = panel.sessions.length;
  const devLabel = panel.isDevMode ? '<span class="toolbar-dev-badge">DEV</span>' : '';

  return `<div class="toolbar">
    <div class="toolbar-row">
      <button class="toolbar-btn workspace-btn" onclick="vscode.postMessage({command:'selectWorkspace'})" title="Change workspace">
        ${FOLDER_ICON}
        <span class="toolbar-label">${esc(wsLabel)}</span>
      </button>
      ${devLabel}
      ${panel.isOverride ? '<button class="toolbar-reset" onclick="vscode.postMessage({command:\'clearOverrides\'})" title="Reset to auto">×</button>' : ''}
    </div>
    <div class="toolbar-row">
      <button class="toolbar-btn session-btn" onclick="vscode.postMessage({command:'selectSession'})" title="Select sessions">
        <span class="toolbar-label">${esc(sessionLabels)}</span>
        ${sessionCount > 1 ? `<span class="toolbar-badge">${sessionCount}</span>` : ''}
      </button>
    </div>
  </div>`;
}

export function getAgentPanelHtml(tasks: SerializedTask[], panel?: PanelInfo): string {
  // Pre-render initial task data as JSON for the webview JS
  const tasksJson = JSON.stringify(tasks);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Claude Agents</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 8px 12px;
      user-select: text;
      overflow-y: auto;
    }

    .empty {
      text-align: center;
      padding: 32px 16px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-icon { font-size: 28px; margin-bottom: 8px; }

    .section-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
      margin: 12px 0 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-label:first-child { margin-top: 4px; }
    .section-count {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
    }

    /* ── Task card ── */
    .task {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .task.status-running {
      border-color: var(--vscode-charts-blue, #4fc1ff);
      border-width: 1px 1px 1px 3px;
    }
    .task.status-completed { opacity: 0.8; }
    .task.status-errored {
      border-color: var(--vscode-charts-red, #f44747);
      border-width: 1px 1px 1px 3px;
    }

    .task-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px 4px;
      cursor: pointer;
      user-select: none;
    }
    .task-header:hover { background: var(--vscode-list-hoverBackground); }
    .task-status { display: flex; align-items: center; gap: 6px; }
    .status-dot { font-size: 10px; line-height: 1; }
    .status-dot.status-running { color: var(--vscode-charts-blue, #4fc1ff); }
    .status-dot.status-completed { color: var(--vscode-charts-green, #89d185); }
    .status-dot.status-errored { color: var(--vscode-charts-red, #f44747); }
    .status-text {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .task-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .task-model {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
    }
    .task-chevron {
      font-size: 10px;
      transition: transform 0.15s;
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
    }
    .task.expanded .task-chevron { transform: rotate(90deg); }

    .task-summary {
      padding: 0 10px 6px;
    }
    .task-desc {
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
    }
    .task-session-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-id {
      display: flex;
      align-items: center;
      gap: 3px;
      margin-top: 2px;
    }
    .task-id-text {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-descriptionForeground);
      user-select: all;
    }

    /* ── Icon button (copy) ── */
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      padding: 0;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      opacity: 0.4;
      flex-shrink: 0;
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-button-secondaryBackground); }
    .icon-btn svg { display: block; }

    /* ── Task content (collapsed by default) ── */
    .task-content {
      border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.15));
      max-height: 500px;
      overflow-y: auto;
      padding: 6px 10px;
      position: relative;
      display: none;
    }
    .task.expanded .task-content { display: block; }

    /* ── Scroll nav ── */
    .scroll-nav {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      justify-content: center;
      gap: 8px;
      padding: 2px 0 4px;
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
    }
    .task-content:hover .scroll-nav { opacity: 1; pointer-events: auto; }
    .scroll-nav-btn {
      font-family: var(--vscode-font-family);
      font-size: 10px;
      padding: 1px 10px;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 10px;
      cursor: pointer;
      opacity: 0.7;
    }
    .scroll-nav-btn:hover { opacity: 1; background: var(--vscode-button-secondaryBackground); }
    .scroll-nav-btn.hidden { display: none; }

    /* ── Content blocks ── */
    .block { margin-bottom: 6px; }
    .block:last-child { margin-bottom: 0; }

    .block-text {
      font-size: 12px;
      line-height: 1.5;
      padding: 4px 0;
    }
    .block-text pre.codeblock {
      background: var(--vscode-textCodeBlock-background);
      padding: 6px 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 11px;
      margin: 4px 0;
    }
    .block-text code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 11px;
    }
    .block-text .md-h1 { font-size: 15px; font-weight: 700; margin: 6px 0 4px; }
    .block-text .md-h2 { font-size: 14px; font-weight: 700; margin: 5px 0 3px; }
    .block-text .md-h3 { font-size: 13px; font-weight: 600; margin: 4px 0 2px; }
    .block-text .md-h4 { font-size: 12px; font-weight: 600; margin: 3px 0 2px; color: var(--vscode-descriptionForeground); }
    .block-text .md-hr { border: none; border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2)); margin: 6px 0; }
    .block-text .md-li { padding-left: 12px; margin: 1px 0; }
    .block-text .md-table-row {
      display: flex;
      gap: 2px;
      font-size: 11px;
      padding: 2px 0;
      border-bottom: 1px solid var(--vscode-input-border, rgba(128,128,128,0.1));
    }
    .block-text .md-cell {
      flex: 1;
      padding: 1px 4px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Collapsible text ── */
    .collapsible { position: relative; }
    .collapsible.collapsed .text-content {
      display: -webkit-box;
      -webkit-line-clamp: ${COLLAPSE_LINE_THRESHOLD};
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .collapse-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0 1px;
      cursor: pointer;
    }
    .collapse-bar::before, .collapse-bar::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--vscode-input-border, rgba(128,128,128,0.2));
    }
    .collapse-label {
      font-family: var(--vscode-font-family);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .collapse-bar:hover .collapse-label {
      color: var(--vscode-textLink-foreground, #4fc1ff);
    }

    details.block-tool, details.block-result {
      border-radius: 4px;
      overflow: hidden;
    }
    details summary {
      cursor: pointer;
      list-style: none;
      padding: 4px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    details summary::-webkit-details-marker { display: none; }
    details[open] summary { border-radius: 4px 4px 0 0; }

    .tool-icon { font-size: 11px; opacity: 0.7; }
    .tool-name { font-weight: 600; font-size: 11px; }
    .tool-time {
      margin-left: auto;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .tool-body, .result-body {
      padding: 6px 8px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 0 0 4px 4px;
    }
    .tool-body pre, .result-body pre {
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }

    .result-icon { font-size: 11px; }
    .tool-result-error .result-icon { color: var(--vscode-charts-red, #f44747); }
    .tool-result-ok .result-icon { color: var(--vscode-charts-green, #89d185); }
    .result-label { font-size: 11px; font-weight: 600; }

    .hidden-count {
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 4px;
      font-style: italic;
    }

    /* ── Typing indicator ── */
    .typing-indicator {
      display: flex;
      gap: 4px;
      padding: 8px 4px;
      align-items: center;
    }
    .typing-indicator span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-charts-blue, #4fc1ff);
      opacity: 0.4;
      animation: pulse 1.4s infinite;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse {
      0%, 80%, 100% { opacity: 0.4; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }

    .divider {
      height: 1px;
      background: var(--vscode-input-border, rgba(128,128,128,0.15));
      margin: 8px 0;
    }

    /* ── Toolbar ── */
    .toolbar {
      margin-bottom: 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .toolbar-row {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .toolbar-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      font-family: var(--vscode-font-family);
      font-size: 11px;
      padding: 3px 8px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 4px;
      cursor: pointer;
      overflow: hidden;
      flex: 1;
      min-width: 0;
    }
    .toolbar-btn:hover { background: var(--vscode-list-hoverBackground); }
    .toolbar-btn svg { flex-shrink: 0; opacity: 0.6; }
    .toolbar-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 0 5px;
      border-radius: 8px;
      font-size: 10px;
      flex-shrink: 0;
    }
    .toolbar-dev-badge {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: var(--vscode-charts-orange, #cca700);
      border: 1px dashed var(--vscode-charts-orange, #cca700);
      border-radius: 3px;
      padding: 1px 4px;
      flex-shrink: 0;
    }
    .toolbar-reset {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      font-family: var(--vscode-font-family);
      font-size: 14px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .toolbar-reset:hover {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-foreground);
    }

    /* ── Controls bar (search + filters) ── */
    .controls-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .search-box {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 1;
      min-width: 0;
      padding: 3px 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 4px;
    }
    .search-box svg { flex-shrink: 0; opacity: 0.5; }
    .search-input {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: none;
      outline: none;
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: 11px;
    }
    .search-input::placeholder { color: var(--vscode-input-placeholderForeground); }

    /* ── Filter buttons ── */
    .filter-btns {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .filter-btn {
      font-family: var(--vscode-font-family);
      font-size: 10px;
      padding: 3px 7px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      cursor: pointer;
      outline: none;
      transition: background 0.1s, color 0.1s;
    }
    .filter-btn:first-child { border-radius: 4px 0 0 4px; }
    .filter-btn:last-child { border-radius: 0 4px 4px 0; }
    .filter-btn.active {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .filter-btn:hover:not(.active) {
      background: var(--vscode-list-hoverBackground);
    }

    .no-results {
      text-align: center;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      display: none;
    }

    /* ── Task block count badge ── */
    .task-block-count {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }

    /* ── View toggle ── */
    .view-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 22px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      flex-shrink: 0;
    }
    .view-toggle:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }

    /* ── Session groups (grouped view) ── */
    .session-group { margin-bottom: 6px; }
    .session-header {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 8px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      user-select: none;
    }
    .session-header:hover { background: var(--vscode-list-hoverBackground); }
    .session-chevron {
      font-size: 10px;
      transition: transform 0.15s;
      flex-shrink: 0;
      width: 10px;
    }
    .session-group.expanded .session-chevron { transform: rotate(90deg); }
    .session-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .session-running-badge {
      font-size: 10px;
      color: var(--vscode-charts-blue, #4fc1ff);
      flex-shrink: 0;
    }
    .session-count {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 0 5px;
      border-radius: 8px;
      font-size: 10px;
      flex-shrink: 0;
    }
    .session-tasks {
      display: none;
      padding: 4px 0 0 0;
    }
    .session-group.expanded .session-tasks { display: block; }
  </style>
</head>
<body>
  ${panel ? renderToolbar(panel) : ''}

  <div class="controls-bar" id="controlsBar" style="display:none">
    <div class="search-box">
      ${SEARCH_ICON}
      <input type="text" class="search-input" id="searchInput" placeholder="Filter agents..." />
    </div>
    <div class="filter-btns">
      <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
      <button class="filter-btn" data-filter="running" onclick="setFilter('running')">Active</button>
      <button class="filter-btn" data-filter="completed" onclick="setFilter('completed')">Done</button>
    </div>
    <button class="view-toggle" id="viewToggle" onclick="toggleViewMode()" title="Toggle flat/grouped view" style="display:none">☰</button>
  </div>

  <div id="taskList"></div>
  <div class="no-results" id="noResults">No matching agents</div>
  <div class="empty" id="emptyState">
    <div class="empty-icon">◎</div>
    <div>No background agents</div>
    <div style="font-size:11px;margin-top:4px;">Agents will appear here when launched</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const COPY_ICON = '${COPY_ICON.replace(/'/g, "\\'")}';

    // ── State ──
    let currentTasks = ${tasksJson};
    let expandedTasks = new Set();
    let currentFilter = 'all';
    let scrollPositions = {};
    let lockedToBottom = new Set();

    // Auto-expand running tasks on first load
    currentTasks.forEach(t => {
      if (t.status === 'running') expandedTasks.add(t.agentId);
    });

    // ── Search (with debounce) ──
    let searchTimeout = null;
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(applyVisibility, 150);
    });

    function setFilter(f) {
      currentFilter = f;
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === f);
      });
      applyVisibility();
    }

    function applyVisibility() {
      const query = (searchInput.value || '').toLowerCase().trim();
      let visible = 0;
      document.querySelectorAll('.task').forEach(el => {
        const search = (el.dataset.search || '').toLowerCase();
        const status = el.dataset.status || '';
        const matchSearch = !query || search.includes(query);
        const matchStatus = currentFilter === 'all' || status === currentFilter;
        const show = matchSearch && matchStatus;
        el.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      // In grouped view, hide empty groups
      if (isGroupedView) {
        document.querySelectorAll('.session-group').forEach(group => {
          const hasTasks = group.querySelectorAll('.task:not([style*="display: none"])').length > 0;
          group.style.display = hasTasks ? '' : 'none';
        });
      }

      document.getElementById('noResults').style.display =
        visible === 0 && currentTasks.length > 0 ? '' : 'none';
    }

    // ── Build a task card ──
    function buildTaskCard(t) {
      const isRunning = t.status === 'running';
      const statusCls = isRunning ? 'status-running' : t.status === 'completed' ? 'status-completed' : 'status-errored';
      const statusLabel = isRunning ? 'Running' : t.status === 'completed' ? 'Completed' : 'Errored';
      const statusIcon = isRunning ? '◉' : t.status === 'completed' ? '✓' : '✗';
      const isExpanded = expandedTasks.has(t.agentId);
      const searchable = [t.description, t.agentId, t.model || '', t.sessionLabel || '', t.searchText || ''].join(' ');

      const div = document.createElement('div');
      div.className = 'task ' + statusCls + (isExpanded ? ' expanded' : '');
      div.dataset.agentId = t.agentId;
      div.dataset.sessionId = t.sessionId;
      div.dataset.status = t.status;
      div.dataset.search = searchable;

      const model = t.model ? '<span class="task-model">' + escHtml(t.model) + '</span>' : '';
      const sessionLine = t.sessionLabel
        ? '<div class="task-session-label">Session: ' + escHtml(t.sessionLabel) + '</div>'
        : '';

      div.innerHTML =
        '<div class="task-header" onclick="toggleTask(\\'' + t.agentId + '\\')">' +
          '<div class="task-status">' +
            '<span class="status-dot ' + statusCls + '">' + statusIcon + '</span>' +
            '<span class="status-text">' + statusLabel + '</span>' +
          '</div>' +
          '<div class="task-meta">' +
            model +
            '<span class="task-time">' + escHtml(timeAgo(t.startedAt)) + '</span>' +
            '<span class="task-block-count">' + t.blockCount + ' blocks</span>' +
            '<span class="task-chevron">▸</span>' +
          '</div>' +
        '</div>' +
        '<div class="task-summary">' +
          '<div class="task-desc">' + escHtml(t.description) + '</div>' +
          sessionLine +
          '<div class="task-id">' +
            '<span class="task-id-text">' + escHtml(t.agentId) + '</span>' +
            '<button class="icon-btn" onclick="event.stopPropagation();copyText(\\'' + t.agentId + '\\')" title="Copy agent ID">' + COPY_ICON + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="task-content">' +
          '<div class="scroll-nav">' +
            '<button class="scroll-nav-btn" onclick="jumpTo(this,\\'top\\')" title="Jump to start">↑ Start</button>' +
            '<button class="scroll-nav-btn" onclick="jumpTo(this,\\'bottom\\')" title="Jump to end">↓ End</button>' +
          '</div>' +
          (t.hiddenCount > 0 ? '<div class="hidden-count">' + t.hiddenCount + ' earlier entries hidden</div>' : '') +
          t.blocksHtml +
          (isRunning ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : '') +
        '</div>';

      return div;
    }

    function escHtml(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function timeAgo(ts) {
      if (!ts) return '';
      const ms = Date.now() - new Date(ts).getTime();
      if (ms < 60000) return 'just now';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
      if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
      return Math.floor(ms / 86400000) + 'd ago';
    }

    function copyText(text) {
      vscode.postMessage({ command: 'copyToClipboard', text: text });
    }

    // ── Toggle task expand/collapse ──
    function toggleTask(agentId) {
      if (expandedTasks.has(agentId)) {
        expandedTasks.delete(agentId);
      } else {
        expandedTasks.add(agentId);
      }
      const el = document.querySelector('.task[data-agent-id="' + agentId + '"]');
      if (el) {
        el.classList.toggle('expanded', expandedTasks.has(agentId));
        if (expandedTasks.has(agentId)) {
          const content = el.querySelector('.task-content');
          if (content && !scrollPositions[agentId]) {
            // First expand: scroll to bottom
            content.scrollTop = content.scrollHeight;
            lockedToBottom.add(agentId);
          }
          setupScrollTracking(el);
        }
      }
    }

    // ── Scroll tracking ──
    function setupScrollTracking(taskEl) {
      const content = taskEl.querySelector('.task-content');
      const id = taskEl.dataset.agentId;
      if (!content || !id) return;

      // Restore scroll position
      if (lockedToBottom.has(id)) {
        content.scrollTop = content.scrollHeight;
      } else if (scrollPositions[id] !== undefined) {
        content.scrollTop = scrollPositions[id];
      }

      content.onscroll = () => {
        const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 30;
        if (nearBottom) {
          lockedToBottom.add(id);
        } else {
          lockedToBottom.delete(id);
        }
        scrollPositions[id] = content.scrollTop;
        updateScrollNav(content);
      };
      updateScrollNav(content);
    }

    function updateScrollNav(content) {
      const nav = content.querySelector('.scroll-nav');
      if (!nav) return;
      const startBtn = nav.children[0];
      const endBtn = nav.children[1];
      if (startBtn) startBtn.classList.toggle('hidden', content.scrollTop < 10);
      if (endBtn) endBtn.classList.toggle('hidden', content.scrollHeight - content.scrollTop - content.clientHeight < 10);
    }

    function jumpTo(btn, dir) {
      const content = btn.closest('.task-content');
      if (!content) return;
      const id = content.closest('.task')?.dataset.agentId;
      if (dir === 'top') {
        content.scrollTop = 0;
        if (id) lockedToBottom.delete(id);
      } else {
        content.scrollTop = content.scrollHeight;
        if (id) lockedToBottom.add(id);
      }
    }

    function toggleCollapse(bar) {
      const block = bar.closest('.collapsible');
      if (!block) return;
      block.classList.toggle('collapsed');
      const label = bar.querySelector('.collapse-label');
      if (label) label.textContent = block.classList.contains('collapsed') ? 'Show more' : 'Show less';
    }

    // ── View mode ──
    let isGroupedView = false;
    let expandedGroups = new Set();

    function toggleViewMode() {
      isGroupedView = !isGroupedView;
      const btn = document.getElementById('viewToggle');
      if (btn) btn.textContent = isGroupedView ? '☰' : '▦';
      if (btn) btn.title = isGroupedView ? 'Switch to flat view' : 'Switch to grouped view';
      renderTasks(currentTasks);
    }

    function toggleSessionGroup(sessionId) {
      if (expandedGroups.has(sessionId)) {
        expandedGroups.delete(sessionId);
      } else {
        expandedGroups.add(sessionId);
      }
      const el = document.querySelector('.session-group[data-session-id="' + sessionId + '"]');
      if (el) el.classList.toggle('expanded', expandedGroups.has(sessionId));
    }

    // ── Incremental render ──
    function renderTasks(tasks) {
      const list = document.getElementById('taskList');
      const controlsBar = document.getElementById('controlsBar');
      const emptyState = document.getElementById('emptyState');
      const viewToggle = document.getElementById('viewToggle');

      if (tasks.length === 0) {
        list.innerHTML = '';
        controlsBar.style.display = 'none';
        emptyState.style.display = '';
        return;
      }

      controlsBar.style.display = '';
      emptyState.style.display = 'none';

      // Show view toggle only when multiple sessions
      const sessionIds = new Set(tasks.map(t => t.sessionId));
      if (viewToggle) viewToggle.style.display = sessionIds.size > 1 ? '' : 'none';

      if (isGroupedView && sessionIds.size > 1) {
        renderGrouped(tasks, list);
      } else {
        renderFlat(tasks, list);
      }

      applyVisibility();
    }

    function renderFlat(tasks, list) {
      // Build a map of existing DOM cards
      const existingCards = new Map();
      list.querySelectorAll('.task').forEach(el => {
        existingCards.set(el.dataset.agentId, el);
      });

      // Auto-expand newly appeared running tasks
      tasks.forEach(t => {
        if (t.status === 'running' && !existingCards.has(t.agentId) && !expandedTasks.has(t.agentId)) {
          expandedTasks.add(t.agentId);
        }
      });

      const fragment = document.createDocumentFragment();

      for (const t of tasks) {
        const existing = existingCards.get(t.agentId);
        if (existing) {
          updateTaskCard(existing, t);
          fragment.appendChild(existing);
        } else {
          const card = buildTaskCard(t);
          fragment.appendChild(card);
          if (expandedTasks.has(t.agentId)) {
            requestAnimationFrame(() => setupScrollTracking(card));
          }
        }
      }

      list.innerHTML = '';
      list.appendChild(fragment);
    }

    function renderGrouped(tasks, list) {
      // Group by session
      const groups = new Map();
      for (const t of tasks) {
        const sid = t.sessionId || 'unknown';
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid).push(t);
      }

      // Sort: sessions with running tasks first, then by most recent activity
      const sorted = [...groups.entries()].sort((a, b) => {
        const aRun = a[1].some(t => t.status === 'running');
        const bRun = b[1].some(t => t.status === 'running');
        if (aRun && !bRun) return -1;
        if (!aRun && bRun) return 1;
        return 0;
      });

      // Auto-expand groups with running tasks
      for (const [sid, grpTasks] of sorted) {
        if (grpTasks.some(t => t.status === 'running') && !expandedGroups.has(sid)) {
          expandedGroups.add(sid);
        }
      }

      // Get existing cards
      const existingCards = new Map();
      list.querySelectorAll('.task').forEach(el => {
        existingCards.set(el.dataset.agentId, el);
      });

      // Auto-expand newly appeared running tasks
      tasks.forEach(t => {
        if (t.status === 'running' && !existingCards.has(t.agentId) && !expandedTasks.has(t.agentId)) {
          expandedTasks.add(t.agentId);
        }
      });

      const fragment = document.createDocumentFragment();

      for (const [sid, grpTasks] of sorted) {
        const name = grpTasks[0].sessionLabel || sid.slice(0, 8);
        const runCount = grpTasks.filter(t => t.status === 'running').length;
        const isExpGrp = expandedGroups.has(sid);

        const group = document.createElement('div');
        group.className = 'session-group' + (isExpGrp ? ' expanded' : '');
        group.dataset.sessionId = sid;

        const runBadge = runCount > 0 ? '<span class="session-running-badge">' + runCount + ' running</span>' : '';
        group.innerHTML =
          '<div class="session-header" onclick="toggleSessionGroup(\\'' + sid + '\\')">' +
            '<span class="session-chevron">▸</span>' +
            '<span class="session-name" title="' + escHtml(name) + '">' + escHtml(name) + '</span>' +
            runBadge +
            '<span class="session-count">' + grpTasks.length + '</span>' +
          '</div>';

        const tasksContainer = document.createElement('div');
        tasksContainer.className = 'session-tasks';

        for (const t of grpTasks) {
          const existing = existingCards.get(t.agentId);
          if (existing) {
            updateTaskCard(existing, t);
            tasksContainer.appendChild(existing);
          } else {
            const card = buildTaskCard(t);
            tasksContainer.appendChild(card);
            if (expandedTasks.has(t.agentId)) {
              requestAnimationFrame(() => setupScrollTracking(card));
            }
          }
        }

        group.appendChild(tasksContainer);
        fragment.appendChild(group);
      }

      list.innerHTML = '';
      list.appendChild(fragment);
    }

    function updateTaskCard(el, t) {
      const isRunning = t.status === 'running';
      const statusCls = isRunning ? 'status-running' : t.status === 'completed' ? 'status-completed' : 'status-errored';

      // Update class
      el.className = 'task ' + statusCls + (expandedTasks.has(t.agentId) ? ' expanded' : '');
      el.dataset.status = t.status;
      el.dataset.search = [t.description, t.agentId, t.model || '', t.sessionLabel || '', t.searchText || ''].join(' ');

      // Update status text
      const statusText = el.querySelector('.status-text');
      if (statusText) {
        statusText.textContent = isRunning ? 'Running' : t.status === 'completed' ? 'Completed' : 'Errored';
      }
      const statusDot = el.querySelector('.status-dot');
      if (statusDot) {
        statusDot.className = 'status-dot ' + statusCls;
        statusDot.textContent = isRunning ? '◉' : t.status === 'completed' ? '✓' : '✗';
      }

      // Update time
      const timeEl = el.querySelector('.task-time');
      if (timeEl) timeEl.textContent = timeAgo(t.startedAt);

      // Update block count
      const countEl = el.querySelector('.task-block-count');
      if (countEl) countEl.textContent = t.blockCount + ' blocks';

      // Update content blocks (only if expanded and content changed)
      if (expandedTasks.has(t.agentId)) {
        const content = el.querySelector('.task-content');
        if (content) {
          // Save scroll state
          const wasLocked = lockedToBottom.has(t.agentId);
          const prevScroll = content.scrollTop;

          // Rebuild content HTML
          const hiddenHtml = t.hiddenCount > 0
            ? '<div class="hidden-count">' + t.hiddenCount + ' earlier entries hidden</div>'
            : '';
          const typingHtml = isRunning
            ? '<div class="typing-indicator"><span></span><span></span><span></span></div>'
            : '';

          content.innerHTML =
            '<div class="scroll-nav">' +
              '<button class="scroll-nav-btn" onclick="jumpTo(this,\\'top\\')" title="Jump to start">↑ Start</button>' +
              '<button class="scroll-nav-btn" onclick="jumpTo(this,\\'bottom\\')" title="Jump to end">↓ End</button>' +
            '</div>' +
            hiddenHtml + t.blocksHtml + typingHtml;

          // Restore scroll
          if (wasLocked) {
            content.scrollTop = content.scrollHeight;
          } else {
            content.scrollTop = prevScroll;
          }

          setupScrollTracking(el);
        }
      }
    }

    // ── Message handler ──
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'updateTasks') {
        currentTasks = msg.tasks;
        renderTasks(currentTasks);
      }
    });

    // Initial render
    renderTasks(currentTasks);
  </script>
</body>
</html>`;
}
