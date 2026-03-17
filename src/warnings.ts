import { UsageData } from './rateLimits';

export interface WarningState {
  sessionHot: boolean;
  weeklyHot: boolean;
  weeklyUnderuse: boolean;
}

export type WarningLevel = 'warning' | 'info';

export interface Warning {
  level: WarningLevel;
  message: string;
}

export function freshWarningState(): WarningState {
  return { sessionHot: false, weeklyHot: false, weeklyUnderuse: false };
}

/**
 * Pure function: evaluates usage against thresholds, updates warned state,
 * and returns any warnings that should be shown to the user.
 */
export function evaluateWarnings(
  usage: UsageData,
  warned: WarningState,
  now: number = Date.now(),
): Warning[] {
  const warnings: Warning[] = [];

  // Session ≥ 80% with ≥ 1h until reset
  if (usage.fiveHour) {
    const msLeft = usage.fiveHour.resetsAt.getTime() - now;
    const hot = usage.fiveHour.utilization >= 80 && msLeft >= 3_600_000;
    if (hot && !warned.sessionHot) {
      warned.sessionHot = true;
      const pct = Math.round(usage.fiveHour.utilization);
      const h = Math.floor(msLeft / 3_600_000);
      const m = Math.round((msLeft % 3_600_000) / 60_000);
      warnings.push({
        level: 'warning',
        message: `Claude session at ${pct}% with ${h}h ${m}m until reset — consider pacing your usage.`,
      });
    } else if (!hot) {
      warned.sessionHot = false;
    }
  }

  // Weekly ≥ 80% with ≥ 24h until reset
  const weekly = usage.sevenDay;
  if (weekly) {
    const msLeft = weekly.resetsAt.getTime() - now;
    const hot = weekly.utilization >= 80 && msLeft >= 86_400_000;
    if (hot && !warned.weeklyHot) {
      warned.weeklyHot = true;
      const pct = Math.round(weekly.utilization);
      const days = Math.floor(msLeft / 86_400_000);
      const hrs = Math.round((msLeft % 86_400_000) / 3_600_000);
      warnings.push({
        level: 'warning',
        message: `Claude weekly usage at ${pct}% with ${days}d ${hrs}h until reset — you may run out before it resets.`,
      });
    } else if (!hot) {
      warned.weeklyHot = false;
    }

    // Weekly < 60% with < 2 days until reset (use it or lose it)
    const underuse = weekly.utilization < 60 && msLeft > 0 && msLeft < 2 * 86_400_000;
    if (underuse && !warned.weeklyUnderuse) {
      warned.weeklyUnderuse = true;
      const pct = Math.round(weekly.utilization);
      const remaining = 100 - pct;
      const hrs = Math.round(msLeft / 3_600_000);
      warnings.push({
        level: 'info',
        message: `Claude weekly usage at ${pct}% — ${remaining}% capacity resets in ${hrs}h. Use it or lose it!`,
      });
    } else if (!underuse) {
      warned.weeklyUnderuse = false;
    }
  }

  return warnings;
}
