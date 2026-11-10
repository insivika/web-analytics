// RevenueCat revenue, read-only (API v2). RevenueCat has no project-wide
// transaction list, so revenue is read per customer: each subscription's
// cumulative total_revenue_in_usd and each one-time purchase's revenue_in_usd
// (gross, store commission, tax, proceeds). Customer id = app_user_id = Firebase uid.

import type { RevenueRow } from './stripe';

export const REVENUECAT_API = 'https://api.revenuecat.com/v2';

export class RevenueCatApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'RevenueCatApiError';
  }
}

const usd = (v: any) => {
  const gross = Number(v?.gross ?? 0) || 0;
  const commission = Number(v?.commission ?? 0) || 0;
  const tax = Number(v?.tax ?? 0) || 0;
  const proceeds = Number(v?.proceeds ?? gross - commission - tax) || 0;
  return { gross, fee: Math.round((commission + tax) * 10000) / 10000, net: proceeds };
};

export function mapRcSubscription(sub: any, customerId: string): RevenueRow | null {
  if (!sub?.id || sub.environment === 'sandbox') return null;
  const { gross, fee, net } = usd(sub.total_revenue_in_usd);
  if (gross <= 0) return null; // trial or free period only
  return {
    source: 'revenuecat',
    externalId: `sub:${sub.id}`,
    kind: 'subscription',
    userRef: customerId,
    customerRef: customerId,
    // Subscriptions start at the store trial; revenue follows after it.
    occurredAt: new Date(Number(sub.starts_at)),
    currency: 'USD',
    amount: gross,
    grossUsd: gross,
    feeUsd: fee,
    netUsd: net,
    product: sub.product_id ?? null,
    refunded: false,
  };
}

export function mapRcPurchase(purchase: any, customerId: string): RevenueRow | null {
  if (!purchase?.id || purchase.environment === 'sandbox') return null;
  const { gross, fee, net } = usd(purchase.revenue_in_usd);
  const refunded = purchase.status === 'refunded';
  if (gross <= 0) return null;
  return {
    source: 'revenuecat',
    externalId: `purchase:${purchase.id}`,
    kind: 'payment',
    userRef: customerId,
    customerRef: customerId,
    occurredAt: new Date(Number(purchase.purchased_at)),
    currency: 'USD',
    amount: gross,
    grossUsd: gross,
    feeUsd: refunded ? gross : fee,
    netUsd: refunded ? 0 : net,
    product: purchase.product_id ?? null,
    refunded,
  };
}

interface RcOptions {
  key: string;
  projectId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

async function rcGet(
  path: string,
  { key, fetchImpl = fetch, sleep }: RcOptions,
  attempt = 0,
): Promise<any> {
  const res = await fetchImpl(`${REVENUECAT_API}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });

  if (res.status === 404) return null; // no such customer (never opened the app)
  if (res.status === 429 && attempt < 4) {
    const body: any = await res.json().catch(() => ({}));
    const wait = Number(body?.backoff_ms) || Number(res.headers.get('retry-after')) * 1000 || 2000;
    await (sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(Math.min(wait, 30_000));
    return rcGet(path, { key, fetchImpl, sleep, projectId: '' }, attempt + 1);
  }

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RevenueCatApiError(
      res.status === 401 || res.status === 403
        ? `RevenueCat key rejected (${res.status}): ${body?.message ?? ''}. Check REVENUECAT_API_KEY (v2, read scopes) and REVENUECAT_PROJECT_ID.`
        : `RevenueCat API error (${res.status}): ${body?.message ?? ''}`,
      res.status,
    );
  }
  return body;
}

async function listAll(path: string, opts: RcOptions) {
  const items: any[] = [];
  let next: string | null =
    `${path}${path.includes('?') ? '&' : '?'}limit=100&environment=production`;
  for (let page = 0; next && page < 20; page++) {
    const body = await rcGet(next, opts);
    if (!body) break;
    items.push(...(body.items ?? []));
    // next_page is a full path like /v2/projects/.../subscriptions?starting_after=...
    next = body.next_page ? String(body.next_page).replace(/^\/v2/, '') : null;
  }
  return items;
}

/** One customer's paid subscriptions and purchases as revenue rows. */
export async function fetchRcCustomerRevenue(
  customerId: string,
  opts: RcOptions,
): Promise<RevenueRow[]> {
  const base = `/projects/${encodeURIComponent(opts.projectId)}/customers/${encodeURIComponent(customerId)}`;
  const [subs, purchases] = await Promise.all([
    listAll(`${base}/subscriptions`, opts),
    listAll(`${base}/purchases`, opts),
  ]);
  return [
    ...subs.map(s => mapRcSubscription(s, customerId)),
    ...purchases.map(p => mapRcPurchase(p, customerId)),
  ].filter((r): r is RevenueRow => r !== null);
}

/** Total RevenueCat proceeds (after store commission and tax) for a date range, in USD. */
export async function fetchRcProceeds(
  start: string,
  end: string,
  opts: RcOptions,
): Promise<number | null> {
  const body = await rcGet(
    `/projects/${encodeURIComponent(opts.projectId)}/metrics/revenue?start_date=${start}&end_date=${end}&currency=USD&revenue_type=proceeds`,
    opts,
  );
  return body && Number.isFinite(Number(body.value)) ? Number(body.value) : null;
}

interface RcChartResponse {
  values?: { cohort: number; measure: number; segment: number; value: number }[];
  segments?: { display_name: string; is_total?: boolean }[];
}

/** Proceeds and transaction counts per month and segment from RevenueCat's revenue chart. */
async function fetchRcRevenueChart(
  start: string,
  end: string,
  segment: 'transaction_type' | 'product_duration',
  opts: RcOptions,
) {
  const params = new URLSearchParams({
    start_date: start,
    end_date: end,
    resolution: '2', // month
    segment,
    currency: 'USD',
    selectors: JSON.stringify({ revenue_type: 'proceeds' }),
  });
  const body: RcChartResponse | null = await rcGet(
    `/projects/${encodeURIComponent(opts.projectId)}/charts/revenue?${params}`,
    opts,
  );
  // month (yyyy-MM, UTC) -> segment name -> { proceeds, transactions }
  const out = new Map<string, Map<string, { proceeds: number; transactions: number }>>();
  const names = (body?.segments ?? []).map(s => (s.is_total ? 'Total' : s.display_name));
  for (const v of body?.values ?? []) {
    const month = new Date(v.cohort * 1000).toISOString().slice(0, 7);
    const name = names[v.segment] ?? String(v.segment);
    if (!out.has(month)) out.set(month, new Map());
    const seg = out.get(month);
    const cell = seg.get(name) ?? { proceeds: 0, transactions: 0 };
    if (v.measure === 0) cell.proceeds = Number(v.value) || 0;
    if (v.measure === 1) cell.transactions = Number(v.value) || 0;
    seg.set(name, cell);
  }
  return out;
}

/**
 * App Store and Google Play money per calendar month: proceeds (after store
 * commission and tax), the part from yearly plans, and new paying subscriptions.
 */
export async function fetchRcMonthly(start: string, end: string, opts: RcOptions) {
  const [byType, byDuration] = await Promise.all([
    fetchRcRevenueChart(start, end, 'transaction_type', opts),
    fetchRcRevenueChart(start, end, 'product_duration', opts),
  ]);
  const months = new Map<string, { proceeds: number; yearly: number; newCustomers: number }>();
  for (const [month, seg] of byType) {
    months.set(month, {
      proceeds: seg.get('Total')?.proceeds ?? 0,
      newCustomers: seg.get('New')?.transactions ?? 0,
      yearly: byDuration.get(month)?.get('P1Y')?.proceeds ?? 0,
    });
  }
  return months;
}
