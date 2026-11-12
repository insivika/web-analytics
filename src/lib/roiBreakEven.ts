// Break-even for ad spend (pure, unit-tested).
//
// Ads pay for themselves when the money a paid visitor brings in covers what
// the visit cost. A paid visitor is worth (chance they become a paying
// customer) × (what a paying customer brings in within N months), so the
// break-even visit-to-paying rate is cost per paid visit ÷ customer value.
//
// The visit-to-paying rate of paid visitors comes from two places:
// - measured: paying customers traced back to a paid click (signup UTMs →
//   user → first payment) ÷ paid visits old enough to have played out
// - estimated: paid visits → web signups and store taps → app signups →
//   paying customers, at the observed (or assumed) rate of each step
// The overall visitor rate is never used for ads: organic and blog traffic
// dilute it.

import {
  defaultInputs,
  type PlanEconomics,
  PROJECTION_WINDOWS,
  type ProjectionBase,
  type ProjectionInputs,
  type ProjectionMonth,
  type ProjectionWindow,
  projectionBase,
  type Retention,
} from './roiProjection';

export const PAYBACK_WINDOWS = [1, 3, 6, 12] as const;
export type PaybackWindow = (typeof PAYBACK_WINDOWS)[number];

/** Month key of the rolling window's rows in ChannelData. */
export const LAST_30_DAYS = 'last30';
export const ROLLING_DAYS = 30;
/** How far back the inputs go: completed months, or the rolling last 30 days. */
export type Lookback = ProjectionWindow | typeof LAST_30_DAYS;
export const LOOKBACKS: Lookback[] = [LAST_30_DAYS, ...PROJECTION_WINDOWS];
/** Completed months a lookback draws on (the rolling window uses the last one). */
export const lookbackMonths = (l: Lookback) => (l === LAST_30_DAYS ? 1 : l);

export const CHANNELS = ['meta', 'google'] as const;
export type Channel = (typeof CHANNELS)[number];
export type ChannelKey = Channel | 'blended';

/** Trial plus first billing: a paid visit younger than this can't have paid yet. */
export const MATURE_DAYS = 17;
/** From this many traced paying customers on, the measured rate replaces the estimate. */
export const MIN_MEASURED_PAYERS = 10;
/** Fewer paid visits than this in the chosen months: too little to judge. */
export const MIN_PAID_VISITS = 50;
/** Completed months behind the trial-to-paying rate (at least; more with a longer lookback). */
export const TRIAL_TO_PAYING_MONTHS = 6;
/** A trial counts toward trial-to-paying once it's this old (14-day trial + billing). */
export const TRIAL_MATURE_DAYS = 30;
/** A trial converted if its user's first payment came within this many days of the start. */
export const PAID_WITHIN_DAYS = 45;

/** Trials started in a month (old enough to judge) and how many of those users paid. */
export interface TrialCohort {
  month: string;
  trials: number;
  paid: number;
}

/**
 * Trial-to-paying over the cohorts of the given months; null without trials.
 * Store purchases only carry a user id since Oct 2026, so older app trials
 * that paid in the store are missed and this reads slightly low.
 */
export function cohortTrialToPaying(cohorts: TrialCohort[], months: string[]) {
  const set = new Set(months);
  const rows = cohorts.filter(c => set.has(c.month));
  const trials = rows.reduce((s, c) => s + c.trials, 0);
  const paid = rows.reduce((s, c) => s + c.paid, 0);
  return trials > 0 ? { rate: paid / trials, trials, paid } : null;
}

/** A month counts as having ad spend from this much on. */
export const MEANINGFUL_SPEND = 50;
/** Ad-acquired customers needed before their own retention is shown. */
export const MIN_AD_RETENTION_CUSTOMERS = 20;
/**
 * Share of store-badge taps that end in an app signup, when it can't be
 * observed. Roughly a store page's install rate (~30%) times installs that
 * sign up (~65%). Observed app signups ÷ taps overstates it, because many app
 * signups come from App Store and Play search, not from the website.
 */
export const DEFAULT_TAP_TO_SIGNUP = 0.2;

/** One month of paid website traffic for one channel. */
export interface ChannelMonth {
  month: string;
  channel: Channel;
  /** Paid landing visits (first page of a session, bots and app sessions left out). */
  visits: number;
  /** Paid visits at least MATURE_DAYS old. */
  matureVisits: number;
  /** Paid visits that tapped an App Store or Google Play badge. */
  taps: number;
  /** Paid visits that signed up on the web. */
  webSignups: number;
  /** Paying customers traced back to a paid signup at least MATURE_DAYS old. */
  payers: number;
}

/** Store taps and app signups from all traffic, for the observed tap-to-signup ceiling. */
export interface AppMonth {
  month: string;
  taps: number;
  appSignups: number;
}

export interface ChannelData {
  /** Per calendar month, plus rows keyed LAST_30_DAYS for the rolling window. */
  months: ChannelMonth[];
  app: AppMonth[];
  /** Website-campaign spend over the rolling window. */
  last30Spend?: { meta: number; google: number };
  /** Paying customers traced to a paid click, all time, and those with 3+ months of history. */
  adCustomers: number;
  adCustomersThreeMonths: number;
  /** Retention of ad-acquired customers, once there are enough of them. */
  adRetention: Retention | null;
}

export interface BreakEvenSettings {
  /** Hosting, email etc. per paying customer per month, subtracted from their value. */
  otherCostPerCustomerMonth: number;
  /** Fixed costs per month, shown in net income only (they don't change per customer). */
  fixedMonthlyCosts: number;
  /** Store tap → app signup; null uses DEFAULT_TAP_TO_SIGNUP. */
  tapToSignup: number | null;
}

export const DEFAULT_SETTINGS: BreakEvenSettings = {
  otherCostPerCustomerMonth: 0,
  fixedMonthlyCosts: 0,
  tapToSignup: null,
};

/** What a new paying customer brings in, month by month. */
export interface ValueModel {
  yearlyShare: number;
  /** Net of fees, per payment. */
  yearlyNet: number;
  monthlyNet: number;
  /** Share of monthly customers still paying in month k+1 (curve[0] = 1). */
  curve: number[];
  otherCostPerCustomerMonth: number;
}

export function valueModel(
  i: Pick<ProjectionInputs, 'yearlyShare' | 'yearlyPrice' | 'monthlyPrice' | 'keepRate'>,
  retention: Retention,
  otherCostPerCustomerMonth = 0,
): ValueModel {
  return {
    yearlyShare: i.yearlyShare,
    yearlyNet: i.yearlyPrice * i.keepRate,
    monthlyNet: i.monthlyPrice * i.keepRate,
    curve: retention.monthly.length ? retention.monthly : [1],
    otherCostPerCustomerMonth,
  };
}

/** Share of monthly customers still paying in their month `age` (1-based). */
const still = (curve: number[], age: number) => curve[Math.min(age, curve.length) - 1] ?? 0;

/**
 * Expected net money in from one new paying customer during their first
 * `months` months (1–12): a yearly customer pays up front (a renewal only
 * comes in month 13), a monthly customer pays each month they're still there.
 * Per-customer costs are taken off for every month the customer is active.
 */
export function customerValueWithin(m: ValueModel, months: number): number {
  const n = Math.max(1, Math.min(12, Math.round(months)));
  const cost = m.otherCostPerCustomerMonth;
  let monthlyMonths = 0;
  for (let age = 1; age <= n; age++) monthlyMonths += still(m.curve, age);
  const yearly = m.yearlyNet - cost * n;
  const monthly = (m.monthlyNet - cost) * monthlyMonths;
  return m.yearlyShare * yearly + (1 - m.yearlyShare) * monthly;
}

/** Visit-to-paying rate at which a paid visit pays for itself; null when it never can. */
export function breakEvenRate(costPerVisit: number | null, value: number): number | null {
  if (costPerVisit === null || costPerVisit <= 0) return null;
  return value > 0 ? costPerVisit / value : null;
}

export interface FunnelCounts {
  visits: number;
  taps: number;
  webSignups: number;
}

export interface EstimatedConversion {
  /** Visit → paying customer; null without paid visits. */
  rate: number | null;
  webSignupRate: number;
  tapRate: number;
  tapToSignup: number;
  trialToPaying: number;
  /** Visit → any signup (web, or app via a store tap). */
  signupRate: number;
}

/**
 * Paid visits × (web signups + store taps × tap-to-signup) ÷ visits ×
 * trial-to-paying. Every signup starts a trial, so signups and trials are the
 * same step here.
 */
export function estimatedPaidConversion(
  c: FunnelCounts,
  tapToSignup: number,
  trialToPaying: number,
): EstimatedConversion {
  const webSignupRate = c.visits > 0 ? c.webSignups / c.visits : 0;
  const tapRate = c.visits > 0 ? c.taps / c.visits : 0;
  const signupRate = webSignupRate + tapRate * tapToSignup;
  return {
    rate: c.visits > 0 ? signupRate * trialToPaying : null,
    webSignupRate,
    tapRate,
    tapToSignup,
    trialToPaying,
    signupRate,
  };
}

export interface MeasuredConversion {
  rate: number | null;
  payers: number;
  matureVisits: number;
  /** Some paid visits in the chosen months are too recent to have paid yet. */
  immature: boolean;
}

export function measuredConversion(c: {
  payers: number;
  matureVisits: number;
  visits: number;
}): MeasuredConversion {
  return {
    rate: c.matureVisits > 0 ? c.payers / c.matureVisits : null,
    payers: c.payers,
    matureVisits: c.matureVisits,
    immature: c.matureVisits < c.visits,
  };
}

export type Status = 'profitable' | 'notYet' | 'notEnoughData';

export interface ChannelEconomics {
  key: ChannelKey;
  spend: number;
  visits: number;
  costPerVisit: number | null;
  /** Break-even visit-to-paying rate for each payback window. */
  breakEven: Record<PaybackWindow, number | null>;
  measured: MeasuredConversion;
  estimated: EstimatedConversion;
  /** The rate everything else uses: measured once it has enough payers. */
  rate: number | null;
  rateSource: 'measured' | 'estimated';
  /** Most a paying customer may cost for the window to pay back. */
  maxCac: Record<PaybackWindow, number>;
  /** Spend ÷ traced paying customers; null with none traced yet. */
  actualCac: number | null;
  /** Money in within the window per dollar of spend, at `rate`. */
  roas: Record<PaybackWindow, number | null>;
  status: Record<PaybackWindow, Status>;
}

const byWindow = <T>(f: (n: PaybackWindow) => T) =>
  Object.fromEntries(PAYBACK_WINDOWS.map(n => [n, f(n)])) as Record<PaybackWindow, T>;

function economics(
  key: ChannelKey,
  totals: FunnelCounts & { spend: number; matureVisits: number; payers: number },
  values: Record<PaybackWindow, number>,
  tapToSignup: number,
  trialToPaying: number,
): ChannelEconomics {
  const costPerVisit = totals.visits > 0 && totals.spend > 0 ? totals.spend / totals.visits : null;
  const measured = measuredConversion(totals);
  const estimated = estimatedPaidConversion(totals, tapToSignup, trialToPaying);
  const useMeasured = measured.payers >= MIN_MEASURED_PAYERS && measured.rate !== null;
  const rate = useMeasured ? measured.rate : estimated.rate;
  const breakEven = byWindow(n => breakEvenRate(costPerVisit, values[n]));
  const thin = totals.visits < MIN_PAID_VISITS || costPerVisit === null || rate === null;
  return {
    key,
    spend: totals.spend,
    visits: totals.visits,
    costPerVisit,
    breakEven,
    measured,
    estimated,
    rate,
    rateSource: useMeasured ? 'measured' : 'estimated',
    maxCac: byWindow(n => Math.max(values[n], 0)),
    actualCac: totals.payers > 0 ? totals.spend / totals.payers : null,
    roas: byWindow(n =>
      costPerVisit !== null && rate !== null ? (rate * values[n]) / costPerVisit : null,
    ),
    status: byWindow(n => {
      if (thin) return 'notEnoughData';
      const be = breakEven[n];
      return be !== null && (rate as number) >= be ? 'profitable' : 'notYet';
    }),
  };
}

/** Net income per $100 of ads within the value's window, at a visit-to-paying rate. */
export function netPer100(costPerVisit: number, rate: number, value: number) {
  return (100 / costPerVisit) * rate * value - 100;
}

/** Money in within the value's window from $100 of ads (before taking the $100 off). */
export function returnPer100(costPerVisit: number | null, rate: number | null, value: number) {
  if (costPerVisit === null || rate === null || costPerVisit <= 0) return null;
  return (100 / costPerVisit) * rate * value;
}

export interface SensitivityPoint {
  rate: number;
  net: number;
}

/** Net income per $100 of ads for visit-to-paying rates from 0 to `maxRate`. */
export function sensitivity(
  costPerVisit: number | null,
  value: number,
  maxRate = 0.05,
  steps = 50,
): SensitivityPoint[] {
  if (costPerVisit === null || costPerVisit <= 0) return [];
  return Array.from({ length: steps + 1 }, (_, k) => {
    const rate = (maxRate * k) / steps;
    return { rate, net: netPer100(costPerVisit, rate, value) };
  });
}

export interface Economics {
  /** The chosen lookback: completed months, or the rolling last 30 days. */
  lookback: Lookback;
  /** Completed months behind money in, visitors and plan economics. */
  months: string[];
  base: ProjectionBase;
  inputs: ProjectionInputs;
  model: ValueModel;
  /** Value of a new paying customer within each payback window. */
  value: Record<PaybackWindow, number>;
  channels: Record<ChannelKey, ChannelEconomics>;
  tapToSignup: { value: number; assumed: boolean; observedCeiling: number | null };
  trialToPaying: number;
  /** The trial cohorts behind trialToPaying; null when it fell back to the same-month ratio. */
  trialCohort: { trials: number; paid: number; months: string[] } | null;
  /** Completed months (all history) with meaningful ad spend. */
  adMonths: number;
  settings: BreakEvenSettings;
}

const add = (rows: ChannelMonth[]) =>
  rows.reduce(
    (s, r) => ({
      visits: s.visits + r.visits,
      matureVisits: s.matureVisits + r.matureVisits,
      taps: s.taps + r.taps,
      webSignups: s.webSignups + r.webSignups,
      payers: s.payers + r.payers,
    }),
    { visits: 0, matureVisits: 0, taps: 0, webSignups: 0, payers: 0 },
  );

/**
 * Everything the break-even panel and the "what if" simulator share, for the
 * last `lookback` completed months.
 */
export function buildEconomics(
  history: ProjectionMonth[],
  data: ChannelData,
  plans: PlanEconomics,
  retention: Retention,
  lookback: Lookback,
  settings: BreakEvenSettings,
  trialCohorts: TrialCohort[] = [],
): Economics {
  // The rolling window covers paid traffic and spend; money in, visitors and
  // plan economics only exist per month, so they come from the last completed one.
  const rolling = lookback === LAST_30_DAYS;
  const months = lookbackMonths(lookback);
  const recentSpend = data.last30Spend ?? { meta: 0, google: 0 };
  const completed = projectionBase(history, months);
  const base = rolling
    ? { ...completed, metaSpend: recentSpend.meta, googleSpend: recentSpend.google }
    : completed;
  // Trial-to-paying over at least TRIAL_TO_PAYING_MONTHS: a single month's
  // trials haven't all had the chance to pay yet, so a short window swings.
  const ttpMonths = history.slice(-Math.max(months, TRIAL_TO_PAYING_MONTHS)).map(m => m.month);
  const cohort = cohortTrialToPaying(trialCohorts, ttpMonths);
  const trialToPaying =
    cohort?.rate ?? projectionBase(history, Math.max(months, TRIAL_TO_PAYING_MONTHS)).trialToPaying;
  const inputs = defaultInputs(base, plans);
  const model = valueModel(inputs, retention, settings.otherCostPerCustomerMonth);
  const value = byWindow(n => customerValueWithin(model, n));
  const inWindow = new Set(rolling ? [LAST_30_DAYS] : base.months);

  const app = data.app.filter(a => inWindow.has(a.month));
  const appTaps = app.reduce((s, a) => s + a.taps, 0);
  const appSignups = app.reduce((s, a) => s + a.appSignups, 0);
  const observedCeiling = appTaps > 0 ? Math.min(appSignups / appTaps, 1) : null;
  const tapToSignup = settings.tapToSignup ?? DEFAULT_TAP_TO_SIGNUP;

  const window = history.slice(-months);
  const spend = rolling
    ? recentSpend
    : {
        meta: window.reduce((s, m) => s + m.metaSpend, 0),
        google: window.reduce((s, m) => s + m.googleSpend, 0),
      };
  const totals = Object.fromEntries(
    CHANNELS.map(c => [
      c,
      {
        ...add(data.months.filter(r => r.channel === c && inWindow.has(r.month))),
        spend: spend[c],
      },
    ]),
  ) as Record<Channel, ReturnType<typeof add> & { spend: number }>;
  const blendedTotals = {
    visits: totals.meta.visits + totals.google.visits,
    matureVisits: totals.meta.matureVisits + totals.google.matureVisits,
    taps: totals.meta.taps + totals.google.taps,
    webSignups: totals.meta.webSignups + totals.google.webSignups,
    payers: totals.meta.payers + totals.google.payers,
    spend: spend.meta + spend.google,
  };

  const make = (key: ChannelKey, t: typeof blendedTotals) =>
    economics(key, t, value, tapToSignup, trialToPaying);

  return {
    lookback,
    months: base.months,
    base,
    inputs,
    model,
    value,
    channels: {
      meta: make('meta', totals.meta),
      google: make('google', totals.google),
      // Blended cost per visit is total spend over total paid visits, i.e. the
      // channels weighted by where the money goes.
      blended: make('blended', blendedTotals),
    },
    tapToSignup: { value: tapToSignup, assumed: settings.tapToSignup === null, observedCeiling },
    trialToPaying,
    trialCohort: cohort ? { trials: cohort.trials, paid: cohort.paid, months: ttpMonths } : null,
    adMonths: history.filter(m => m.metaSpend + m.googleSpend + m.otherSpend >= MEANINGFUL_SPEND)
      .length,
    settings,
  };
}

/** Break-even of a channel if its cost per visit changed to `costPerVisit`. */
export function breakEvenAtCost(costPerVisit: number, value: number) {
  return breakEvenRate(costPerVisit, value);
}

/** Customer value within `months` if `yearlyShare` of new customers chose yearly. */
export function valueWithYearlyShare(m: ValueModel, yearlyShare: number, months: number) {
  return customerValueWithin({ ...m, yearlyShare }, months);
}

/** The four levers behind "does $100 of ads pay off": visitor → trial, trial → paying, cost per visitor, customer value. */
export interface Levers {
  trial: number;
  paying: number;
  costPerVisit: number;
  value: number;
}

/**
 * Where each lever has to be for $100 of ads to bring back $100, with the
 * other three left where they are. Null when the others make it impossible.
 */
export function leverBreakEven(l: Levers): Record<keyof Levers, number | null> {
  const { trial, paying, costPerVisit, value } = l;
  const ok = (n: number) => (Number.isFinite(n) && n > 0 ? n : null);
  return {
    trial: ok(costPerVisit / (paying * value)),
    paying: ok(costPerVisit / (trial * value)),
    costPerVisit: ok(trial * paying * value),
    value: ok(costPerVisit / (trial * paying)),
  };
}
