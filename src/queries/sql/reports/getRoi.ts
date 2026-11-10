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
  const [plans, retention] = await Promise.all([
    getPlans(websiteId, now, appStores),
    getRetention(websiteId),
  ]);

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
    projection: { history: projectionHistory, customerValue, plans, retention },
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
async function getRetention(websiteId: string): Promise<Retention> {
  const rows = await prisma.rawQuery(
    `
    with t as (
      select coalesce(user_id, customer_ref) as k, occurred_at, gross_usd
      from revenue_txn
      where website_id = {{websiteId::uuid}} and source = 'stripe'
        and kind = 'payment' and gross_usd > 0
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
    { websiteId, yearlyMin: YEARLY_MIN_USD },
    'getRoiRetention',
  );
  return buildRetention(rows as any[]);
}
