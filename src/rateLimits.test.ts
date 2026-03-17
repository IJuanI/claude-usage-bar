import { describe, it, expect } from 'vitest';
import { parseBucket, parseUsage } from './rateLimits';

describe('parseBucket', () => {
  it('parses a valid bucket', () => {
    const result = parseBucket({
      utilization: 42.5,
      resets_at: '2026-03-18T12:00:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.utilization).toBe(42.5);
    expect(result!.resetsAt).toBeInstanceOf(Date);
    expect(result!.resetsAt.toISOString()).toBe('2026-03-18T12:00:00.000Z');
  });

  it('returns null for null input', () => {
    expect(parseBucket(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseBucket('string')).toBeNull();
    expect(parseBucket(42)).toBeNull();
  });

  it('returns null when utilization is missing', () => {
    expect(parseBucket({ resets_at: '2026-03-18T12:00:00Z' })).toBeNull();
  });

  it('handles utilization of 0', () => {
    const result = parseBucket({ utilization: 0, resets_at: '2026-03-18T12:00:00Z' });
    expect(result).not.toBeNull();
    expect(result!.utilization).toBe(0);
  });

  it('returns a Date (possibly invalid) when resets_at is missing', () => {
    const result = parseBucket({ utilization: 50 });
    expect(result).not.toBeNull();
    expect(result!.utilization).toBe(50);
    expect(result!.resetsAt).toBeInstanceOf(Date);
  });
});

describe('parseUsage', () => {
  it('parses a full API response', () => {
    const raw = {
      five_hour: { utilization: 38, resets_at: '2026-03-18T10:00:00Z' },
      seven_day: { utilization: 20, resets_at: '2026-03-20T10:00:00Z' },
      seven_day_sonnet: { utilization: 22, resets_at: '2026-03-20T06:00:00Z' },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 1500,
        utilization: 75,
      },
    };

    const result = parseUsage(raw);

    expect(result.fiveHour).not.toBeNull();
    expect(result.fiveHour!.utilization).toBe(38);
    expect(result.sevenDay!.utilization).toBe(20);
    expect(result.sevenDaySonnet!.utilization).toBe(22);
    expect(result.extraUsage).not.toBeNull();
    expect(result.extraUsage!.isEnabled).toBe(true);
    expect(result.extraUsage!.monthlyLimit).toBe(2000);
    expect(result.extraUsage!.usedCredits).toBe(1500);
    expect(result.extraUsage!.utilization).toBe(75);
  });

  it('handles missing buckets', () => {
    const result = parseUsage({});
    expect(result.fiveHour).toBeNull();
    expect(result.sevenDay).toBeNull();
    expect(result.sevenDaySonnet).toBeNull();
    expect(result.extraUsage).toBeNull();
  });

  it('handles extra_usage with nulls', () => {
    const result = parseUsage({
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
      },
    });
    expect(result.extraUsage).not.toBeNull();
    expect(result.extraUsage!.isEnabled).toBe(false);
    expect(result.extraUsage!.monthlyLimit).toBeNull();
    expect(result.extraUsage!.usedCredits).toBeNull();
    expect(result.extraUsage!.utilization).toBeNull();
  });

  it('handles partial response (only five_hour)', () => {
    const result = parseUsage({
      five_hour: { utilization: 50, resets_at: '2026-03-18T12:00:00Z' },
    });
    expect(result.fiveHour!.utilization).toBe(50);
    expect(result.sevenDay).toBeNull();
    expect(result.sevenDaySonnet).toBeNull();
    expect(result.extraUsage).toBeNull();
  });
});
