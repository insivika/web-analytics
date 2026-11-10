import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import { fetchRcMonthly } from '@/lib/revenue/revenuecat';
import {
  type AppStoreMonth,
  buildMonths,
  lastMonths,
  latestSync,
  monthOf,
  monthStart,
  ROI_MONTHS,
  ROI_TIMEZONE,
  staleSources,
} from '@/lib/roi';
import { resolveTrialStarts, type TrialSettings } from '@/lib/trial';
import { getSyncStatus } from '@/queries/prisma/adSpend';
import { getRevenueTxns } from '@/queries/prisma/revenue';
import { getTrialExpiresRows, getTrialStartOccurrences } from './getTrial';

// Marketing ROI by calendar month: ad spend (Meta + Google), website visitors,
// trial starts, new paying customers, money in (Stripe + App Store/Google Play,
// after fees and refunds) and net income (money in minus ad spend).

function notSupported(): never {
  throw new Error('The ROI report is only implemented for PostgreSQL.');
}

/** Hostname of the marketing site whose sessions count as visitors. */
export const getMarketingHostname = () =>
  process.env.ROI_MARKETING_HOSTNAME || 'www.cashflowcalendar.app';

export async function getRoiReport(websiteId: string, params: { trialSettings: TrialSettings }) {
  return runQuery({
    [PRISMA]: () => relationalQuery(websiteId, params.trialSettings),
    [CLICKHOUSE]: notSupported,
  });
}

async function getInternalUsers(websiteId: string): Promise<Set<string>> {
  const rows = await prisma.rawQuery(
    `
    select distinct u.string_value as "userId"
    from event_data i
    join event_data u on u.website_event_id = i.website_event_id and u.data_key = 'user_id'
    where i.website_id = {{websiteId::uuid}}
      and i.data_key = 'is_internal' and i.string_value = 'true'
    `,
    { websiteId },
    'getRoiInternalUsers',
  );
  return new Set(rows.map((r: any) => r.userId).filter(Boolean));
}

async function getTrialStarts(websiteId: string, trialSettings: TrialSettings) {
  const now = new Date();
  const [occurrences, expiresRows, internal] = await Promise.all([
    getTrialStartOccurrences(websiteId, trialSettings, now),
    trialSettings.trialStartMode === 'trialExpiresAt'
      ? getTrialExpiresRows(websiteId, trialSettings)
      : [],
    getInternalUsers(websiteId),
  ]);
  const { starts } = resolveTrialStarts(occurrences, expiresRows, trialSettings, now);
  return new Map(
    [...starts].filter(([id]) => !internal.has(id)).map(([id, s]) => [id, s.start] as const),
  );
}

async function relationalQuery(websiteId: string, trialSettings: TrialSettings) {
  const now = new Date();
  const months = lastMonths(ROI_MONTHS, now);
  const from = monthStart(months[0]);
  const fromDate = new Date(`${from}T00:00:00Z`);
  const hostname = getMarketingHostname();

  const [spend, visitors, trialStarts, txns, appStores, syncStatus] = await Promise.all([
    getMonthlySpend(websiteId, from),
    getMonthlyVisitors(websiteId, hostname, fromDate),
    getTrialStarts(websiteId, trialSettings),
    getRevenueTxns(websiteId),
    getAppStoresCached(from, now.toISOString().slice(0, 10)),
    getSyncStatus(websiteId),
  ]);

  const trials = new Map<string, number>();
  for (const start of trialStarts.values()) {
    const month = monthOf(start);
    trials.set(month, (trials.get(month) ?? 0) + 1);
  }

  const rows = buildMonths(months, {
    spend: spend.byMonth,
    visitors,
    trials,
    // All Stripe history, so "new customer" means first payment ever.
    stripe: txns.filter(t => t.source === 'stripe'),
    appStores,
  });

  // Sources the page depends on. Google pushes from its own script, so a stopped
  // script shows up only as an old last-success time.
  const sources = ['meta', 'google', 'stripe'].map(source => ({
    source,
    lastSuccessAt: syncStatus.find(s => s.source === source)?.lastSuccess?.finishedAt ?? null,
  }));

  return {
    hostname,
    months: rows,
    appStoresAvailable: appStores !== null,
    googleConnected: !!sources.find(s => s.source === 'google')?.lastSuccessAt,
    updatedAt: latestSync(sources),
    stale: staleSources(sources, now),
    spendFxGaps: spend.fxGaps,
    syncErrors: syncStatus
      .filter(s => s.last?.status === 'error')
      .map(s => ({ source: s.source, message: s.last?.message ?? '' })),
  };
}

// RevenueCat's chart endpoint allows 25 requests/min; cache per range briefly.
const rcCache = new Map<string, { at: number; value: Map<string, AppStoreMonth> | null }>();
async function getAppStoresCached(start: string, end: string) {
  const key = process.env.REVENUECAT_API_KEY;
  const projectId = process.env.REVENUECAT_PROJECT_ID;
  if (!key || !projectId) return null;
  const cacheKey = `${start}|${end}`;
  const hit = rcCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  try {
    const value = await fetchRcMonthly(start, end, { key, projectId });
    rcCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return hit?.value ?? null;
  }
}

async function getMonthlySpend(websiteId: string, from: string) {
  const rows = await prisma.rawQuery(
    `
    select to_char(date, 'YYYY-MM') as month, channel, sum(spend_usd)::float as usd,
      count(*) filter (where spend_usd is null and spend > 0)::int as gaps
    from ad_spend
    where website_id = {{websiteId::uuid}} and date >= {{from}}::date
    group by 1, 2
    `,
    { websiteId, from },
    'getRoiMonthlySpend',
  );
  const byMonth = new Map<string, { meta: number; google: number }>();
  let fxGaps = 0;
  for (const r of rows as any[]) {
    fxGaps += Number(r.gaps ?? 0);
    const cur = byMonth.get(r.month) ?? { meta: 0, google: 0 };
    if (r.channel === 'google') cur.google += Number(r.usd ?? 0);
    else cur.meta += Number(r.usd ?? 0);
    byMonth.set(r.month, cur);
  }
  // Rows whose currency had no FX rate add $0; the page reports how many.
  return { byMonth, fxGaps };
}

async function getMonthlyVisitors(websiteId: string, hostname: string, from: Date) {
  const rows = await prisma.rawQuery(
    `
    select to_char(created_at at time zone '${ROI_TIMEZONE}', 'YYYY-MM') as month,
      count(distinct session_id)::int as n
    from website_event
    where website_id = {{websiteId::uuid}}
      and hostname = {{hostname}}
      and created_at >= {{from}}
    group by 1
    `,
    { websiteId, hostname, from },
    'getRoiMonthlyVisitors',
  );
  return new Map<string, number>(rows.map((r: any) => [r.month, Number(r.n)]));
}
