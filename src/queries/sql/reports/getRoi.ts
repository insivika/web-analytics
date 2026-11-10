import { formatInTimeZone } from 'date-fns-tz';
import { addDays, buildFxLookup, fetchFrankfurterRates } from '@/lib/ads/fx';
import { REPORTING_TIMEZONE } from '@/lib/ads/sync';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import {
  buildUserRevenue,
  type CohortUser,
  DAY_MS,
  estimateLtv,
  type RevenueEvent,
  type RoiSettings,
  type SpendDay,
  spendNeededFor,
  summarizeCohort,
  sumSpend,
} from '@/lib/roi';
import {
  getWeekStart,
  resolveTrialStarts,
  type TrialSettings,
  type TrialWindow,
} from '@/lib/trial';
import { getFxRates, getSyncStatus, saveFxRates } from '@/queries/prisma/adSpend';
import { getTrialExpiresRows, getTrialStartOccurrences } from './getTrial';

// Blended ROI: total ad spend vs. all trial starts in the period and their net
// revenue. Works without click attribution; channel/campaign attribution is added
// once signups carry click ids.

function notSupported(): never {
  throw new Error('The ROI report is only implemented for PostgreSQL.');
}

const dayKey = (d: Date) => formatInTimeZone(d, REPORTING_TIMEZONE, 'yyyy-MM-dd');

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
  const derived = trialSettings.trialStartMode === 'trialExpiresAt';

  const [occurrences, expiresRows, events, cancellations, syncStatus] = await Promise.all([
    getTrialStartOccurrences(websiteId, trialSettings, now),
    derived ? getTrialExpiresRows(websiteId, trialSettings) : [],
    getRevenueEvents(websiteId),
    getCancellations(websiteId),
    getSyncStatus(websiteId),
  ]);
  // Revenue events only exist from this date; earlier cohorts have no revenue data.
  const startedEvents = events.filter(e => e.eventName === 'subscription_started');
  const revenueStarted = startedEvents.length
    ? new Date(Math.min(...startedEvents.map(e => +new Date(e.createdAt))))
    : null;

  const start = dayKey(window.startDate);
  const end = dayKey(new Date(Math.min(+window.endDate, +now)));
  const spendRows = await getSpendDays(websiteId, start, end);

  // FX for revenue currencies (spend rows already carry spend_usd).
  const currencies = [...new Set(events.map(e => (e.currency || 'USD').toUpperCase()))];
  const firstEvent = events.length
    ? dayKey(new Date(Math.min(...events.map(e => +new Date(e.createdAt)))))
    : start;
  let fxRows = await getFxRates(currencies, addDays(firstEvent, -7), dayKey(now));
  let fx = buildFxLookup(fxRows);
  const missing = events.filter(
    e => e.priceUsd === null && e.revenue !== null && fx(e.currency || 'USD', e.createdAt) === null,
  );
  if (missing.length) {
    try {
      await saveFxRates(await fetchFrankfurterRates(firstEvent, dayKey(now), currencies));
      fxRows = await getFxRates(currencies, addDays(firstEvent, -7), dayKey(now));
      fx = buildFxLookup(fxRows);
    } catch {
      // Reported as FX gaps below.
    }
  }

  const internalUsers = new Set(events.filter(e => e.isInternal).map(e => e.userId));
  const resolved = resolveTrialStarts(occurrences, expiresRows, trialSettings, now);
  const cohort: CohortUser[] = [...resolved.starts]
    .filter(
      ([userId, { start: s }]) =>
        s >= window.startDate && s < window.endDate && !internalUsers.has(userId),
    )
    .map(([userId, { start: trialStart }]) => ({ userId, trialStart }));

  const revenueEvents = events.filter(e => !e.isInternal);
  const users = buildUserRevenue(cohort, revenueEvents, roiSettings, fx);
  const totalSpend = sumSpend(spendRows, start, addDays(end, 1));
  const summary = summarizeCohort(users, totalSpend, roiSettings, now);
  const roiWindow = roiSettings.revenueWindows[roiSettings.revenueWindows.length - 1];
  const target = targetRevenueUsd ?? roiSettings.targetRevenueUsd;

  // Weekly trend by trial-start week (Monday, reporting time zone).
  const weeks = new Map<string, typeof users>();
  for (const u of users) {
    const week = getWeekStart(u.trialStart, REPORTING_TIMEZONE);
    if (!weeks.has(week)) weeks.set(week, []);
    weeks.get(week).push(u);
  }
  for (let w = getWeekStart(window.startDate, REPORTING_TIMEZONE); w <= end; w = addDays(w, 7)) {
    if (!weeks.has(w)) weeks.set(w, []);
  }
  const weekly = [...weeks.keys()].sort().map(week => {
    const weekUsers = weeks.get(week);
    const spend = sumSpend(spendRows, week < start ? start : week, addDays(week, 7));
    const s = summarizeCohort(weekUsers, spend, roiSettings, now);
    return {
      week,
      spendUsd: s.spendUsd,
      trialStarts: s.trialStarts,
      payingCustomers: s.payingCustomers,
      revenue: s.revenue,
      roas: s.roas,
      immature: +now - Date.parse(`${addDays(week, 7)}T00:00:00Z`) < roiWindow * DAY_MS,
    };
  });

  // Spend by channel and campaign (spend side only until attribution lands).
  const byCampaign = new Map<string, any>();
  for (const r of spendRows) {
    const key = `${r.channel}|${r.campaignId}`;
    const row =
      byCampaign.get(key) ??
      byCampaign
        .set(key, {
          channel: r.channel,
          campaignId: r.campaignId,
          campaignName: r.campaignName,
          spendUsd: 0,
          impressions: 0,
          clicks: 0,
        })
        .get(key);
    row.spendUsd = Math.round((row.spendUsd + (r.spendUsd ?? 0)) * 100) / 100;
    row.impressions += r.impressions;
    row.clicks += r.clicks;
  }

  const spendFxGaps = spendRows.filter(r => r.spendUsd === null && r.spend > 0).length;

  return {
    window,
    settings: roiSettings,
    roiWindow,
    summary,
    headline: {
      roas: summary.roas,
      targetRevenueUsd: target,
      spendNeededUsd: spendNeededFor(target, summary.roas),
      immature: summary.immature,
    },
    ltv: estimateLtv(revenueEvents, cancellations, roiSettings, fx, now),
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
      revenueFxGaps: summary.missingFx,
      spendFxGaps,
      revenueTrackingStart: revenueStarted ? revenueStarted.toISOString() : null,
      spendRows: spendRows.length,
      // Click attribution isn't captured yet; filled in by the attribution steps.
      attributedShare: null as number | null,
      iosMatchRate: null as number | null,
    },
  };
}

const NUM = (key: string) => `max(case when d.data_key = '${key}' then
  coalesce(d.number_value, case when d.string_value ~ '^-?[0-9.]+$' then d.string_value::numeric end) end)`;
const STR = (key: string) => `max(case when d.data_key = '${key}' then d.string_value end)`;

async function getRevenueEvents(
  websiteId: string,
): Promise<(RevenueEvent & { isInternal: boolean })[]> {
  const rows = await prisma.rawQuery(
    `
    select e.event_name as "eventName", e.created_at as "createdAt",
      ${STR('user_id')} as "userId",
      ${NUM('revenue')} as revenue,
      ${STR('currency')} as currency,
      ${NUM('price_usd')} as "priceUsd",
      ${STR('provider')} as provider,
      coalesce(bool_or(d.data_key = 'is_internal' and d.string_value = 'true'), false) as "isInternal"
    from website_event e
    join event_data d on d.website_event_id = e.event_id
    where e.website_id = {{websiteId::uuid}}
      and e.event_name in ('subscription_started', 'subscription_renewed')
    group by e.event_id, e.event_name, e.created_at
    `,
    { websiteId },
    'getRoiRevenueEvents',
  );

  return rows
    .filter((r: any) => r.userId)
    .map((r: any) => ({
      ...r,
      revenue: r.revenue === null ? null : Number(r.revenue),
      priceUsd: r.priceUsd === null ? null : Number(r.priceUsd),
    }));
}

async function getCancellations(websiteId: string) {
  return prisma.rawQuery(
    `
    select e.created_at as "createdAt", ${STR('user_id')} as "userId"
    from website_event e
    join event_data d on d.website_event_id = e.event_id
    where e.website_id = {{websiteId::uuid}} and e.event_name = 'subscription_canceled'
    group by e.event_id, e.created_at
    `,
    { websiteId },
    'getRoiCancellations',
  );
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
