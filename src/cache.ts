import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageData } from './rateLimits';

export interface CacheEntry {
  usage: UsageData | null;
  error: string | null;
  backoffUntil: number; // epoch ms, 0 = no backoff
  fetchedAt: number;    // epoch ms
}

const CACHE_PATH = path.join(os.homedir(), '.claude', 'claude-usage-bar-cache.json');

/** All VS Code windows share this TTL — only one window fetches per interval */
export const CACHE_TTL_MS = 90_000;

export function readSharedCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const c = JSON.parse(raw) as CacheEntry;
    // Rehydrate Date objects (JSON serialises them as ISO strings)
    if (c.usage?.fiveHour)
      (c.usage.fiveHour as any).resetsAt = new Date(c.usage.fiveHour.resetsAt);
    if (c.usage?.sevenDay)
      (c.usage.sevenDay as any).resetsAt = new Date(c.usage.sevenDay.resetsAt);
    if (c.usage?.sevenDaySonnet)
      (c.usage.sevenDaySonnet as any).resetsAt = new Date(c.usage.sevenDaySonnet.resetsAt);
    return c;
  } catch {
    return null;
  }
}

export function writeSharedCache(entry: CacheEntry): void {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entry), 'utf-8');
  } catch {
    // ~/.claude might not exist on first run — silently ignore
  }
}
