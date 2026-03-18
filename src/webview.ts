import { UsageData } from './rateLimits';

interface Stats {
  todayMessages: number;
  weekMessages: number;
}

export function getWebviewHtml(
  usage: UsageData | null,
  stats: Stats,
  error: string | null,
  updatedAt: Date
): string {
  function formatReset(d: Date): string {
    if (!d || isNaN(d.getTime())) return '';
    const diffMs = d.getTime() - Date.now();
    if (diffMs <= 0) return 'resets soon';
    const h = Math.floor(diffMs / 3_600_000);
    const m = Math.round((diffMs % 3_600_000) / 60_000);
    if (h >= 48) {
      return `resets ${d.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    }
    return `resets in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
  }

  function pctColor(pct: number): string {
    if (pct >= 90) return 'var(--vscode-charts-red, #f44747)';
    if (pct >= 75) return 'var(--vscode-charts-yellow, #d7ba7d)';
    return 'var(--vscode-charts-blue, #4fc1ff)';
  }

  function row(label: string, sublabel: string, pct: number, resetDate: Date | null): string {
    const p = Math.round(pct);
    const color = pctColor(p);
    const resetStr = resetDate ? formatReset(resetDate) : '';
    return `
      <div class="row">
        <div class="row-left">
          <div class="row-label">${esc(label)}</div>
          ${sublabel ? `<div class="row-sub">${esc(sublabel)}</div>` : ''}
          ${resetStr ? `<div class="row-sub">${esc(resetStr)}</div>` : ''}
        </div>
        <div class="row-right">
          <span class="pct" style="color:${color}">${p}%</span>
        </div>
      </div>
      <div class="meter"><div class="meter-fill" style="width:${Math.min(p, 100)}%;background:${color}"></div></div>`;
  }

  const fh  = usage?.fiveHour;
  const sd  = usage?.sevenDay;
  const sds = usage?.sevenDaySonnet;
  const eu  = usage?.extraUsage?.isEnabled ? usage.extraUsage : null;

  const rows = [
    fh  ? row('Current Session', '', fh.utilization, fh.resetsAt) : '',
    sd  ? row('Weekly · All Models', '', sd.utilization, sd.resetsAt) : '',
    sds ? row('Weekly · Sonnet', '', sds.utilization, sds.resetsAt) : '',
    eu  ? row(
      'Extra Credits (Org)',
      eu.usedCredits != null && eu.monthlyLimit != null
        ? `${Math.round(eu.usedCredits).toLocaleString()} / ${eu.monthlyLimit.toLocaleString()} used`
        : '',
      eu.utilization ?? 0,
      null
    ) : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Claude Usage</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 10px 14px 14px;
      user-select: none;
    }

    .section-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
      margin: 10px 0 6px;
    }
    .section-label:first-child { margin-top: 0; }

    /* ── Rate limit rows ── */
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .row-label { font-size: 13px; font-weight: 500; }

    .row-sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 1px;
    }

    .pct {
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
      min-width: 42px;
      text-align: right;
    }

    .meter {
      height: 3px;
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .meter-fill {
      height: 100%;
      border-radius: 2px;
    }

    /* ── Activity ── */
    .stats-row {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }

    .stat {
      flex: 1;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 5px;
    }

    .stat-value { font-size: 18px; font-weight: 700; }
    .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }

    /* ── Footer ── */
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-input-border, rgba(128,128,128,0.15));
    }

    .updated {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    button {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      padding: 3px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: default; }

    /* ── Error ── */
    .error {
      padding: 7px 10px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 5px;
      font-size: 12px;
      margin-bottom: 8px;
    }

    .divider {
      height: 1px;
      background: var(--vscode-input-border, rgba(128,128,128,0.15));
      margin: 10px 0;
    }
  </style>
</head>
<body>

  ${error ? `<div class="error">⚠ ${esc(error)}</div>` : ''}

  ${rows ? `
    <div class="section-label">Rate Limits</div>
    ${rows}
    <div class="divider"></div>
  ` : ''}

  <div class="section-label">Activity</div>
  <div class="stats-row">
    <div class="stat">
      <div class="stat-value">${stats.todayMessages}</div>
      <div class="stat-label">prompts today</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.weekMessages}</div>
      <div class="stat-label">this week</div>
    </div>
  </div>

  <div class="footer">
    <span class="updated">Updated ${updatedAt.toLocaleTimeString()}</span>
    <button id="btn" onclick="doRefresh()">↻ Refresh</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function doRefresh() {
      const btn = document.getElementById('btn');
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      vscode.postMessage({ command: 'refresh' });
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
