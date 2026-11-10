// Revenue sync jobs (server only): Stripe and RevenueCat → revenue_txn, with each
// transaction resolved to a Supabase user_id through the read-only user map.

import { addDays, toDateKey, toUsd } from '@/lib/ads/fx';
import { ensureFxRates, type SyncResult, todayInReportingTz } from '@/lib/ads/sync';
import { finishSyncRun, startSyncRun } from '@/queries/prisma/adSpend';
import { type StoredRevenueRow, saveRevenueTxns } from '@/queries/prisma/revenue';
import { fetchStripeRevenue, type RevenueRow } from './stripe';
import { loadUserMap, type UserMap } from './userMap';

export const STRIPE_DAILY_LOOKBACK_DAYS = 14;
export const MAX_REVENUE_BACKFILL_DAYS = 730;
/** Disputes stay open for weeks; keep refreshing them this long after they're opened. */
export const DISPUTE_LOOKBACK_DAYS = 120;

/** Fills USD fields for rows Stripe settled in another currency (FX at the transaction date). */
async function fillUsd(rows: RevenueRow[]) {
  const foreign = rows.filter(r => r.grossUsd === null);
  if (!foreign.length) return rows;
  const dates = foreign.map(r => toDateKey(r.occurredAt)).sort();
  const fx = await ensureFxRates(
    foreign.map(r => r.currency),
    dates[0],
    dates[dates.length - 1],
  );
  return rows.map(r => {
    if (r.grossUsd !== null) return r;
    const gross = toUsd(r.amount, r.currency, r.occurredAt, fx);
    return { ...r, grossUsd: gross, feeUsd: null, netUsd: gross };
  });
}

const resolveRows = (rows: RevenueRow[], map: UserMap): StoredRevenueRow[] =>
  rows.map(r => ({ ...r, userId: map.resolve(r.userRef, r.customerRef) }));

async function recordRun<T extends SyncResult>(
  websiteId: string,
  source: string,
  rangeStart: string,
  rangeEnd: string,
  job: () => Promise<{ rows: number; extra?: Partial<T> }>,
): Promise<SyncResult & Record<string, any>> {
  const run = await startSyncRun(websiteId, source, rangeStart, rangeEnd);
  try {
    const { rows, extra } = await job();
    await finishSyncRun(run.id, { status: 'success', rows });
    return { source, status: 'success', rows, rangeStart, rangeEnd, ...extra };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    await finishSyncRun(run.id, { status: 'error', message });
    return { source, status: 'error', rows: 0, rangeStart, rangeEnd, message };
  }
}

/** Stripe charges, refunds and disputes created in the last `days` days. */
export async function syncStripeRevenue(
  websiteId: string,
  days = STRIPE_DAILY_LOOKBACK_DAYS,
  map?: UserMap,
) {
  const n = Math.min(Math.max(Math.round(days), 1), MAX_REVENUE_BACKFILL_DAYS);
  const until = todayInReportingTz();
  const since = addDays(until, -(n - 1));

  return recordRun(websiteId, 'stripe', since, until, async () => {
    const key = process.env.STRIPE_RESTRICTED_KEY;
    if (!key) throw new Error('Stripe is not configured: set STRIPE_RESTRICTED_KEY.');
    const userMap = map ?? (await loadUserMap());
    const sinceUnix = Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) - 86400;
    const disputeSince = Math.floor(Date.now() / 1000) - DISPUTE_LOOKBACK_DAYS * 86400;
    const rows = await fillUsd(await fetchStripeRevenue(key, sinceUnix, fetch, disputeSince));
    const resolved = resolveRows(rows, userMap);
    const count = await saveRevenueTxns(websiteId, resolved);
    return { rows: count, extra: { unmatched: resolved.filter(r => !r.userId).length } as any };
  });
}
