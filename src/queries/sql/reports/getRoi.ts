import { formatInTimeZone } from 'date-fns-tz';
import { addDays } from '@/lib/ads/fx';
import { REPORTING_TIMEZONE } from '@/lib/ads/sync';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import { fetchRcProceeds } from '@/lib/revenue/revenuecat';
import {
  buildCustomerRevenue,
  type CohortUser,
  type RoiSettings,
  type SpendDay,
  spendNeededFor,
  sumCashIn,
  summarizeFunnel,
  sumSpend,
} from '@/lib/roi';
import {
  getWeekStart,
  resolveTrialStarts,
  type TrialSettings,
  type TrialWindow,
} from '@/lib/trial';
import { getSyncStatus } from '@/queries/prisma/adSpend';
import { getRevenueTxns } from '@/queries/prisma/revenue';
import { getTrialExpiresRows, getTrialStartOccurrences } from './getTrial';

// Marketing funnel for a period: total ad spend → marketing-site visitors → trial
// starts → paying customers → their real revenue to date (Stripe + RevenueCat).
// No per-ad attribution: everything is blended over the period.

function notSupported(): never {
  throw new Error('The ROI report is only implemented for PostgreSQL.');
}

const dayKey = (d: Date) => formatInTimeZone(d, REPORTING_TIMEZONE, 'yyyy-MM-dd');

/** Hostname of the marketing site whose sessions count as visitors. */
export const getMarketingHostname = () =>
  process.env.ROI_MARKETING_HOSTNAME || 'www.cashflowcalendar.app';

export async function getRoiReport(
  websiteId: string,
  params: {
    window: TrialWindow;
    trialSettings: TrialSettings;
    roiSettings: RoiSettings;
    targetRevenueUsd?: number;
  },
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(websiteId, params),
    [CLICKHOUSE]: notSupported,
  });
}

/** Users of the trial cohort, all time (the revenue sync refreshes these in RevenueCat). */
export async function getTrialStarterIds(websiteId: string, trialSettings: TrialSettings) {
  const now = new Date();
  const [occurrences, expiresRows, internal] = await Promise.all([
    getTrialStartOccurrences(websiteId, trialSettings, now),
    trialSettings.trialStartMode === 'trialExpiresAt'
      ? getTrialExpiresRows(websiteId, trialSettings)
      : [],
    getInternalUsers(websiteId),
  ]);
  const { starts } = resolveTrialStarts(occurrences, expiresRows, trialSettings, now);
  return [...starts]
    .filter(([id]) => !internal.has(id))
    .sort((a, b) => +b[1].start - +a[1].start) // newest first: they change most
    .map(([id]) => id);
}

async function relationalQuery(
  websiteId: string,
  {
    window,
    trialSettings,
    roiSettings,
    targetRevenueUsd,
  }: {
    window: TrialWindow;
    trialSettings: TrialSettings;
    roiSettings: RoiSettings;
    targetRevenueUsd?: number;
  },
) {
  const now = new Date();
  const endDate = new Date(Math.min(+window.endDate, +now));
  const start = dayKey(window.startDate);
  const end = dayKey(endDate);
  const hostname = getMarketingHostname();

  const [
    occurrences,
    expiresRows,
    internal,
    txns,
    syncStatus,
    spendRows,
    visitors,
    weeklyVisitors,
  ] = await Promise.all([
    getTrialStartOccurrences(websiteId, trialSettings, now),
    trialSettings.trialStartMode === 'trialExpiresAt'
      ? getTrialExpiresRows(websiteId, trialSettings)
      : [],
    getInternalUsers(websiteId),
    getRevenueTxns(websiteId),
    getSyncStatus(websiteId),
    getSpendDays(websiteId, start, end),
    getVisitors(websiteId, hostname, window.startDate, endDate),
    getWeeklyVisitors(websiteId, hostname, window.startDate, endDate),
  ]);

  const resolved = resolveTrialStarts(occurrences, expiresRows, trialSettings, now);
  const cohort: CohortUser[] = [...resolved.starts]
    .filter(
      ([id, s]) => s.start >= window.startDate && s.start < window.endDate && !internal.has(id),
    )
    .map(([userId, s]) => ({ userId, trialStart: s.start }));

  const customers = buildCustomerRevenue(cohort, txns);
  const totalSpend = sumSpend(spendRows, start, addDays(end, 1));
  const summary = summarizeFunnel(
    customers,
    totalSpend,
    visitors,
    trialSettings.trialLengthDays,
    now,
  );
  const target = targetRevenueUsd ?? roiSettings.targetRevenueUsd;

  // Weekly trend by trial-start week (Monday, reporting time zone).
  const weeks = new Map<string, typeof customers>();
  for (let w = getWeekStart(window.startDate, REPORTING_TIMEZONE); w <= end; w = addDays(w, 7)) {
    weeks.set(w, []);
  }
  for (const c of customers) {
    const week = getWeekStart(c.trialStart, REPORTING_TIMEZONE);
    if (!weeks.has(week)) weeks.set(week, []);
    weeks.get(week).push(c);
  }
  const weekly = [...weeks.keys()].sort().map(week => {
    const spend = sumSpend(spendRows, week < start ? start : week, addDays(week, 7));
    const s = summarizeFunnel(
      weeks.get(week),
      spend,
      weeklyVisitors.get(week) ?? 0,
      trialSettings.trialLengthDays,
      now,
    );
    return {
      week,
      spendUsd: s.spendUsd,
      visitors: s.visitors,
      trialStarts: s.trialStarts,
      payingCustomers: s.payingCustomers,
      netRevenue: s.netRevenue,
      roas: s.roas,
      immature: s.immature,
    };
  });

  // Spend by channel and campaign.
  const byCampaign = new Map<string, any>();
  for (const r of spendRows) {
    const key = `${r.channel}|${r.campaignId}`;
    if (!byCampaign.has(key)) {
      byCampaign.set(key, {
        channel: r.channel,
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        spendUsd: 0,
        impressions: 0,
        clicks: 0,
      });
    }
    const row = byCampaign.get(key);
    row.spendUsd = Math.round((row.spendUsd + (r.spendUsd ?? 0)) * 100) / 100;
    row.impressions += r.impressions;
    row.clicks += r.clicks;
  }

  // All money in during the period, from every customer (not just this funnel).
  const stripeCash = sumCashIn(txns, window.startDate, endDate, 'stripe');
  const revenuecatProceeds = await getRcProceedsCached(start, end);
  const unmatched = txns.filter(t => !t.userId && t.source === 'stripe').length;

  return {
    window,
    settings: roiSettings,
    hostname,
    trialLengthDays: trialSettings.trialLengthDays,
    summary,
    headline: {
      roas: summary.roas,
      targetRevenueUsd: target,
      spendNeededUsd: spendNeededFor(target, summary.roas),
      immature: summary.immature,
    },
    cashIn: {
      stripeNet: stripeCash.net,
      stripeGross: stripeCash.gross,
      revenuecatProceeds,
      total:
        revenuecatProceeds === null
          ? null
          : Math.round((stripeCash.net + revenuecatProceeds) * 100) / 100,
    },
    weekly,
    campaigns: [...byCampaign.values()].sort((a, b) => b.spendUsd - a.spendUsd),
    health: {
      sync: syncStatus.map(s => ({
        source: s.source,
        lastStatus: s.last?.status ?? null,
        lastAt: s.last?.finishedAt ?? s.last?.startedAt ?? null,
        lastMessage: s.last?.status === 'error' ? s.last?.message : null,
        lastSuccessAt: s.lastSuccess?.finishedAt ?? null,
      })),
      spendFxGaps: spendRows.filter(r => r.spendUsd === null && r.spend > 0).length,
      spendRows: spendRows.length,
      revenueRows: txns.length,
      unmatchedStripeRows: unmatched,
    },
  };
}

// RevenueCat's metrics endpoint allows 25 requests/min; cache per range briefly.
const rcCache = new Map<string, { at: number; value: number | null }>();
async function getRcProceedsCached(start: string, end: string) {
  const key = process.env.REVENUECAT_API_KEY;
  const projectId = process.env.REVENUECAT_PROJECT_ID;
  if (!key || !projectId) return null;
  const cacheKey = `${start}|${end}`;
  const hit = rcCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  try {
    const value = await fetchRcProceeds(start, end, { key, projectId });
    rcCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
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

async function getVisitors(websiteId: string, hostname: string, startDate: Date, endDate: Date) {
  const rows = await prisma.rawQuery(
    `
    select count(distinct session_id)::int as n
    from website_event
    where website_id = {{websiteId::uuid}}
      and hostname = {{hostname}}
      and created_at between {{startDate}} and {{endDate}}
    `,
    { websiteId, hostname, startDate, endDate },
    'getRoiVisitors',
  );
  return Number(rows[0]?.n ?? 0);
}

async function getWeeklyVisitors(
  websiteId: string,
  hostname: string,
  startDate: Date,
  endDate: Date,
) {
  const rows = await prisma.rawQuery(
    `
    select to_char(date_trunc('week', created_at at time zone '${REPORTING_TIMEZONE}'), 'YYYY-MM-DD') as week,
      count(distinct session_id)::int as n
    from website_event
    where website_id = {{websiteId::uuid}}
      and hostname = {{hostname}}
      and created_at between {{startDate}} and {{endDate}}
    group by 1
    `,
    { websiteId, hostname, startDate, endDate },
    'getRoiWeeklyVisitors',
  );
  return new Map<string, number>(rows.map((r: any) => [r.week, Number(r.n)]));
}

async function getSpendDays(websiteId: string, start: string, end: string): Promise<SpendDay[]> {
  const rows = await prisma.rawQuery(
    `
    select to_char(date, 'YYYY-MM-DD') as date, channel, campaign_id as "campaignId",
      max(campaign_name) as "campaignName", currency,
      sum(spend)::float as spend, sum(spend_usd)::float as "spendUsd",
      sum(impressions)::int as impressions, sum(clicks)::int as clicks
    from ad_spend
    where website_id = {{websiteId::uuid}}
      and date between {{start}}::date and {{end}}::date
    group by 1, 2, 3, 5
    `,
    { websiteId, start, end },
    'getRoiSpendDays',
  );

  return rows.map((r: any) => ({
    ...r,
    spend: Number(r.spend),
    spendUsd: r.spendUsd === null ? null : Number(r.spendUsd),
  }));
}
