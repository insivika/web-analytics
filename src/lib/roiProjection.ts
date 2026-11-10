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
  firstMonthValue: number;
  firstYearValue: number;
  /** Extra cost per click for each doubling of spend (0.15 = 15%). */
  pricier: number;
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
  const paid =
    paidVisitors(metaSpend, base.metaCpc, base.metaSpend, i.pricier) +
    paidVisitors(googleSpend, base.googleCpc, base.googleSpend, i.pricier);
  const organicTrials = base.organicVisitors * i.visitorToTrial;
  const paidTrials = paid * i.visitorToTrial * i.adVisitorQuality;
  const trials = organicTrials + paidTrials;
  return {
    visitors: base.organicVisitors + paid,
    paidVisitors: paid,
    trials,
    newCustomers: trials * i.trialToPaying,
  };
}

export interface Projection {
  projected: ProjectionPoint;
  today: ProjectionPoint;
  withoutAds: ProjectionPoint;
  spend: number;
  /** Net income per month: today's money in, plus first-month revenue from the
   * change in new customers, minus all ad spend. */
  netIncome: number;
  todayNetIncome: number;
  customersFromAds: number;
  costPerCustomerFromAds: number | null;
  /** First-year revenue from one month's ad-driven customers, minus that month's ad spend. */
  firstYearReturn: number;
  /** Spend far beyond anything in the history: the result is a rough guess. */
  beyondHistory: boolean;
}

export function project(base: ProjectionBase, i: ProjectionInputs): Projection {
  const projected = projectFunnel(base, i);
  const today = projectFunnel(base, i, base.metaSpend, base.googleSpend);
  const withoutAds = projectFunnel(base, i, 0, 0);
  const spend = i.metaSpend + i.googleSpend;
  const todaySpend = base.metaSpend + base.googleSpend;
  const customersFromAds = projected.newCustomers - withoutAds.newCustomers;
  return {
    projected,
    today,
    withoutAds,
    spend,
    netIncome:
      base.moneyIn +
      (projected.newCustomers - today.newCustomers) * i.firstMonthValue -
      spend -
      base.otherSpend,
    todayNetIncome: base.moneyIn - todaySpend - base.otherSpend,
    customersFromAds,
    costPerCustomerFromAds: customersFromAds > 0.01 ? spend / customersFromAds : null,
    firstYearReturn: customersFromAds * i.firstYearValue - spend,
    beyondHistory: spend > 3 * Math.max(todaySpend, 100),
  };
}

/** Starting slider values: exactly what happened in the chosen months. */
export function defaultInputs(base: ProjectionBase, value: CustomerValue): ProjectionInputs {
  return {
    metaSpend: base.metaSpend,
    googleSpend: base.googleSpend,
    visitorToTrial: base.visitorToTrial,
    trialToPaying: base.trialToPaying,
    adVisitorQuality: 1,
    firstMonthValue: value.firstMonth ?? 0,
    firstYearValue: value.firstYear ?? value.firstMonth ?? 0,
    pricier: 0.15,
  };
}
