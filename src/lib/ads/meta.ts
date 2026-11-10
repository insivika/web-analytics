// Meta Marketing API Insights client (ad level, daily). Read-only: needs a
// system-user token with ads_read. Never logs the token.

export const META_DEFAULT_API_VERSION = 'v27.0';

/** Graph error codes that mean "slow down and retry". */
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004]);

export interface AdSpendRow {
  date: string; // yyyy-MM-dd, in the ad account's time zone
  channel: 'meta' | 'google';
  accountId: string;
  campaignId: string;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  adId: string;
  adName: string | null;
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public kind: 'token' | 'throttle' | 'permission' | 'request',
    public code?: number,
    public subcode?: number,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/** Normalizes "1234" or "act_1234" to "act_1234". */
export const toActId = (id: string) => (id.startsWith('act_') ? id : `act_${id.trim()}`);

export function parseAccountIds(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(toActId),
    ),
  ];
}

/** Maps one Insights row (level=ad, time_increment=1) to an ad_spend row. */
export function mapMetaInsight(row: any, accountId: string): AdSpendRow {
  return {
    date: String(row.date_start),
    channel: 'meta',
    accountId,
    campaignId: String(row.campaign_id ?? ''),
    campaignName: row.campaign_name ?? null,
    adsetId: row.adset_id ? String(row.adset_id) : null,
    adsetName: row.adset_name ?? null,
    adId: String(row.ad_id ?? ''),
    adName: row.ad_name ?? null,
    spend: Number(row.spend ?? 0) || 0,
    currency: String(row.account_currency ?? 'USD').toUpperCase(),
    impressions: Number.parseInt(row.impressions ?? '0', 10) || 0,
    clicks: Number.parseInt(row.clicks ?? '0', 10) || 0,
  };
}

/** Turns a Graph API error body into a MetaApiError with a readable message. */
export function toMetaError(body: any, status: number): MetaApiError {
  const err = body?.error ?? {};
  const code = Number(err.code) || undefined;
  const subcode = Number(err.error_subcode) || undefined;
  const text = err.message || `HTTP ${status}`;

  if (code === 190 || code === 102) {
    return new MetaApiError(
      `Meta access token is invalid or expired (code ${code}${subcode ? `/${subcode}` : ''}). Generate a new system-user token and update META_ACCESS_TOKEN.`,
      'token',
      code,
      subcode,
    );
  }
  if (code && THROTTLE_CODES.has(code)) {
    return new MetaApiError(
      `Meta rate limit reached (code ${code}): ${text}`,
      'throttle',
      code,
      subcode,
    );
  }
  if (code === 10 || code === 200 || code === 294 || status === 403) {
    return new MetaApiError(
      `Meta permission error (code ${code}): ${text}. Check that the system user has the ad account assigned and the token has ads_read.`,
      'permission',
      code,
      subcode,
    );
  }
  return new MetaApiError(
    `Meta API error (code ${code ?? status}): ${text}`,
    'request',
    code,
    subcode,
  );
}

export interface FetchInsightsOptions {
  accountId: string; // act_...
  token: string;
  since: string; // yyyy-MM-dd
  until: string;
  version?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const FIELDS = [
  'date_start',
  'account_currency',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'impressions',
  'clicks',
].join(',');

/**
 * Fetches daily ad-level spend for [since, until], following pagination and
 * backing off on rate-limit errors. Throws MetaApiError on token/permission errors.
 */
export async function fetchMetaInsights({
  accountId,
  token,
  since,
  until,
  version = META_DEFAULT_API_VERSION,
  fetchImpl = fetch,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  maxRetries = 4,
}: FetchInsightsOptions): Promise<AdSpendRow[]> {
  const params = new URLSearchParams({
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: FIELDS,
    limit: '500',
  });
  let url: string | null = `https://graph.facebook.com/${version}/${accountId}/insights?${params}`;
  const rows: AdSpendRow[] = [];

  while (url) {
    let attempt = 0;
    let body: any;

    for (;;) {
      // The token goes in a header, so it never appears in URLs or logs.
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      body = await res.json().catch(() => ({}));

      if (res.ok && !body?.error) break;

      const error = toMetaError(body, res.status);
      if (error.kind === 'throttle' && attempt < maxRetries) {
        attempt += 1;
        await sleep(Math.min(60_000, 5_000 * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }

    for (const row of body?.data ?? []) {
      rows.push(mapMetaInsight(row, accountId));
    }

    url = body?.paging?.next ?? null;
  }

  return rows;
}
