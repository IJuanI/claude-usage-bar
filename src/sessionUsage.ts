import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function getRecentSessionStats(): {
  todayMessages: number;
  weekMessages: number;
} {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let todayMessages = 0;
    let weekMessages = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { timestamp?: number };
        const ts = entry.timestamp;
        if (!ts) continue;
        if (ts >= weekAgoMs) weekMessages++;
        if (ts >= startOfToday.getTime()) todayMessages++;
      } catch {
        // skip malformed lines
      }
    }

    return { todayMessages, weekMessages };
  } catch {
    return { todayMessages: 0, weekMessages: 0 };
  }
}
