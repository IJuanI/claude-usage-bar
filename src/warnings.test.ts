import { describe, it, expect } from 'vitest';
import { evaluateWarnings, freshWarningState, WARNING_COOLDOWN_MS } from './warnings';
import { UsageData } from './rateLimits';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function makeUsage(overrides: Partial<{
  fiveHourPct: number;
  fiveHourResetsIn: number;
  weeklyPct: number;
  weeklyResetsIn: number;
}>, now = Date.now()): { usage: UsageData; now: number } {
  return {
    now,
    usage: {
      fiveHour: overrides.fiveHourPct != null
        ? { utilization: overrides.fiveHourPct, resetsAt: new Date(now + (overrides.fiveHourResetsIn ?? 2 * HOUR)) }
        : null,
      sevenDay: overrides.weeklyPct != null
        ? { utilization: overrides.weeklyPct, resetsAt: new Date(now + (overrides.weeklyResetsIn ?? 3 * DAY)) }
        : null,
      sevenDaySonnet: null,
      extraUsage: null,
    },
  };
}

describe('evaluateWarnings', () => {
  describe('session hot (>=80%, >=1h to reset)', () => {
    it('warns when session is at 80% with 2h left', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warning');
      expect(result[0].message).toContain('session at 85%');
    });

    it('does not warn when session is at 80% but less than 1h to reset', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 30 * 60_000 });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not warn when session is below 80%', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 70, fiveHourResetsIn: 3 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('fires at exactly 80% with exactly 1h', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 80, fiveHourResetsIn: HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
    });

    it('does not fire at 79.5% session', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 79.5, fiveHourResetsIn: 2 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('weekly hot (>=80%, >=24h to reset)', () => {
    it('warns when weekly is at 80% with 3 days left', () => {
      const { usage, now } = makeUsage({ weeklyPct: 82, weeklyResetsIn: 3 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warning');
      expect(result[0].message).toContain('weekly usage at 82%');
    });

    it('does not warn when weekly is high but less than 24h to reset', () => {
      const { usage, now } = makeUsage({ weeklyPct: 90, weeklyResetsIn: 12 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not warn when weekly is below 80%', () => {
      const { usage, now } = makeUsage({ weeklyPct: 75, weeklyResetsIn: 5 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('weekly underuse (<60%, <2 days to reset)', () => {
    it('shows info when weekly at 40% with 1 day left', () => {
      const { usage, now } = makeUsage({ weeklyPct: 40, weeklyResetsIn: DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
      expect(result[0].message).toContain('60% capacity');
      expect(result[0].message).toContain('Use it or lose it');
    });

    it('does not show when weekly at 40% but 3 days left', () => {
      const { usage, now } = makeUsage({ weeklyPct: 40, weeklyResetsIn: 3 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not show when weekly at 70% with 1 day left', () => {
      const { usage, now } = makeUsage({ weeklyPct: 70, weeklyResetsIn: DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('fires at exactly 59% with just under 2 days', () => {
      const { usage, now } = makeUsage({ weeklyPct: 59, weeklyResetsIn: 2 * DAY - 1 });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
    });

    it('does not fire at exactly 60%', () => {
      const { usage, now } = makeUsage({ weeklyPct: 60, weeklyResetsIn: DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('cooldown-based re-firing', () => {
    it('does not re-fire within cooldown window', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR }, now);
      const warned = freshWarningState();

      evaluateWarnings(usage, warned, now);
      const second = evaluateWarnings(usage, warned, now + 10 * 60_000); // 10 min later
      expect(second).toHaveLength(0);
    });

    it('re-fires session warning after cooldown expires (30 min)', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR }, now);
      const warned = freshWarningState();

      const first = evaluateWarnings(usage, warned, now);
      expect(first).toHaveLength(1);

      const laterNow = now + WARNING_COOLDOWN_MS;
      const { usage: usage2 } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR }, laterNow);
      const second = evaluateWarnings(usage2, warned, laterNow);
      expect(second).toHaveLength(1);
    });

    it('re-fires weekly warning after cooldown', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 85, weeklyResetsIn: 3 * DAY }, now);
      const warned = freshWarningState();

      const first = evaluateWarnings(usage, warned, now);
      expect(first).toHaveLength(1);

      const laterNow = now + WARNING_COOLDOWN_MS;
      const { usage: usage2 } = makeUsage({ weeklyPct: 85, weeklyResetsIn: 3 * DAY }, laterNow);
      const second = evaluateWarnings(usage2, warned, laterNow);
      expect(second).toHaveLength(1);
    });

    it('re-fires underuse warning after cooldown', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 25, weeklyResetsIn: DAY }, now);
      const warned = freshWarningState();

      const first = evaluateWarnings(usage, warned, now);
      expect(first).toHaveLength(1);
      expect(first[0].message).toContain('Use it or lose it');

      const laterNow = now + WARNING_COOLDOWN_MS;
      const { usage: usage2 } = makeUsage({ weeklyPct: 25, weeklyResetsIn: DAY }, laterNow);
      const second = evaluateWarnings(usage2, warned, laterNow);
      expect(second).toHaveLength(1);
    });
  });

  describe('combined scenarios', () => {
    it('can fire session hot and weekly hot simultaneously', () => {
      const { usage, now } = makeUsage({
        fiveHourPct: 90,
        fiveHourResetsIn: 2 * HOUR,
        weeklyPct: 85,
        weeklyResetsIn: 3 * DAY,
      });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(2);
      expect(result.map(w => w.level)).toEqual(['warning', 'warning']);
    });

    it('returns empty when no data is present', () => {
      const usage: UsageData = { fiveHour: null, sevenDay: null, sevenDaySonnet: null, extraUsage: null };
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned);
      expect(result).toHaveLength(0);
    });
  });
});
