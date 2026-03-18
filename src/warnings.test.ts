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
  describe('session warnings (>=60%, >=1h to reset)', () => {
    it('warns at 60% with 2h left (info level)', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 65, fiveHourResetsIn: 2 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
      expect(result[0].message).toContain('elevated');
      expect(result[0].message).toContain('65%');
    });

    it('warns at 75% as warning level', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 80, fiveHourResetsIn: 2 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warning');
      expect(result[0].message).toContain('high');
    });

    it('warns at 90%+ as critically high', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 95, fiveHourResetsIn: 2 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('critically high');
    });

    it('does not warn below 60%', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 55, fiveHourResetsIn: 3 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not warn when less than 1h to reset', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 30 * 60_000 });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('fires at exactly 60% with exactly 1h', () => {
      const { usage, now } = makeUsage({ fiveHourPct: 60, fiveHourResetsIn: HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
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

    it('re-fires after cooldown expires (30 min)', () => {
      const now = Date.now();
      const { usage } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR }, now);
      const warned = freshWarningState();

      const first = evaluateWarnings(usage, warned, now);
      expect(first).toHaveLength(1);

      // Need to recreate usage with adjusted reset time for the later "now"
      const laterNow = now + WARNING_COOLDOWN_MS;
      const { usage: usage2 } = makeUsage({ fiveHourPct: 85, fiveHourResetsIn: 2 * HOUR }, laterNow);
      const second = evaluateWarnings(usage2, warned, laterNow);
      expect(second).toHaveLength(1);
    });

    it('re-fires weekly warning after cooldown', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 60, weeklyResetsIn: 3 * DAY }, now);
      const warned = freshWarningState();

      const first = evaluateWarnings(usage, warned, now);
      expect(first).toHaveLength(1);

      const laterNow = now + WARNING_COOLDOWN_MS;
      const { usage: usage2 } = makeUsage({ weeklyPct: 60, weeklyResetsIn: 3 * DAY }, laterNow);
      const second = evaluateWarnings(usage2, warned, laterNow);
      expect(second).toHaveLength(1);
    });

    it('re-fires underuse warning after cooldown', () => {
      const now = Date.now();
      const { usage } = makeUsage({ weeklyPct: 25, weeklyResetsIn: DAY }, now);
      const warned = freshWarningState();

      const first = evaluateWarnings(usage, warned, now);
      // weeklyHot (50%+) won't fire since 25% < 50%, but underuse will
      expect(first).toHaveLength(1);
      expect(first[0].message).toContain('Use it or lose it');

      const laterNow = now + WARNING_COOLDOWN_MS;
      const { usage: usage2 } = makeUsage({ weeklyPct: 25, weeklyResetsIn: DAY }, laterNow);
      const second = evaluateWarnings(usage2, warned, laterNow);
      expect(second).toHaveLength(1);
    });
  });

  describe('weekly hot (>=50%, >=24h to reset)', () => {
    it('warns at 50% with 3 days left (info level)', () => {
      const { usage, now } = makeUsage({ weeklyPct: 55, weeklyResetsIn: 3 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
      expect(result[0].message).toContain('elevated');
    });

    it('warns at 75% as warning level', () => {
      const { usage, now } = makeUsage({ weeklyPct: 82, weeklyResetsIn: 3 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('warning');
      expect(result[0].message).toContain('high');
    });

    it('warns at 90%+ as critically high', () => {
      const { usage, now } = makeUsage({ weeklyPct: 95, weeklyResetsIn: 3 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('critically high');
    });

    it('does not warn below 50%', () => {
      const { usage, now } = makeUsage({ weeklyPct: 45, weeklyResetsIn: 5 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });

    it('does not warn when less than 24h to reset', () => {
      const { usage, now } = makeUsage({ weeklyPct: 90, weeklyResetsIn: 12 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('weekly underuse (<80%, <3 days to reset)', () => {
    it('shows info when weekly at 25% with 29h left', () => {
      const { usage, now } = makeUsage({ weeklyPct: 25, weeklyResetsIn: 29 * HOUR });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('info');
      expect(result[0].message).toContain('75% capacity');
      expect(result[0].message).toContain('Use it or lose it');
    });

    it('shows info when weekly at 40% with 1 day left', () => {
      const { usage, now } = makeUsage({ weeklyPct: 40, weeklyResetsIn: DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('60% capacity');
    });

    it('shows underuse when weekly at 75% with 2 days left (also fires hot)', () => {
      const { usage, now } = makeUsage({ weeklyPct: 75, weeklyResetsIn: 2 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      // hot (75% >= 50%, 2d >= 24h) + underuse (75% < 80%, 2d < 3d)
      expect(result).toHaveLength(2);
      const underuse = result.find(w => w.message.includes('Use it or lose it'));
      expect(underuse).toBeDefined();
      expect(underuse!.message).toContain('25% capacity');
    });

    it('does not fire when weekly at 80% (threshold is <80%)', () => {
      const { usage, now } = makeUsage({ weeklyPct: 80, weeklyResetsIn: 2 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      // 80% >= 50% with >= 24h fires the hot warning, not underuse
      const underuse = result.filter(w => w.message.includes('Use it or lose it'));
      expect(underuse).toHaveLength(0);
    });

    it('does not fire when 4 days left (>3 day window)', () => {
      const { usage, now } = makeUsage({ weeklyPct: 40, weeklyResetsIn: 4 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(0);
    });
  });

  describe('combined scenarios', () => {
    it('can fire session and weekly simultaneously', () => {
      const { usage, now } = makeUsage({
        fiveHourPct: 90,
        fiveHourResetsIn: 2 * HOUR,
        weeklyPct: 85,
        weeklyResetsIn: 3 * DAY,
      });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      expect(result).toHaveLength(2);
    });

    it('can fire weekly hot AND underuse when 50-79% with <3d but >=24h', () => {
      const { usage, now } = makeUsage({ weeklyPct: 55, weeklyResetsIn: 2 * DAY });
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned, now);
      // hot (55% >= 50%, 2d >= 24h) + underuse (55% < 80%, 2d < 3d)
      expect(result).toHaveLength(2);
    });

    it('returns empty when no data is present', () => {
      const usage: UsageData = { fiveHour: null, sevenDay: null, sevenDaySonnet: null, extraUsage: null };
      const warned = freshWarningState();
      const result = evaluateWarnings(usage, warned);
      expect(result).toHaveLength(0);
    });
  });
});
