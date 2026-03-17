const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';

export interface UsageBucket {
  /** 0–100 percentage */
  utilization: number;
  resetsAt: Date;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  /** 0–100 percentage */
  utilization: number | null;
}

export interface UsageData {
  /** 5-hour rolling window (shown as "Current session" in Claude UI) */
  fiveHour: UsageBucket | null;
  /** 7-day all-models window */
  sevenDay: UsageBucket | null;
  /** 7-day Sonnet-specific window */
  sevenDaySonnet: UsageBucket | null;
  /** Extra/add-on credits */
  extraUsage: ExtraUsage | null;
}

export async function fetchUsageData(accessToken: string): Promise<UsageData> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': BETA_HEADER,
      'Content-Type': 'application/json',
    },
    // @ts-ignore — Node 18+ AbortSignal.timeout
    signal: AbortSignal.timeout(8_000),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 300)}`);
  }

  return parseUsage(JSON.parse(body) as Record<string, unknown>);
}

function parseBucket(v: unknown): UsageBucket | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (obj['utilization'] == null) return null;
  return {
    utilization: Number(obj['utilization']),
    resetsAt: new Date(String(obj['resets_at'] ?? '')),
  };
}

function parseUsage(raw: Record<string, unknown>): UsageData {
  const extra = raw['extra_usage'] as Record<string, unknown> | null;
  return {
    fiveHour: parseBucket(raw['five_hour']),
    sevenDay: parseBucket(raw['seven_day']),
    sevenDaySonnet: parseBucket(raw['seven_day_sonnet']),
    extraUsage: extra
      ? {
          isEnabled: Boolean(extra['is_enabled']),
          monthlyLimit:
            extra['monthly_limit'] != null ? Number(extra['monthly_limit']) : null,
          usedCredits:
            extra['used_credits'] != null ? Number(extra['used_credits']) : null,
          utilization:
            extra['utilization'] != null ? Number(extra['utilization']) : null,
        }
      : null,
  };
}
