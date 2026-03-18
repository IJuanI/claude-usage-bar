import { UsageData } from './rateLimits';

export type WarningLevel = 'warning' | 'info';

export interface Warning {
  level: WarningLevel;
  message: string;
}

export interface WarningState {
  activatedAt: number;
  sessionHotCount: number;
  weeklyHotCount: number;
  weeklyUnderuseCount: number;
}

/** Schedule: fire at 0h, 1h, 2h from activation — max 3 per type */
const SCHEDULE_MS = [0, 3_600_000, 2 * 3_600_000];
const MAX_FIRES = 3;

export function freshWarningState(now: number = Date.now()): WarningState {
  return { activatedAt: now, sessionHotCount: 0, weeklyHotCount: 0, weeklyUnderuseCount: 0 };
}

function shouldFire(count: number, activatedAt: number, now: number): boolean {
  if (count >= MAX_FIRES) return false;
  const elapsed = now - activatedAt;
  const nextAt = SCHEDULE_MS[count];
  return elapsed >= nextAt;
}

/**
 * Evaluates usage against thresholds. Returns warnings that should be shown.
 * Fires at most 3 times per type: at startup, after 1h, after 2h.
 *
 * Thresholds:
 * - Session: >= 80% with >= 1h until reset
 * - Weekly:  >= 80% with >= 24h until reset
 * - Underuse: < 60% with < 2 days until reset ("use it or lose it")
 */
export function evaluateWarnings(
  usage: UsageData,
  warned: WarningState,
  now: number = Date.now(),
): Warning[] {
  const warnings: Warning[] = [];

  // Session >= 80% with >= 1h until reset
  if (usage.fiveHour) {
    const msLeft = usage.fiveHour.resetsAt.getTime() - now;
    const hot = usage.fiveHour.utilization >= 80 && msLeft >= 3_600_000;
    if (hot && shouldFire(warned.sessionHotCount, warned.activatedAt, now)) {
      warned.sessionHotCount++;
      const pct = Math.round(usage.fiveHour.utilization);
      const h = Math.floor(msLeft / 3_600_000);
      const m = Math.round((msLeft % 3_600_000) / 60_000);
      warnings.push({
        level: 'warning',
        message: `Claude session at ${pct}% with ${h}h ${m}m until reset — consider pacing your usage.`,
      });
    }
  }

  // Weekly >= 80% with >= 24h until reset
  const weekly = usage.sevenDay;
  if (weekly) {
    const msLeft = weekly.resetsAt.getTime() - now;
    const hot = weekly.utilization >= 80 && msLeft >= 86_400_000;
    if (hot && shouldFire(warned.weeklyHotCount, warned.activatedAt, now)) {
      warned.weeklyHotCount++;
      const pct = Math.round(weekly.utilization);
      const days = Math.floor(msLeft / 86_400_000);
      const hrs = Math.round((msLeft % 86_400_000) / 3_600_000);
      warnings.push({
        level: 'warning',
        message: `Claude weekly usage at ${pct}% with ${days}d ${hrs}h until reset — you may run out before it resets.`,
      });
    }

    // Weekly < 60% with < 2 days until reset (use it or lose it)
    const underuse = weekly.utilization < 60 && msLeft > 0 && msLeft < 2 * 86_400_000;
    if (underuse && shouldFire(warned.weeklyUnderuseCount, warned.activatedAt, now)) {
      warned.weeklyUnderuseCount++;
      const pct = Math.round(weekly.utilization);
      const remaining = 100 - pct;
      const hrs = Math.round(msLeft / 3_600_000);
      warnings.push({
        level: 'info',
        message: `Claude weekly usage at ${pct}% — ${remaining}% capacity resets in ${hrs}h. Use it or lose it!`,
      });
    }
  }

  return warnings;
}
