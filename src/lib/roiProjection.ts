// "What if" projection for ad spend (pure, unit-tested).
//
// Ad dollars become visitors at each platform's own cost per click (website
// campaigns only), with clicks getting pricier as spend grows past what was
// spent before. Visitors who'd come anyway stay fixed. Visitors become trials
// and trials become paying customers at the rates of the chosen past months;
// ad visitors can be set to convert worse than average. Paying customers turn
// into money at what new customers actually paid in their first month and year.

export const PROJECTION_WINDOWS = [1, 3, 6] as const;
export type ProjectionWindow = (typeof PROJECTION_WINDOWS)[number];

/** One completed month of history. */
export interface ProjectionMonth {
  month: string;
  visitors: number;
  trials: number;
  newCustomers: number;
  moneyIn: number;
  /** Meta website campaigns (app-install clicks go to the stores, not the site). */
  metaSpend: number;
  metaClicks: number;
  googleSpend: number;
  googleClicks: number;
  /** Ad spend that doesn't drive website visits (Meta app-install campaigns). */
  otherSpend: number;
}

/** What past new customers actually paid (a check on the plan-based values). */
export interface CustomerValue {
  /** Average net revenue in a new customer's first 30 days. */
  firstMonth: number | null;
  /** Average net revenue in a new customer's first 365 days. */
  firstYear: number | null;
}

export interface ProjectionBase {
  months: string[];
  visitors: number;
  organicVisitors: number;
  moneyIn: number;
  metaSpend: number;
  googleSpend: number;
  otherSpend: number;
  /** Cost per click; null when the platform has no click history at all. */
  metaCpc: number | null;
  googleCpc: number | null;
  visitorToTrial: number;
  trialToPaying: number;
}

const avg = (rows: ProjectionMonth[], k: keyof ProjectionMonth) =>
  rows.length ? rows.reduce((s, r) => s + Number(r[k]), 0) / rows.length : 0;
const sum = (rows: ProjectionMonth[], k: keyof ProjectionMonth) =>
  rows.reduce((s, r) => s + Number(r[k]), 0);

function cpc(
  window: ProjectionMonth[],
  all: ProjectionMonth[],
  spend: keyof ProjectionMonth,
  clicks: keyof ProjectionMonth,
) {
  for (const rows of [window, all]) {
    const c = sum(rows, clicks);
    if (c > 0) return sum(rows, spend) / c;
  }
  return null;
}

/** Averages over the last `window` completed months (history is oldest first). */
export function projectionBase(history: ProjectionMonth[], window: number): ProjectionBase {
  const rows = history.slice(-window);
  const visitors = avg(rows, 'visitors');
  const clicks = avg(rows, 'metaClicks') + avg(rows, 'googleClicks');
  const trials = sum(rows, 'trials');
  const totalVisitors = sum(rows, 'visitors');
  return {
    months: rows.map(r => r.month),
    visitors,
    organicVisitors: Math.max(visitors - clicks, 0),
    moneyIn: avg(rows, 'moneyIn'),
    metaSpend: avg(rows, 'metaSpend'),
    googleSpend: avg(rows, 'googleSpend'),
    otherSpend: avg(rows, 'otherSpend'),
    metaCpc: cpc(rows, history, 'metaSpend', 'metaClicks'),
    googleCpc: cpc(rows, history, 'googleSpend', 'googleClicks'),
    visitorToTrial: totalVisitors > 0 ? trials / totalVisitors : 0,
    trialToPaying: trials > 0 ? sum(rows, 'newCustomers') / trials : 0,
  };
}

/**
 * The base with ad dollars buying paid landing visits (cost per paid visit,
 * from the break-even model) instead of clicks, where known. Visitors not
 * bought by today's spend stay as the organic baseline.
 */
export function withPaidVisits(
  base: ProjectionBase,
  costPerVisit: { meta: number | null; google: number | null },
): ProjectionBase {
  const metaCpc = costPerVisit.meta ?? base.metaCpc;
  const googleCpc = costPerVisit.google ?? base.googleCpc;
  const bought =
    (metaCpc ? base.metaSpend / metaCpc : 0) + (googleCpc ? base.googleSpend / googleCpc : 0);
  return { ...base, metaCpc, googleCpc, organicVisitors: Math.max(base.visitors - bought, 0) };
}

/** Below this monthly spend, clicks are assumed to cost the same as before. */
export const MIN_REFERENCE_SPEND = 50;

/**
 * Visitors bought by `spend`. Up to what was spent before, clicks cost `cpc`;
 * beyond it, each doubling of spend makes a click `pricier` (0.15 = 15%) more expensive.
 */
export function paidVisitors(
  spend: number,
  cpc: number | null,
  referenceSpend: number,
  pricier: number,
) {
  if (spend <= 0 || !cpc) return 0;
  const ref = Math.max(referenceSpend, MIN_REFERENCE_SPEND);
  const cost = spend > ref ? cpc * (spend / ref) ** Math.log2(1 + pricier) : cpc;
  return spend / cost;
}

export interface ProjectionInputs {
  metaSpend: number;
  googleSpend: number;
  visitorToTrial: number;
  trialToPaying: number;
  /** How well ad visitors convert compared with everyone else (1 = the same). */
  adVisitorQuality: number;
  /** Share of new customers picking the yearly plan (0..1). */
  yearlyShare: number;
  /** List prices per billing period. */
  monthlyPrice: number;
  yearlyPrice: number;
  /** How many monthly payments a monthly customer makes in their first year. */
  monthsKept: number;
  /** Share of each payment kept after Stripe fees and store commission (0..1). */
  keepRate: number;
  /** Extra cost per click for each doubling of spend (0.15 = 15%). */
  pricier: number;
  /**
   * Visit → paying customer for paid visits, per channel (from the break-even
   * model: measured, else estimated). When unset, paid visits convert like any
   * visit (visitorToTrial × trialToPaying × adVisitorQuality).
   */
  metaPaidConversion?: number | null;
  googlePaidConversion?: number | null;
  /** Hosting, email etc. per paying customer per month. */
  otherCostPerCustomerMonth?: number;
  /** Fixed costs per month, taken off net income. */
  fixedMonthlyCosts?: number;
}

export interface ProjectionPoint {
  visitors: number;
  paidVisitors: number;
  trials: number;
  newCustomers: number;
}

export function projectFunnel(
  base: ProjectionBase,
  i: ProjectionInputs,
  metaSpend = i.metaSpend,
  googleSpend = i.googleSpend,
): ProjectionPoint {
  const metaPaid = paidVisitors(metaSpend, base.metaCpc, base.metaSpend, i.pricier);
  const googlePaid = paidVisitors(googleSpend, base.googleCpc, base.googleSpend, i.pricier);
  const paid = metaPaid + googlePaid;
  const organicTrials = base.organicVisitors * i.visitorToTrial;
  const anyVisit = i.visitorToTrial * i.trialToPaying * i.adVisitorQuality;
  // Paid visitors convert at their own channel's rate, not the all-visitor one.
  const paidCustomers =
    metaPaid * (i.metaPaidConversion ?? anyVisit) +
    googlePaid * (i.googlePaidConversion ?? anyVisit);
  const paidTrials = i.trialToPaying > 0 ? paidCustomers / i.trialToPaying : 0;
  return {
    visitors: base.organicVisitors + paid,
    paidVisitors: paid,
    trials: organicTrials + paidTrials,
    newCustomers: organicTrials * i.trialToPaying + paidCustomers,
  };
}

export interface Projection {
  projected: ProjectionPoint;
  today: ProjectionPoint;
  withoutAds: ProjectionPoint;
  spend: number;
  /** Money in per month: today's, plus first-month revenue from the change in
   * new customers. */
  moneyIn: number;
  todayMoneyIn: number;
  /** Net income per month: money in minus all ad spend. */
  netIncome: number;
  todayNetIncome: number;
  customersFromAds: number;
  costPerCustomerFromAds: number | null;
  /** First-year revenue from one month's ad-driven customers, minus that month's ad spend. */
  firstYearReturn: number;
  /** Spend far beyond anything in the history: the result is a rough guess. */
  beyondHistory: boolean;
}

/** `baseline` is what "today" means (defaults to `i`); pass the real rates to see a rate change. */
export function project(
  base: ProjectionBase,
  i: ProjectionInputs,
  baseline: ProjectionInputs = i,
): Projection {
  const projected = projectFunnel(base, i);
  const today = projectFunnel(base, baseline, base.metaSpend, base.googleSpend);
  const withoutAds = projectFunnel(base, i, 0, 0);
  const spend = i.metaSpend + i.googleSpend;
  const todaySpend = base.metaSpend + base.googleSpend;
  const customersFromAds = projected.newCustomers - withoutAds.newCustomers;
  const fixed = i.fixedMonthlyCosts ?? 0;
  const firstMonth = customerValue(i).firstMonth - (i.otherCostPerCustomerMonth ?? 0);
  const moneyIn = base.moneyIn + (projected.newCustomers - today.newCustomers) * firstMonth;
  return {
    moneyIn,
    todayMoneyIn: base.moneyIn,
    projected,
    today,
    withoutAds,
    spend,
    netIncome: moneyIn - spend - base.otherSpend - fixed,
    todayNetIncome: base.moneyIn - todaySpend - base.otherSpend - fixed,
    customersFromAds,
    costPerCustomerFromAds: customersFromAds > 0.01 ? spend / customersFromAds : null,
    firstYearReturn: customersFromAds * customerValue(i).firstYear - spend,
    beyondHistory: spend > 3 * Math.max(todaySpend, 100),
  };
}

/**
 * What one new customer brings in, from the plan inputs: a yearly customer pays
 * the yearly price up front; a monthly customer pays the monthly price for each
 * month they stay. Both after fees.
 */
export function customerValue(i: ProjectionInputs) {
  const yearly = i.yearlyPrice * i.keepRate;
  const monthly = i.monthlyPrice * i.keepRate;
  return {
    firstMonth: i.yearlyShare * yearly + (1 - i.yearlyShare) * monthly,
    firstYear: i.yearlyShare * yearly + (1 - i.yearlyShare) * monthly * i.monthsKept,
  };
}

export interface PlanPrices {
  month: { amount: number } | null;
  year: { amount: number } | null;
}

export interface StorePrices {
  monthly: number | null;
  yearly: number | null;
  keepRate: number | null;
  yearlyShare: number | null;
}

export interface PlanSources {
  stripePrices: PlanPrices | null;
  storePrices: StorePrices | null;
  stripeFeeRate: number | null;
  stripeYearlyShare: number | null;
  stripeNewCustomers: number;
  storeNewCustomers: number;
  monthsKept: number | null;
  recentYearlyPaid: number | null;
  recentMonthlyPaid: number | null;
}

export interface PlanEconomics {
  /** Share of new customers who pay on the web (Stripe) rather than in the stores. */
  webShare: number;
  monthlyPrice: number | null;
  yearlyPrice: number | null;
  keepRate: number | null;
  yearlyShare: number | null;
  monthsKept: number | null;
  sources: {
    stripeMonthly: number | null;
    stripeYearly: number | null;
    storeMonthly: number | null;
    storeYearly: number | null;
    stripeKeepRate: number | null;
    storeKeepRate: number | null;
    recentYearlyPaid: number | null;
    recentMonthlyPaid: number | null;
  };
  /** True when Stripe's price list couldn't be read (key lacks Prices access). */
  stripePricesMissing: boolean;
}

/** Weighted mix of a web and a store value; either side may be unknown. */
function blend(web: number | null, store: number | null, w: number) {
  if (web === null && store === null) return null;
  if (web === null) return store;
  if (store === null) return web;
  return w * web + (1 - w) * store;
}

const round = (n: number | null, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/**
 * Combines Stripe's and the stores' plan prices into one set of starting values,
 * weighted by where recent new customers paid.
 */
export function planEconomics(src: PlanSources): PlanEconomics {
  const totalNew = src.stripeNewCustomers + src.storeNewCustomers;
  const w = totalNew > 0 ? src.stripeNewCustomers / totalNew : 1;
  const stripeMonthly = src.stripePrices?.month?.amount ?? null;
  const stripeYearly = src.stripePrices?.year?.amount ?? null;
  const stripeKeep = src.stripeFeeRate === null ? null : 1 - src.stripeFeeRate;
  return {
    webShare: round(w, 3),
    monthlyPrice: round(blend(stripeMonthly, src.storePrices?.monthly ?? null, w)),
    yearlyPrice: round(blend(stripeYearly, src.storePrices?.yearly ?? null, w)),
    keepRate: round(blend(stripeKeep, src.storePrices?.keepRate ?? null, w), 3),
    yearlyShare: round(blend(src.stripeYearlyShare, src.storePrices?.yearlyShare ?? null, w), 3),
    monthsKept: round(src.monthsKept, 1),
    sources: {
      stripeMonthly,
      stripeYearly,
      storeMonthly: src.storePrices?.monthly ?? null,
      storeYearly: src.storePrices?.yearly ?? null,
      stripeKeepRate: round(stripeKeep, 3),
      storeKeepRate: src.storePrices?.keepRate ?? null,
      recentYearlyPaid: round(src.recentYearlyPaid),
      recentMonthlyPaid: round(src.recentMonthlyPaid),
    },
    stripePricesMissing: !src.stripePrices,
  };
}

/** When a value is unknown (no data yet), the slider starts here. */
export const PLAN_FALLBACKS = { yearlyShare: 0.3, monthsKept: 6, keepRate: 0.9 };

/** Starting slider values: what actually happened in the chosen months, at current prices. */
export function defaultInputs(base: ProjectionBase, plans: PlanEconomics): ProjectionInputs {
  return {
    metaSpend: base.metaSpend,
    googleSpend: base.googleSpend,
    visitorToTrial: base.visitorToTrial,
    trialToPaying: base.trialToPaying,
    adVisitorQuality: 1,
    yearlyShare: plans.yearlyShare ?? PLAN_FALLBACKS.yearlyShare,
    monthlyPrice: plans.monthlyPrice ?? plans.sources.recentMonthlyPaid ?? 0,
    yearlyPrice: plans.yearlyPrice ?? plans.sources.recentYearlyPaid ?? 0,
    monthsKept: plans.monthsKept ?? PLAN_FALLBACKS.monthsKept,
    keepRate: plans.keepRate ?? PLAN_FALLBACKS.keepRate,
    // Simple by default: every visit costs what it cost before, and converts
    // like any other visit (no ad attribution).
    pricier: 0,
  };
}

export interface Retention {
  /** Share of monthly customers still paying in month k+1 (monthly[0] = 1). */
  monthly: number[];
  /** Share of yearly customers who paid a second year; null with too little history. */
  yearlyRenewal: number | null;
  yearlyRenewalSample: number;
  /** Monthly-plan customers behind the curve (those at least a month old). */
  monthlySample?: number;
}

/** Below this many customers a month's share is too noisy; the curve stops dropping there. */
const MIN_RETENTION_SAMPLE = 10;

/** Turns the retention query's rows into a smooth, never-rising curve. */
export function buildRetention(
  rows: { kind: string; age: number; eligible: number; paying: number }[],
): Retention {
  const monthly: number[] = [1];
  for (let age = 2; age <= 12; age++) {
    const r = rows.find(x => x.kind === 'monthly' && Number(x.age) === age);
    const prev = monthly[monthly.length - 1];
    const share =
      r && Number(r.eligible) >= MIN_RETENTION_SAMPLE
        ? Number(r.paying) / Number(r.eligible)
        : prev;
    monthly.push(Math.min(prev, share));
  }
  const monthlySample = Math.max(
    0,
    ...rows.filter(x => x.kind === 'monthly').map(x => Number(x.eligible)),
  );
  const y = rows.find(x => x.kind === 'yearly');
  const sample = Number(y?.eligible ?? 0);
  return {
    monthly: monthly.map(v => Math.round(v * 1000) / 1000),
    yearlyRenewal: sample > 0 ? Math.round((Number(y.paying) / sample) * 1000) / 1000 : null,
    yearlyRenewalSample: sample,
    monthlySample,
  };
}

export const OUTLOOK_MONTHS = 12;

export interface OutlookMonth {
  month: number;
  /** Net income if ad spend stays as it is today. */
  today: number;
  /** Net income at the slider spend, with every month's extra customers still paying. */
  projected: number;
  /** Extra customers (from the change in spend) still paying that month. */
  extraPaying: number;
}

export interface Outlook {
  months: OutlookMonth[];
  /** Change in new paying customers per month from the slider spend. */
  extraCustomersPerMonth: number;
  /** Sum over the outlook of projected minus today. */
  extraNetIncome: number;
  /** First month in which the running total of extra net income is above zero. */
  paybackMonth: number | null;
}

/**
 * Net income for each of the next 12 months. Today's money in (existing and
 * organic customers) stays flat. Each month the slider spend adds a batch of
 * extra customers on top of today's: yearly ones pay up front (renewals fall
 * after month 12), monthly ones keep paying, dropping off along the real curve.
 */
export function outlook(
  base: ProjectionBase,
  i: ProjectionInputs,
  retention: Retention,
  baseline: ProjectionInputs = i,
): Outlook {
  const p = project(base, i, baseline);
  const extra = p.projected.newCustomers - p.today.newCustomers;
  const extraSpend = p.spend - (base.metaSpend + base.googleSpend);
  const yearly = i.yearlyPrice * i.keepRate;
  const monthly = i.monthlyPrice * i.keepRate;
  const cost = i.otherCostPerCustomerMonth ?? 0;
  const curve = (age: number) =>
    retention.monthly[Math.min(age, retention.monthly.length) - 1] ?? 0;

  const months: OutlookMonth[] = [];
  let running = 0;
  let paybackMonth: number | null = null;
  for (let t = 1; t <= OUTLOOK_MONTHS; t++) {
    let revenue = 0;
    let paying = 0;
    // Batch started in month c is (t - c + 1) months old in month t.
    for (let c = 1; c <= t; c++) {
      const age = t - c + 1;
      const monthlyStill = extra * (1 - i.yearlyShare) * curve(age);
      revenue += monthlyStill * monthly + (age === 1 ? extra * i.yearlyShare * yearly : 0);
      paying += monthlyStill + extra * i.yearlyShare;
      // Yearly customers stay active (and cost) all 12 months.
      revenue -= (monthlyStill + extra * i.yearlyShare) * cost;
    }
    const change = revenue - extraSpend;
    running += change;
    if (paybackMonth === null && running > 0 && extraSpend > 0) paybackMonth = t;
    months.push({
      month: t,
      today: p.todayNetIncome,
      projected: p.todayNetIncome + change,
      extraPaying: paying,
    });
  }
  return { months, extraCustomersPerMonth: extra, extraNetIncome: running, paybackMonth };
}
