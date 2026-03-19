import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentTask,
  findCurrentSession,
  getTasksDir,
  listAgentFiles,
  parseAgentFile,
  findAgentDescriptions,
  findSessionsWithTasks,
  getSessionDisplayName,
} from './agentParser';
import { getAgentPanelHtml, serializeTask, SerializedTask, PanelInfo } from './agentWebview';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeUsageBar.agentView';

  private _view?: vscode.WebviewView;
  private _tasks = new Map<string, AgentTask>();
  private _descriptions = new Map<string, string>();
  private _watchers = new Map<string, fs.FSWatcher>();
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _currentSessionIds = new Set<string>();
  private _disposed = false;

  // Overrides
  private _overrideWorkspace?: string;
  private _selectedSessionIds = new Set<string>();

  private _lastIconState = false;
  private _editorPanel?: vscode.WebviewPanel;
  private _displayNameCache = new Map<string, string>();

  constructor(private readonly _context: vscode.ExtensionContext) {
    // Start polling immediately (even before view is resolved) so the icon shows up
    this.startWatching();
  }

  private get isDevMode(): boolean {
    return this._context.extensionMode !== vscode.ExtensionMode.Production
      || vscode.workspace.getConfiguration('claudeUsageBar').get<boolean>('debugMode', false);
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    this._initialized.delete('sidebar');
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'selectWorkspace') this.handleSelectWorkspace();
      else if (msg.command === 'selectSession') this.handleSelectSession();
      else if (msg.command === 'clearOverrides') this.handleClearOverrides();
      else if (msg.command === 'copyToClipboard') {
        vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage(`Copied to clipboard`);
      }
    });

    webviewView.onDidDispose(() => {
      this._disposed = true;
      this._initialized.delete('sidebar');
      this.stopWatching();
    });

    this.refresh();
  }

  private getEffectiveWorkspacePath(): string | undefined {
    return this._overrideWorkspace ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getEffectiveSessions(workspacePath: string): { sessionIds: string[]; projectKey: string } | null {
    const projectKey = workspacePath.replace(/\//g, '-');
    if (this._selectedSessionIds.size > 0) {
      return { sessionIds: [...this._selectedSessionIds], projectKey };
    }
    const current = findCurrentSession(workspacePath);
    if (!current) return null;
    return { sessionIds: [current.sessionId], projectKey };
  }

  // ── Select workspace ───────────────────────────────────────
  private async handleSelectWorkspace() {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    let entries: string[];
    try {
      entries = fs.readdirSync(projectsDir).filter(d => {
        return fs.statSync(path.join(projectsDir, d)).isDirectory();
      });
    } catch {
      vscode.window.showErrorMessage('Cannot read ~/.claude/projects/');
      return;
    }

    // Convert project keys back to paths for display
    const items = entries.map(key => {
      const wsPath = key.replace(/^-/, '/').replace(/-/g, '/');
      const sessionCount = fs.readdirSync(path.join(projectsDir, key))
        .filter(f => f.endsWith('.jsonl')).length;
      return {
        label: wsPath,
        description: `${sessionCount} sessions`,
        projectKey: key,
        wsPath,
      };
    }).sort((a, b) => {
      // Sort by most recent session file
      const aDir = path.join(projectsDir, a.projectKey);
      const bDir = path.join(projectsDir, b.projectKey);
      const aMtime = getLatestMtime(aDir);
      const bMtime = getLatestMtime(bDir);
      return bMtime - aMtime;
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select workspace (project)',
      matchOnDescription: true,
    });

    if (picked) {
      this._overrideWorkspace = picked.wsPath;
      this._selectedSessionIds.clear();
      this._tasks.clear();
      this._currentSessionIds.clear();
      this._initialized.clear(); // Force full re-render (toolbar changed)
      this.resetWatchers();
      this.refresh();
    }
  }

  // ── Select session(s) ──────────────────────────────────────
  private async handleSelectSession() {
    const workspacePath = this.getEffectiveWorkspacePath();
    if (!workspacePath) {
      vscode.window.showErrorMessage('Select a workspace first');
      return;
    }

    const projectKey = workspacePath.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);

    let jsonlFiles: { name: string; mtime: number }[];
    try {
      jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      vscode.window.showErrorMessage(`No sessions found for ${workspacePath}`);
      return;
    }

    const sessionsWithTasks = new Set(findSessionsWithTasks(workspacePath));

    const items = jsonlFiles
      .filter(f => sessionsWithTasks.has(f.name.replace('.jsonl', '')))
      .map(f => {
        const sessionId = f.name.replace('.jsonl', '');
        const date = new Date(f.mtime);
        const displayName = getSessionDisplayName(workspacePath, sessionId);
        const picked = this._selectedSessionIds.has(sessionId);
        return {
          label: `$(symbol-event) ${displayName}`,
          description: `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
          detail: sessionId,
          sessionId,
          picked,
        };
      });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select sessions (multi-select)',
      matchOnDescription: true,
      matchOnDetail: true,
      canPickMany: true,
    });

    if (picked) {
      this._selectedSessionIds = new Set(picked.map(p => p.sessionId));
      this._tasks.clear();
      this._currentSessionIds.clear();
      this._initialized.clear(); // Force full re-render (toolbar changed)
      this.resetWatchers();
      this.refresh();
    }
  }

  private handleClearOverrides() {
    this._overrideWorkspace = undefined;
    this._selectedSessionIds.clear();
    this._tasks.clear();
    this._currentSessionIds.clear();
    this._displayNameCache.clear();
    this._initialized.clear(); // Force full re-render (toolbar changed)
    this.resetWatchers();
    this.refresh();
  }

  private resetWatchers() {
    for (const w of this._watchers.values()) w.close();
    this._watchers.clear();
  }

  private startWatching() {
    this.stopWatching();

    this._pollTimer = setInterval(() => {
      if (this._disposed) return;
      this.checkForUpdates();
    }, 2000);
  }

  private stopWatching() {
    this.resetWatchers();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private checkForUpdates() {
    const workspacePath = this.getEffectiveWorkspacePath();
    if (!workspacePath) {
      this.updateContextKey(this.isDevMode);
      return;
    }

    const result = this.getEffectiveSessions(workspacePath);
    if (!result) {
      this.updateContextKey(this.isDevMode);
      return;
    }

    const currentIdSet = new Set(result.sessionIds);
    const changed = currentIdSet.size !== this._currentSessionIds.size
      || [...currentIdSet].some(id => !this._currentSessionIds.has(id));

    if (changed) {
      this._currentSessionIds = currentIdSet;
      this._tasks.clear();
      this._descriptions.clear();
      for (const sid of result.sessionIds) {
        const descs = findAgentDescriptions(workspacePath, sid);
        for (const [k, v] of descs) this._descriptions.set(k, v);
      }
    }

    let hasFiles = false;
    for (const sid of result.sessionIds) {
      const tasksDir = getTasksDir(workspacePath, sid);
      if (!this._watchers.has(sid) && fs.existsSync(tasksDir)) {
        try {
          this._watchers.set(sid, fs.watch(tasksDir, () => this.refresh()));
        } catch {}
      }
      if (fs.existsSync(tasksDir) && listAgentFiles(tasksDir).length > 0) {
        hasFiles = true;
      }
    }

    this.updateContextKey(this.isDevMode || hasFiles);
    this.refresh();
  }

  private buildPanelInfo(): PanelInfo {
    const workspace = this.getEffectiveWorkspacePath();
    const sessions = [...this._currentSessionIds].map(id => {
      if (!this._displayNameCache.has(id) && workspace) {
        this._displayNameCache.set(id, getSessionDisplayName(workspace, id));
      }
      return { id, displayName: this._displayNameCache.get(id) ?? id.slice(0, 8) };
    });

    // Build session names map for all sessions that have tasks
    const sessionNames = new Map<string, string>();
    for (const [, task] of this._tasks) {
      if (task.sessionId && !sessionNames.has(task.sessionId)) {
        if (!this._displayNameCache.has(task.sessionId) && workspace) {
          this._displayNameCache.set(task.sessionId, getSessionDisplayName(workspace, task.sessionId));
        }
        sessionNames.set(task.sessionId, this._displayNameCache.get(task.sessionId) ?? task.sessionId.slice(0, 8));
      }
    }

    return {
      workspace,
      sessions,
      sessionNames,
      isOverride: !!(this._overrideWorkspace || this._selectedSessionIds.size > 0),
      isDevMode: this.isDevMode,
    };
  }

  private updateContextKey(hasAgents: boolean) {
    if (hasAgents === this._lastIconState) return;
    this._lastIconState = hasAgents;
    vscode.commands.executeCommand('setContext', 'claudeUsageBar.hasBackgroundAgents', hasAgents);
  }

  refresh() {
    if ((!this._view && !this._editorPanel) || this._disposed) return;

    const workspacePath = this.getEffectiveWorkspacePath();
    if (!workspacePath) {
      this.renderEmpty();
      return;
    }

    const result = this.getEffectiveSessions(workspacePath);
    if (!result) {
      this.renderEmpty();
      return;
    }

    const currentIdSet = new Set(result.sessionIds);
    const sessionChanged = currentIdSet.size !== this._currentSessionIds.size
      || [...currentIdSet].some(id => !this._currentSessionIds.has(id));
    if (sessionChanged) {
      this._currentSessionIds = currentIdSet;
      this._tasks.clear();
      this._descriptions.clear();
      for (const sid of result.sessionIds) {
        const descs = findAgentDescriptions(workspacePath, sid);
        for (const [k, v] of descs) this._descriptions.set(k, v);
      }
    }

    let allFiles: string[] = [];
    for (const sid of result.sessionIds) {
      const tasksDir = getTasksDir(workspacePath, sid);
      allFiles = allFiles.concat(listAgentFiles(tasksDir));
    }

    if (allFiles.length === 0 && this._tasks.size === 0) {
      this.renderEmpty();
      return;
    }

    let changed = false;
    const currentIds = new Set<string>();

    for (const file of allFiles) {
      const agentId = file.split('/').pop()!.replace('.output', '');
      currentIds.add(agentId);
      const existing = this._tasks.get(agentId);

      try {
        const stat = fs.statSync(file);
        if (existing && existing._readOffset >= stat.size && existing.status !== 'running') {
          continue;
        }
      } catch {
        continue;
      }

      const updated = parseAgentFile(file, existing);
      this._tasks.set(agentId, updated);
      changed = true;
    }

    for (const [id, task] of this._tasks) {
      if (task.status !== 'running') continue;
      if (!currentIds.has(id)) {
        task.status = 'completed';
        changed = true;
        continue;
      }
      if (task._lastMtime > 0 && (Date.now() - task._lastMtime) > 30_000 && task.contentBlocks.length > 0) {
        task.status = 'completed';
        changed = true;
      }
    }

    if (changed || !this._initialized.has('sidebar') || !this._initialized.has('editor')) {
      this.render();
    }
  }

  private _initialized = new Set<'sidebar' | 'editor'>();

  private getSortedSerializedTasks(): SerializedTask[] {
    const workspace = this.getEffectiveWorkspacePath();
    const sessionNames = new Map<string, string>();
    for (const [, task] of this._tasks) {
      if (task.sessionId && !sessionNames.has(task.sessionId)) {
        if (!this._displayNameCache.has(task.sessionId) && workspace) {
          this._displayNameCache.set(task.sessionId, getSessionDisplayName(workspace, task.sessionId));
        }
        sessionNames.set(task.sessionId, this._displayNameCache.get(task.sessionId) ?? task.sessionId.slice(0, 8));
      }
    }

    return Array.from(this._tasks.values())
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        if (a.status === 'running') {
          return (a.startedAt || '').localeCompare(b.startedAt || '');
        }
        return (b.lastActivity || '').localeCompare(a.lastActivity || '');
      })
      .map(t => serializeTask(t, this._descriptions.get(t.agentId), sessionNames.get(t.sessionId)));
  }

  private render() {
    if (!this._view && !this._editorPanel) return;

    const serialized = this.getSortedSerializedTasks();

    // Sidebar
    if (this._view) {
      if (!this._initialized.has('sidebar')) {
        const panelInfo = this.buildPanelInfo();
        this._view.webview.html = getAgentPanelHtml(serialized, panelInfo);
        this._initialized.add('sidebar');
      } else {
        this._view.webview.postMessage({ command: 'updateTasks', tasks: serialized });
      }
    }

    // Editor panel
    if (this._editorPanel) {
      if (!this._initialized.has('editor')) {
        const panelInfo = this.buildPanelInfo();
        this._editorPanel.webview.html = getAgentPanelHtml(serialized, panelInfo);
        this._initialized.add('editor');
      } else {
        this._editorPanel.webview.postMessage({ command: 'updateTasks', tasks: serialized });
      }
    }
  }

  private renderEmpty() {
    const panelInfo = this.buildPanelInfo();
    const html = getAgentPanelHtml([], panelInfo);
    if (this._view) { this._view.webview.html = html; this._initialized.delete('sidebar'); }
    if (this._editorPanel) { this._editorPanel.webview.html = html; this._initialized.delete('editor'); }
  }

  openInEditor() {
    if (this._editorPanel) {
      this._editorPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeUsageBar.agentEditor',
      'Background Agents',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agents-icon-light.svg'),
      dark: vscode.Uri.joinPath(this._context.extensionUri, 'media', 'agents-icon.svg'),
    };

    this._editorPanel = panel;
    this._initialized.delete('editor');

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'selectWorkspace') this.handleSelectWorkspace();
      else if (msg.command === 'selectSession') this.handleSelectSession();
      else if (msg.command === 'clearOverrides') this.handleClearOverrides();
      else if (msg.command === 'copyToClipboard') {
        vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage('Copied to clipboard');
      }
    });

    panel.onDidDispose(() => {
      this._editorPanel = undefined;
      this._initialized.delete('editor');
    });

    // Render immediately with current state
    this.render();
  }

  getDebugInfo(): { workspace?: string; sessionIds?: string[] } {
    return {
      workspace: this.getEffectiveWorkspacePath(),
      sessionIds: [...this._currentSessionIds],
    };
  }

  dispose() {
    this._disposed = true;
    this.stopWatching();
    this._editorPanel?.dispose();
  }
}

function getLatestMtime(dir: string): number {
  try {
    const files = fs.readdirSync(dir);
    let max = 0;
    for (const f of files) {
      try {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        if (mt > max) max = mt;
      } catch {}
    }
    return max;
  } catch {
    return 0;
  }
}
