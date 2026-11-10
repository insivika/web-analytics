// Spend sync jobs (server only). Each run is recorded in ad_sync_run so the ROI
// page can show the last successful sync and the last error per source.

import { formatInTimeZone } from 'date-fns-tz';
import {
  finishSyncRun,
  getFxRates,
  replaceAdSpend,
  saveFxRates,
  startSyncRun,
} from '@/queries/prisma/adSpend';
import { addDays, buildFxLookup, fetchFrankfurterRates, toUsd } from './fx';
import {
  type AdSpendRow,
  fetchMetaInsights,
  META_DEFAULT_API_VERSION,
  parseAccountIds,
} from './meta';

export const REPORTING_TIMEZONE = 'America/Chicago';
export const META_DAILY_LOOKBACK_DAYS = 7;
export const MAX_BACKFILL_DAYS = 180;

export const todayInReportingTz = (now = new Date()) =>
  formatInTimeZone(now, REPORTING_TIMEZONE, 'yyyy-MM-dd');

/** [today - days + 1, today] in the reporting time zone. */
export function getSyncRange(days: number, now = new Date()) {
  const until = todayInReportingTz(now);
  const n = Math.min(Math.max(Math.round(days), 1), MAX_BACKFILL_DAYS);
  return { since: addDays(until, -(n - 1)), until };
}

/** The Umami website that ad spend belongs to (Cash Flow Calendar). */
export function getAdsWebsiteId() {
  return process.env.ADS_WEBSITE_ID || '19a70b61-1c6c-449c-8b83-197db764884f';
}

/** Fetches missing FX rates for the range, then returns a lookup over stored rates. */
export async function ensureFxRates(currencies: string[], start: string, end: string) {
  const needed = [...new Set(currencies.map(c => c.toUpperCase()))].filter(c => c !== 'USD');
  if (needed.length) {
    try {
      await saveFxRates(await fetchFrankfurterRates(start, end, needed));
    } catch {
      // Fall back to whatever is stored (including manual rates); gaps are reported.
    }
  }
  return buildFxLookup(await getFxRates(needed, addDays(start, -7), end));
}

/** Adds spend_usd to each row; rows without an FX rate keep spendUsd = null. */
export async function convertSpend(rows: AdSpendRow[], start: string, end: string) {
  const fx = await ensureFxRates(
    rows.map(r => r.currency),
    start,
    end,
  );
  return rows.map(row => ({ ...row, spendUsd: toUsd(row.spend, row.currency, row.date, fx) }));
}

export interface SyncResult {
  source: string;
  status: 'success' | 'error';
  rows: number;
  rangeStart: string;
  rangeEnd: string;
  message?: string;
}

/** Syncs Meta ad-level spend for the last `days` days for every configured account. */
export async function syncMetaSpend(
  websiteId: string,
  days = META_DAILY_LOOKBACK_DAYS,
): Promise<SyncResult> {
  const { since, until } = getSyncRange(days);
  const run = await startSyncRun(websiteId, 'meta', since, until);
  const token = process.env.META_ACCESS_TOKEN;
  const accounts = parseAccountIds(process.env.META_AD_ACCOUNT_IDS);

  try {
    if (!token || !accounts.length) {
      throw new Error('Meta is not configured: set META_ACCESS_TOKEN and META_AD_ACCOUNT_IDS.');
    }

    let total = 0;
    for (const accountId of accounts) {
      const rows = await fetchMetaInsights({
        accountId,
        token,
        since,
        until,
        version: process.env.META_API_VERSION || META_DEFAULT_API_VERSION,
      });
      const converted = await convertSpend(rows, since, until);
      total += await replaceAdSpend(websiteId, 'meta', accountId, since, until, converted);
    }

    await finishSyncRun(run.id, { status: 'success', rows: total });
    return { source: 'meta', status: 'success', rows: total, rangeStart: since, rangeEnd: until };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    await finishSyncRun(run.id, { status: 'error', message });
    return {
      source: 'meta',
      status: 'error',
      rows: 0,
      rangeStart: since,
      rangeEnd: until,
      message,
    };
  }
}

/** Stores rows posted by the Google Ads Script, replacing the posted date range. */
export async function saveGoogleSpend(
  websiteId: string,
  accountId: string,
  rangeStart: string,
  rangeEnd: string,
  rows: AdSpendRow[],
): Promise<SyncResult> {
  const run = await startSyncRun(websiteId, 'google', rangeStart, rangeEnd);
  try {
    const converted = await convertSpend(rows, rangeStart, rangeEnd);
    const count = await replaceAdSpend(
      websiteId,
      'google',
      accountId,
      rangeStart,
      rangeEnd,
      converted,
    );
    await finishSyncRun(run.id, { status: 'success', rows: count });
    return { source: 'google', status: 'success', rows: count, rangeStart, rangeEnd };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    await finishSyncRun(run.id, { status: 'error', message });
    return { source: 'google', status: 'error', rows: 0, rangeStart, rangeEnd, message };
  }
}

/** Refreshes FX rates for revenue currencies over the last `days` days. */
export async function syncFxRates(
  websiteId: string,
  currencies: string[],
  days = 7,
): Promise<SyncResult> {
  const { since, until } = getSyncRange(days);
  const run = await startSyncRun(websiteId, 'fx', since, until);
  try {
    const rows = await fetchFrankfurterRates(since, until, currencies);
    const count = await saveFxRates(rows);
    await finishSyncRun(run.id, { status: 'success', rows: count });
    return { source: 'fx', status: 'success', rows: count, rangeStart: since, rangeEnd: until };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    await finishSyncRun(run.id, { status: 'error', message });
    return { source: 'fx', status: 'error', rows: 0, rangeStart: since, rangeEnd: until, message };
  }
}
