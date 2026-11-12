import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import { fetchRcMonthly, fetchRcPlanPrices } from '@/lib/revenue/revenuecat';
import { fetchStripePlanPrices } from '@/lib/revenue/stripe';
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
  YEARLY_MIN_USD,
} from '@/lib/roi';
import {
  type Channel,
  type ChannelData,
  type ChannelMonth,
  LAST_30_DAYS,
  MATURE_DAYS,
  MIN_AD_RETENTION_CUSTOMERS,
  PAID_WITHIN_DAYS,
  ROLLING_DAYS,
  TRIAL_MATURE_DAYS,
  type TrialCohort,
} from '@/lib/roiBreakEven';
import {
  buildRetention,
  type CustomerValue,
  type PlanEconomics,
  type ProjectionMonth,
  planEconomics,
  type Retention,
} from '@/lib/roiProjection';
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

  const [spend, visitors, trialStarts, txns, appStores, syncStatus, customerValue] =
    await Promise.all([
      getMonthlySpend(websiteId, from),
      getMonthlyVisitors(websiteId, hostname, fromDate),
      getTrialStarts(websiteId, trialSettings),
      getRevenueTxns(websiteId),
      getAppStoresCached(from, now.toISOString().slice(0, 10)),
      getSyncStatus(websiteId),
      getCustomerValue(websiteId),
    ]);
  const [plans, retention, channels, firstPayments] = await Promise.all([
    getPlans(websiteId, now, appStores),
    getRetention(websiteId),
    getChannelData(websiteId, hostname, fromDate, now),
    getFirstPayments(websiteId),
  ]);
  const trialCohorts = buildTrialCohorts(trialStarts, firstPayments, now);

  const trials = new Map<string, number>();
  for (const start of trialStarts.values()) {
    const month = monthOf(start);
    trials.set(month, (trials.get(month) ?? 0) + 1);
  }

  const rows = buildMonths(months, {
    spend: spend.byMonth,
    visitors: visitors.visitors,
    appUsers: visitors.appUsers,
    trials,
    // All Stripe history, so "new customer" means first payment ever.
    stripe: txns.filter(t => t.source === 'stripe'),
    appStores,
  });

  // History for the "what if" projection: completed months only.
  const projectionHistory: ProjectionMonth[] = rows.slice(0, -1).map(r => {
    const ads = spend.website.get(r.month);
    return {
      month: r.month,
      visitors: r.visitors,
      trials: r.trials,
      newCustomers: r.newCustomers,
      moneyIn: r.moneyIn,
      metaSpend: ads?.metaSpend ?? 0,
      metaClicks: ads?.metaClicks ?? 0,
      googleSpend: ads?.googleSpend ?? 0,
      googleClicks: ads?.googleClicks ?? 0,
      otherSpend: ads?.otherSpend ?? 0,
    };
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
    botCountries: getBotCountries(),
    projection: {
      history: projectionHistory,
      customerValue,
      plans,
      retention,
      channels,
      trialCohorts,
    },
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

// App-install campaigns send clicks to the app stores, not the website.
const APP_INSTALL_CAMPAIGN = '%install%';

async function getMonthlySpend(websiteId: string, from: string) {
  const rows = await prisma.rawQuery(
    `
    select to_char(date, 'YYYY-MM') as month, channel,
      coalesce(campaign_name, '') ilike {{install}} as "appInstall",
      sum(spend_usd)::float as usd, sum(clicks)::int as clicks,
      count(*) filter (where spend_usd is null and spend > 0)::int as gaps
    from ad_spend
    where website_id = {{websiteId::uuid}} and date >= {{from}}::date
    group by 1, 2, 3
    `,
    { websiteId, from, install: APP_INSTALL_CAMPAIGN },
    'getRoiMonthlySpend',
  );
  const byMonth = new Map<string, { meta: number; google: number }>();
  const website = new Map<
    string,
    {
      metaSpend: number;
      metaClicks: number;
      googleSpend: number;
      googleClicks: number;
      otherSpend: number;
    }
  >();
  let fxGaps = 0;
  for (const r of rows as any[]) {
    const usd = Number(r.usd ?? 0);
    const clicks = Number(r.clicks ?? 0);
    fxGaps += Number(r.gaps ?? 0);
    const cur = byMonth.get(r.month) ?? { meta: 0, google: 0 };
    if (r.channel === 'google') cur.google += usd;
    else cur.meta += usd;
    byMonth.set(r.month, cur);

    const w = website.get(r.month) ?? {
      metaSpend: 0,
      metaClicks: 0,
      googleSpend: 0,
      googleClicks: 0,
      otherSpend: 0,
    };
    if (r.appInstall) w.otherSpend += usd;
    else if (r.channel === 'google') {
      w.googleSpend += usd;
      w.googleClicks += clicks;
    } else {
      w.metaSpend += usd;
      w.metaClicks += clicks;
    }
    website.set(r.month, w);
  }
  // Rows whose currency had no FX rate add $0; the page reports how many.
  return { byMonth, website, fxGaps };
}

/**
 * What a new paying customer is worth, from Stripe history: average net revenue
 * in their first 30 days (customers who started in the last 180 days, so it
 * reflects current prices) and first 365 days (customers with a full year).
 */
async function getCustomerValue(websiteId: string): Promise<CustomerValue> {
  const rows = await prisma.rawQuery(
    `
    with t as (
      select coalesce(user_id, customer_ref) as k, occurred_at, net_usd, gross_usd, kind
      from revenue_txn
      where website_id = {{websiteId::uuid}} and source = 'stripe'
    ),
    f as (
      select k, min(occurred_at) as first from t
      where kind = 'payment' and gross_usd > 0 and k is not null group by 1
    ),
    v as (
      select f.k, f.first,
        sum(t.net_usd) filter (where t.occurred_at < f.first + interval '30 days') as m1,
        sum(t.net_usd) filter (where t.occurred_at < f.first + interval '365 days') as y1
      from f join t using (k) group by 1, 2
    )
    select
      (avg(m1) filter (where first >= now() - interval '180 days'
        and first < now() - interval '30 days'))::float as "firstMonth",
      (avg(y1) filter (where first < now() - interval '365 days'))::float as "firstYear"
    from v
    `,
    { websiteId },
    'getRoiCustomerValue',
  );
  const r: any = rows[0] ?? {};
  const n = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
  return { firstMonth: n(r.firstMonth), firstYear: n(r.firstYear) };
}

/**
 * Website sessions per month, by where they landed:
 * - visitors: people landing on marketing pages (potential new customers)
 * - appUsers: logged-in sessions that start in the web app (dashboard, login,
 *   onboarding): existing trial users and customers using the product
 * - bots: sessions from countries that send only crawler traffic (one page,
 *   no signups); see ROI_BOT_COUNTRIES
 */
async function getMonthlyVisitors(websiteId: string, hostname: string, from: Date) {
  const rows = await prisma.rawQuery(
    `
    with first_view as (
      select distinct on (e.session_id) e.session_id, e.url_path, e.created_at, s.country
      from website_event e
      join session s on s.session_id = e.session_id
      where e.website_id = {{websiteId::uuid}}
        and e.hostname = {{hostname}}
        and e.event_type = 1
        and e.created_at >= {{from}}
      order by e.session_id, e.created_at
    ),
    classified as (
      select to_char(created_at at time zone '${ROI_TIMEZONE}', 'YYYY-MM') as month,
        (url_path like '/dashboard%' or url_path like '/auth%' or url_path like '/onboarding%') as app,
        coalesce(country, '') = any(string_to_array({{botCountries}}, ',')) as bot
      from first_view
    )
    select month,
      count(*) filter (where not app and not bot)::int as visitors,
      count(*) filter (where app)::int as "appUsers",
      count(*) filter (where bot and not app)::int as bots
    from classified
    group by 1
    `,
    { websiteId, hostname, from, botCountries: getBotCountries().join(',') },
    'getRoiMonthlyVisitors',
  );
  const visitors = new Map<string, number>();
  const appUsers = new Map<string, number>();
  const bots = new Map<string, number>();
  for (const r of rows as any[]) {
    visitors.set(r.month, Number(r.visitors));
    appUsers.set(r.month, Number(r.appUsers));
    bots.set(r.month, Number(r.bots));
  }
  return { visitors, appUsers, bots };
}

/**
 * Countries whose website traffic is crawlers, not people: one-page sessions
 * with no signups (Singapore and China data centres). Override with
 * ROI_BOT_COUNTRIES, a comma-separated list of country codes.
 */
export function getBotCountries() {
  const raw = process.env.ROI_BOT_COUNTRIES ?? 'SG,CN';
  return raw
    .split(',')
    .map(c => c.trim().toUpperCase())
    .filter(Boolean);
}

// Prices change rarely; cache them briefly per server instance.
const priceCache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>, fallback: T): Promise<T> {
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value as T;
  try {
    const value = await load();
    priceCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return (hit?.value as T) ?? fallback;
  }
}

/**
 * Plan economics for the projection: list prices from Stripe and the stores
 * (via RevenueCat), what each keeps after fees, the share picking yearly, how
 * long monthly customers stay, and what recent yearly buyers actually paid.
 */
async function getPlans(
  websiteId: string,
  now: Date,
  appStores: Map<string, AppStoreMonth> | null,
): Promise<PlanEconomics> {
  const stripeKey = process.env.STRIPE_RESTRICTED_KEY;
  const rcKey = process.env.REVENUECAT_API_KEY;
  const rcProject = process.env.REVENUECAT_PROJECT_ID;
  const today = now.toISOString().slice(0, 10);
  const halfYearAgo = new Date(+now - 182 * 86_400_000).toISOString().slice(0, 10);

  const [stripePrices, storePrices, history] = await Promise.all([
    stripeKey
      ? cached('stripe-prices', () => fetchStripePlanPrices(stripeKey), null)
      : Promise.resolve(null),
    rcKey && rcProject
      ? cached(
          `rc-prices-${today}`,
          () => fetchRcPlanPrices(halfYearAgo, today, { key: rcKey, projectId: rcProject }),
          null,
        )
      : Promise.resolve(null),
    getStripePlanHistory(websiteId),
  ]);

  // New app-store subscriptions over the same six months, to weigh web vs stores.
  const sixMonths = new Set(lastMonths(6, now));
  const storeNew = appStores
    ? [...appStores].filter(([m]) => sixMonths.has(m)).reduce((s, [, v]) => s + v.newCustomers, 0)
    : 0;

  return planEconomics({
    stripePrices,
    storePrices,
    stripeFeeRate: history.feeRate,
    stripeYearlyShare: history.yearlyShare,
    stripeNewCustomers: history.newCustomers,
    storeNewCustomers: storeNew,
    monthsKept: history.monthsKept,
    recentYearlyPaid: history.recentYearlyPaid,
    recentMonthlyPaid: history.recentMonthlyPaid,
  });
}

async function getStripePlanHistory(websiteId: string) {
  const rows = await prisma.rawQuery(
    `
    with t as (
      select coalesce(user_id, customer_ref) as k, occurred_at, gross_usd, fee_usd, kind
      from revenue_txn
      where website_id = {{websiteId::uuid}} and source = 'stripe'
    ),
    f as (
      select k, min(occurred_at) as first from t
      where kind = 'payment' and gross_usd > 0 and k is not null group by 1
    ),
    v as (
      select f.k, f.first,
        (array_agg(t.gross_usd order by t.occurred_at)
          filter (where t.kind = 'payment' and t.gross_usd > 0))[1] as first_amount,
        count(*) filter (where t.kind = 'payment' and t.gross_usd > 0
          and t.occurred_at < f.first + interval '365 days') as payments_year1
      from f join t using (k) group by 1, 2
    )
    select
      (select sum(fee_usd) / nullif(sum(gross_usd), 0) from t
        where kind = 'payment' and occurred_at >= now() - interval '90 days')::float as "feeRate",
      (count(*) filter (where first >= now() - interval '180 days' and first_amount >= {{yearlyMin}})::float
        / nullif(count(*) filter (where first >= now() - interval '180 days'), 0)) as "yearlyShare",
      count(*) filter (where first >= now() - interval '180 days')::int as "newCustomers",
      (avg(first_amount) filter (where first >= now() - interval '180 days'
        and first_amount >= {{yearlyMin}}))::float as "recentYearlyPaid",
      (avg(first_amount) filter (where first >= now() - interval '180 days'
        and first_amount < {{yearlyMin}}))::float as "recentMonthlyPaid",
      (avg(least(payments_year1, 12)) filter (where first < now() - interval '365 days'
        and first_amount < {{yearlyMin}}))::float as "monthsKept"
    from v
    `,
    { websiteId, yearlyMin: YEARLY_MIN_USD },
    'getRoiStripePlanHistory',
  );
  const r: any = rows[0] ?? {};
  const n = (v: any) => (v === null || v === undefined ? null : Number(v));
  return {
    feeRate: n(r.feeRate),
    yearlyShare: n(r.yearlyShare),
    newCustomers: Number(r.newCustomers ?? 0),
    recentYearlyPaid: n(r.recentYearlyPaid),
    recentMonthlyPaid: n(r.recentMonthlyPaid),
    monthsKept: n(r.monthsKept),
  };
}

/**
 * How customers keep paying, from Stripe history:
 * - monthly[k]: share of monthly-plan customers still paying in their month k+1
 *   (monthly[0] = 1), each month measured on customers old enough to have reached it
 * - yearlyRenewal: share of yearly customers who paid a second year
 */
async function getRetention(websiteId: string, userIds?: string[]): Promise<Retention> {
  const rows = await prisma.rawQuery(
    `
    with t as (
      select coalesce(user_id, customer_ref) as k, occurred_at, gross_usd
      from revenue_txn
      where website_id = {{websiteId::uuid}} and source = 'stripe'
        and kind = 'payment' and gross_usd > 0
        ${userIds ? `and user_id = any(string_to_array({{userIds}}, ','))` : ''}
    ),
    f as (select k, min(occurred_at) as first from t where k is not null group by 1),
    v as (
      select f.k, f.first, (array_agg(t.gross_usd order by t.occurred_at))[1] as amount,
        count(*) as payments,
        bool_or(t.gross_usd >= {{yearlyMin}} and t.occurred_at > f.first + interval '300 days')
          as renewed
      from f join t using (k) group by 1, 2
    ),
    ages as (select generate_series(1, 12) as age)
    select 'monthly' as kind, age,
      count(*) filter (where first <= now() - make_interval(months => age))::int as eligible,
      count(*) filter (where first <= now() - make_interval(months => age)
        and payments >= age)::int as paying
    from ages cross join v where amount < {{yearlyMin}}
    group by age
    union all
    select 'yearly', 13,
      count(*) filter (where first <= now() - interval '13 months')::int,
      count(*) filter (where first <= now() - interval '13 months' and renewed)::int
    from v where amount >= {{yearlyMin}}
    order by 1, 2
    `,
    { websiteId, yearlyMin: YEARLY_MIN_USD, userIds: userIds?.join(',') ?? '' },
    'getRoiRetention',
  );
  return buildRetention(rows as any[]);
}

/**
 * Each user's first payment: on the web (Stripe) or in the app stores
 * (subscription_started; store purchases carry a user id since Oct 2026).
 */
async function getFirstPayments(websiteId: string): Promise<Map<string, Date>> {
  const rows = await prisma.rawQuery(
    `
    select uid, min(first) as first from (
      select user_id as uid, min(occurred_at) as first
      from revenue_txn
      where website_id = {{websiteId::uuid}} and source = 'stripe' and kind = 'payment'
        and gross_usd > 0 and user_id is not null
      group by 1
      union all
      select u.string_value, min(e.created_at)
      from website_event e
      join event_data u on u.website_event_id = e.event_id and u.data_key = 'user_id'
      where e.website_id = {{websiteId::uuid}} and e.event_name = 'subscription_started'
      group by 1
    ) x
    group by 1
    `,
    { websiteId },
    'getRoiFirstPayments',
  );
  return new Map((rows as any[]).map(r => [r.uid, new Date(r.first)]));
}

/**
 * Trial-to-paying by trial cohort: of the trials started each month that are
 * old enough to have played out, how many users paid within PAID_WITHIN_DAYS.
 * (Dividing a month's new customers by the same month's trials mixes cohorts.)
 */
function buildTrialCohorts(
  starts: Map<string, Date>,
  firstPaid: Map<string, Date>,
  now: Date,
): TrialCohort[] {
  const matureBefore = +now - TRIAL_MATURE_DAYS * 86_400_000;
  const byMonth = new Map<string, TrialCohort>();
  for (const [uid, start] of starts) {
    const t = +new Date(start);
    if (t > matureBefore) continue;
    const month = monthOf(start);
    const row = byMonth.get(month) ?? { month, trials: 0, paid: 0 };
    row.trials += 1;
    const paid = firstPaid.get(uid);
    const days = paid ? (+paid - t) / 86_400_000 : null;
    if (days !== null && days >= -1 && days <= PAID_WITHIN_DAYS) row.paid += 1;
    byMonth.set(month, row);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Paid clicks: Google adds a gclid (or the campaign is tagged google / cpc);
// Meta ads are tagged utm_medium=paid with the placement as utm_source (fb,
// ig, an = Audience Network, th = Threads, msg = Messenger). Facebook also adds
// an fbclid to organic link clicks, so an fbclid alone isn't a paid visit.
const META_SOURCES = `('fb','ig','an','th','msg','facebook','instagram','meta')`;
const PAID_MEDIUMS = `('paid','cpc','ppc','paid_social','paidsocial')`;
const channelOf = (src: string, med: string, gclid?: string) => `
  case
    when ${gclid ? `${gclid} is not null or ` : ''}(${src} = 'google' and ${med} in ${PAID_MEDIUMS}) then 'google'
    when ${med} in ${PAID_MEDIUMS} and ${src} in ${META_SOURCES} then 'meta'
  end`;
const STORE_TAPS = `('apple_app_store_button_click','google_play_button_click')`;

/**
 * Paid website traffic per month and channel (first page of each session,
 * bots and logged-in app sessions left out), with how many of those visits
 * tapped a store badge or signed up on the web; paying customers traced back
 * to a paid signup; and store taps vs app signups from all traffic.
 */
async function getChannelData(
  websiteId: string,
  hostname: string,
  from: Date,
  now: Date,
): Promise<ChannelData> {
  const matureBefore = new Date(+now - MATURE_DAYS * 86_400_000);
  // Rows for the rolling window come back under the month key LAST_30_DAYS.
  const since = new Date(+now - ROLLING_DAYS * 86_400_000);
  const botCountries = getBotCountries().join(',');
  const bucket = (col: string) => `
    cross join lateral (values
      (to_char(${col} at time zone '${ROI_TIMEZONE}', 'YYYY-MM')),
      (case when ${col} >= {{since}} then '${LAST_30_DAYS}' end)
    ) as b(month)`;
  const [funnel, payers, app, recentSpend] = await Promise.all([
    prisma.rawQuery(
      `
      with fv as (
        select distinct on (e.session_id) e.session_id, e.created_at, e.url_path, e.gclid,
          lower(coalesce(e.utm_source, '')) as src, lower(coalesce(e.utm_medium, '')) as med, s.country
        from website_event e
        join session s on s.session_id = e.session_id
        where e.website_id = {{websiteId::uuid}} and e.hostname = {{hostname}}
          and e.event_type = 1 and e.created_at >= {{from}}
        order by e.session_id, e.created_at
      ),
      p as (
        select session_id, created_at, ${channelOf('src', 'med', 'gclid')} as channel
        from fv
        where not (url_path like '/dashboard%' or url_path like '/auth%' or url_path like '/onboarding%')
          and not (coalesce(country, '') = any(string_to_array({{botCountries}}, ',')))
      ),
      act as (
        select e.session_id,
          bool_or(e.event_name in ${STORE_TAPS}) as tapped,
          bool_or(e.event_name = 'signed_up') as signed
        from website_event e
        join p on p.session_id = e.session_id and p.channel is not null
        where e.website_id = {{websiteId::uuid}} and e.event_type = 2 and e.created_at >= {{from}}
        group by 1
      )
      select b.month, p.channel,
        count(*)::int as visits,
        count(*) filter (where p.created_at <= {{matureBefore}})::int as "matureVisits",
        count(*) filter (where act.tapped)::int as taps,
        count(*) filter (where act.signed)::int as "webSignups"
      from p left join act on act.session_id = p.session_id
      ${bucket('p.created_at')}
      where p.channel is not null and b.month is not null
      group by 1, 2
      `,
      { websiteId, hostname, from, matureBefore, botCountries, since },
      'getRoiChannelFunnel',
    ),
    // First-touch: the UTMs a signup recorded (the first landing's), linked to
    // the user through the signup event or another event in its session, then
    // to their first payment on the web (Stripe) or in the stores.
    prisma.rawQuery(
      `
      with su as (
        select e.event_id, e.session_id, e.created_at,
          lower(max(d.string_value) filter (where d.data_key = 'utmSource')) as src,
          lower(max(d.string_value) filter (where d.data_key = 'utmMedium')) as med,
          max(d.string_value) filter (where d.data_key = 'user_id') as uid
        from website_event e
        join event_data d on d.website_event_id = e.event_id
        where e.website_id = {{websiteId::uuid}} and e.event_name = 'signed_up'
          and e.created_at >= {{from}}
        group by 1, 2, 3
      ),
      sess as (
        select e.session_id, min(u.string_value) as uid
        from website_event e
        join event_data u on u.website_event_id = e.event_id and u.data_key = 'user_id'
        where e.website_id = {{websiteId::uuid}} and e.session_id in (select session_id from su)
        group by 1
      ),
      att as (
        select distinct on (coalesce(su.uid, sess.uid)) coalesce(su.uid, sess.uid) as uid,
          su.created_at as signup_at, ${channelOf('su.src', 'su.med')} as channel
        from su left join sess on sess.session_id = su.session_id
        where coalesce(su.uid, sess.uid) is not null
        order by coalesce(su.uid, sess.uid), su.created_at
      ),
      paid as (
        select user_id as uid, min(occurred_at) as first
        from revenue_txn
        where website_id = {{websiteId::uuid}} and source = 'stripe' and kind = 'payment'
          and gross_usd > 0 and user_id is not null
        group by 1
        union all
        select u.string_value, min(e.created_at)
        from website_event e
        join event_data u on u.website_event_id = e.event_id and u.data_key = 'user_id'
        where e.website_id = {{websiteId::uuid}} and e.event_name = 'subscription_started'
          and not exists (
            select 1 from event_data x
            where x.website_event_id = e.event_id and x.data_key = 'is_internal' and x.string_value = 'true'
          )
        group by 1
      )
      select att.uid, att.channel,
        to_char(att.signup_at at time zone '${ROI_TIMEZONE}', 'YYYY-MM') as month,
        att.signup_at <= {{matureBefore}} as mature,
        att.signup_at >= {{since}} as recent,
        min(paid.first) as "firstPaid"
      from att join paid on paid.uid = att.uid
      where att.channel is not null
      group by 1, 2, 3, 4, 5
      `,
      { websiteId, from, matureBefore, since },
      'getRoiChannelPayers',
    ),
    prisma.rawQuery(
      `
      select b.month,
        count(distinct e.session_id) filter (where e.event_name in ${STORE_TAPS})::int as taps,
        count(distinct e.event_id) filter (where e.event_name = 'signed_up' and d.string_value in ('ios', 'android'))::int as "appSignups"
      from website_event e
      left join event_data d on d.website_event_id = e.event_id and d.data_key = 'platform'
      ${bucket('e.created_at')}
      where e.website_id = {{websiteId::uuid}} and e.event_type = 2 and e.created_at >= {{from}}
        and (e.event_name in ${STORE_TAPS} or e.event_name = 'signed_up')
        and b.month is not null
      group by 1
      `,
      { websiteId, from, since },
      'getRoiAppSignups',
    ),
    // Website-campaign spend over the rolling window (app-install campaigns
    // send clicks to the stores, not the site).
    prisma.rawQuery(
      `
      select channel, sum(spend_usd)::float as usd
      from ad_spend
      where website_id = {{websiteId::uuid}} and date >= {{since}}::date
        and not (coalesce(campaign_name, '') ilike {{install}})
      group by 1
      `,
      { websiteId, since: since.toISOString().slice(0, 10), install: APP_INSTALL_CAMPAIGN },
      'getRoiRecentSpend',
    ),
  ]);

  const months = new Map<string, ChannelMonth>();
  const row = (month: string, channel: Channel) => {
    const key = `${month}|${channel}`;
    if (!months.has(key)) {
      months.set(key, {
        month,
        channel,
        visits: 0,
        matureVisits: 0,
        taps: 0,
        webSignups: 0,
        payers: 0,
      });
    }
    return months.get(key);
  };
  for (const r of funnel as any[]) {
    Object.assign(row(r.month, r.channel), {
      visits: Number(r.visits),
      matureVisits: Number(r.matureVisits),
      taps: Number(r.taps),
      webSignups: Number(r.webSignups),
    });
  }
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);
  const adUsers = new Set<string>();
  const adUsersThreeMonths = new Set<string>();
  for (const r of payers as any[]) {
    adUsers.add(r.uid);
    if (new Date(r.firstPaid) <= threeMonthsAgo) adUsersThreeMonths.add(r.uid);
    if (r.mature) row(r.month, r.channel).payers += 1;
    if (r.mature && r.recent) row(LAST_30_DAYS, r.channel).payers += 1;
  }
  const spendRows = recentSpend as any[];
  const spendOf = (c: Channel) =>
    spendRows
      .filter(r => (c === 'google' ? r.channel === 'google' : r.channel !== 'google'))
      .reduce((s, r) => s + Number(r.usd ?? 0), 0);

  return {
    months: [...months.values()],
    app: (app as any[]).map(r => ({
      month: r.month,
      taps: Number(r.taps),
      appSignups: Number(r.appSignups),
    })),
    last30Spend: { meta: spendOf('meta'), google: spendOf('google') },
    adCustomers: adUsers.size,
    adCustomersThreeMonths: adUsersThreeMonths.size,
    adRetention:
      adUsersThreeMonths.size >= MIN_AD_RETENTION_CUSTOMERS
        ? await getRetention(websiteId, [...adUsers])
        : null,
  };
}
