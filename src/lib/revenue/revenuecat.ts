// App Store and Google Play revenue from RevenueCat (API v2, read-only), read
// from the revenue chart: proceeds after store commission and tax, per UTC month.

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

  if (res.status === 404) return null;
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

interface RcChartResponse {
  values?: { cohort: number; measure: number; segment: number; value: number }[];
  segments?: { display_name: string; is_total?: boolean }[];
}

/** Proceeds and transaction counts per month and segment from RevenueCat's revenue chart. */
async function fetchRcRevenueChart(
  start: string,
  end: string,
  segment: 'transaction_type' | 'product_duration' | 'store',
  opts: RcOptions,
  revenueType: 'proceeds' | 'revenue' = 'proceeds',
) {
  const params = new URLSearchParams({
    start_date: start,
    end_date: end,
    resolution: '2', // month
    segment,
    currency: 'USD',
    selectors: JSON.stringify({ revenue_type: revenueType }),
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

/** Stores whose money already arrives through Stripe and must not be counted twice. */
const STRIPE_STORES = ['Stripe'];

/**
 * App Store and Google Play money per UTC calendar month: proceeds (after store
 * commission and tax), the part from yearly plans, and new paying subscriptions.
 * Purchases RevenueCat tracks through Stripe are excluded, since Stripe is
 * counted on its own.
 */
export async function fetchRcMonthly(start: string, end: string, opts: RcOptions) {
  const [byType, byDuration, byStore] = await Promise.all([
    fetchRcRevenueChart(start, end, 'transaction_type', opts),
    fetchRcRevenueChart(start, end, 'product_duration', opts),
    fetchRcRevenueChart(start, end, 'store', opts),
  ]);
  const months = new Map<string, { proceeds: number; yearly: number; newCustomers: number }>();
  for (const [month, seg] of byType) {
    const stripe = STRIPE_STORES.reduce(
      (s, name) => s + (byStore.get(month)?.get(name)?.proceeds ?? 0),
      0,
    );
    months.set(month, {
      proceeds: (seg.get('Total')?.proceeds ?? 0) - stripe,
      newCustomers: seg.get('New')?.transactions ?? 0,
      yearly: byDuration.get(month)?.get('P1Y')?.proceeds ?? 0,
    });
  }
  return months;
}

export interface StorePlanPrices {
  /** Average gross price per monthly / yearly transaction (what buyers paid). */
  monthly: number | null;
  yearly: number | null;
  /** Share of gross the business keeps after store commission and tax. */
  keepRate: number | null;
  /** Share of yearly among paid transactions. */
  yearlyShare: number | null;
}

/**
 * App Store and Google Play plan prices, read from RevenueCat's revenue chart:
 * gross revenue per transaction for monthly and yearly plans, and proceeds as a
 * share of gross. Stripe purchases RevenueCat may track are left out.
 */
export async function fetchRcPlanPrices(
  start: string,
  end: string,
  opts: RcOptions,
): Promise<StorePlanPrices> {
  const [gross, proceeds] = await Promise.all([
    fetchRcRevenueChart(start, end, 'product_duration', opts, 'revenue'),
    fetchRcRevenueChart(start, end, 'product_duration', opts, 'proceeds'),
  ]);
  const total = (m: typeof gross, name: string, k: 'proceeds' | 'transactions') =>
    [...m.values()].reduce((s, seg) => s + (seg.get(name)?.[k] ?? 0), 0);
  const perTx = (name: string) => {
    const tx = total(gross, name, 'transactions');
    return tx > 0 ? Math.round((total(gross, name, 'proceeds') / tx) * 100) / 100 : null;
  };
  const g = total(gross, 'P1M', 'proceeds') + total(gross, 'P1Y', 'proceeds');
  const p = total(proceeds, 'P1M', 'proceeds') + total(proceeds, 'P1Y', 'proceeds');
  const txM = total(gross, 'P1M', 'transactions');
  const txY = total(gross, 'P1Y', 'transactions');
  return {
    monthly: perTx('P1M'),
    yearly: perTx('P1Y'),
    keepRate: g > 0 ? Math.round((p / g) * 1000) / 1000 : null,
    yearlyShare: txM + txY > 0 ? txY / (txM + txY) : null,
  };
}
