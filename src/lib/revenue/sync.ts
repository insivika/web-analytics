// Revenue sync jobs (server only): Stripe and RevenueCat → revenue_txn, with each
// transaction resolved to a Supabase user_id through the read-only user map.

import { addDays, toDateKey, toUsd } from '@/lib/ads/fx';
import { ensureFxRates, type SyncResult, todayInReportingTz } from '@/lib/ads/sync';
import { finishSyncRun, startSyncRun } from '@/queries/prisma/adSpend';
import { type StoredRevenueRow, saveRevenueTxns } from '@/queries/prisma/revenue';
import { fetchRcCustomerRevenue } from './revenuecat';
import { fetchStripeRevenue, type RevenueRow } from './stripe';
import { loadUserMap, type UserMap } from './userMap';

export const STRIPE_DAILY_LOOKBACK_DAYS = 14;
export const MAX_REVENUE_BACKFILL_DAYS = 730;
/** Customers per RevenueCat request (each costs ~2 API calls; 480/min limit). */
export const RC_CHUNK_SIZE = 80;
const RC_CONCURRENCY = 6;

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
    const rows = await fillUsd(await fetchStripeRevenue(key, sinceUnix));
    const resolved = resolveRows(rows, userMap);
    const count = await saveRevenueTxns(websiteId, resolved);
    return { rows: count, extra: { unmatched: resolved.filter(r => !r.userId).length } as any };
  });
}

/**
 * RevenueCat revenue for a slice of users (Supabase user_ids). RevenueCat has no
 * list-all endpoint, so the caller passes the users to refresh (trial starters)
 * and pages through them with `offset`.
 */
export async function syncRevenueCatRevenue(
  websiteId: string,
  userIds: string[],
  offset = 0,
  map?: UserMap,
) {
  const today = todayInReportingTz();

  return recordRun(websiteId, 'revenuecat', today, today, async () => {
    const key = process.env.REVENUECAT_API_KEY;
    const projectId = process.env.REVENUECAT_PROJECT_ID;
    if (!key || !projectId) {
      throw new Error(
        'RevenueCat is not configured: set REVENUECAT_API_KEY and REVENUECAT_PROJECT_ID.',
      );
    }
    const userMap = map ?? (await loadUserMap());
    const slice = userIds.slice(offset, offset + RC_CHUNK_SIZE);
    const customers = slice
      .map(userId => ({ userId, uid: userMap.firebaseUid(userId) }))
      .filter((c): c is { userId: string; uid: string } => !!c.uid);

    const rows: StoredRevenueRow[] = [];
    for (let i = 0; i < customers.length; i += RC_CONCURRENCY) {
      const batch = customers.slice(i, i + RC_CONCURRENCY);
      const results = await Promise.all(
        batch.map(c => fetchRcCustomerRevenue(c.uid, { key, projectId })),
      );
      results.forEach((list, j) => {
        for (const r of list) rows.push({ ...r, userId: batch[j].userId });
      });
    }

    const count = await saveRevenueTxns(websiteId, rows);
    const nextOffset = offset + slice.length < userIds.length ? offset + slice.length : null;
    return {
      rows: count,
      extra: {
        customers: customers.length,
        noAppAccount: slice.length - customers.length,
        total: userIds.length,
        nextOffset,
      } as any,
    };
  });
}
