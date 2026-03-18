import { UsageData } from './rateLimits';

export type WarningLevel = 'warning' | 'info';

export interface Warning {
  level: WarningLevel;
  message: string;
}

export interface WarningState {
  sessionHotAt: number;
  weeklyHotAt: number;
  weeklyUnderuseAt: number;
}

/** Cooldown between re-firing the same warning (30 minutes) */
export const WARNING_COOLDOWN_MS = 30 * 60_000;

export function freshWarningState(): WarningState {
  return { sessionHotAt: 0, weeklyHotAt: 0, weeklyUnderuseAt: 0 };
}

/**
 * Evaluates usage against thresholds. Returns warnings that should be shown.
 * Warnings re-fire after a cooldown period instead of being one-shot.
 *
 * Thresholds:
 * - Session: >= 60% with >= 1h until reset
 * - Weekly:  >= 50% with >= 24h until reset
 * - Underuse: < 80% with < 3 days until reset ("use it or lose it")
 */
export function evaluateWarnings(
  usage: UsageData,
  warned: WarningState,
  now: number = Date.now(),
): Warning[] {
  const warnings: Warning[] = [];

  // Session >= 60% with >= 1h until reset
  if (usage.fiveHour) {
    const msLeft = usage.fiveHour.resetsAt.getTime() - now;
    const hot = usage.fiveHour.utilization >= 60 && msLeft >= 3_600_000;
    if (hot && now - warned.sessionHotAt >= WARNING_COOLDOWN_MS) {
      warned.sessionHotAt = now;
      const pct = Math.round(usage.fiveHour.utilization);
      const h = Math.floor(msLeft / 3_600_000);
      const m = Math.round((msLeft % 3_600_000) / 60_000);
      const severity = pct >= 90 ? 'critically high' : pct >= 75 ? 'high' : 'elevated';
      warnings.push({
        level: pct >= 75 ? 'warning' : 'info',
        message: `Claude session ${severity} at ${pct}% with ${h}h ${m}m until reset — consider pacing your usage.`,
      });
    }
  }

  // Weekly >= 50% with >= 24h until reset
  const weekly = usage.sevenDay;
  if (weekly) {
    const msLeft = weekly.resetsAt.getTime() - now;
    const hot = weekly.utilization >= 50 && msLeft >= 86_400_000;
    if (hot && now - warned.weeklyHotAt >= WARNING_COOLDOWN_MS) {
      warned.weeklyHotAt = now;
      const pct = Math.round(weekly.utilization);
      const days = Math.floor(msLeft / 86_400_000);
      const hrs = Math.round((msLeft % 86_400_000) / 3_600_000);
      const severity = pct >= 90 ? 'critically high' : pct >= 75 ? 'high' : 'elevated';
      warnings.push({
        level: pct >= 75 ? 'warning' : 'info',
        message: `Claude weekly usage ${severity} at ${pct}% with ${days}d ${hrs}h until reset — you may run out before it resets.`,
      });
    }

    // Weekly < 80% with < 3 days until reset (use it or lose it)
    const underuse = weekly.utilization < 80 && msLeft > 0 && msLeft < 3 * 86_400_000;
    if (underuse && now - warned.weeklyUnderuseAt >= WARNING_COOLDOWN_MS) {
      warned.weeklyUnderuseAt = now;
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
