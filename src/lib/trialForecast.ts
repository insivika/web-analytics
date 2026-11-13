// Projected conversions: how many current trial users will become paying
// customers in the next 7 and 14 days, and what that first payment is worth.
//
// Cash Flow Calendar runs its own 14-day trial (no store or Stripe trial, no
// payment method on file), and most people buy in the two weeks AFTER the trial
// ends. So the forecast is behavior-based:
//
//   1. A segment model gives each user's eventual conversion probability `p`
//      from early behavior (active days in the first 3 trial days x activated in
//      them), smoothed toward the overall rate (Bayesian / empirical-Bayes).
//   2. A timing curve F(d) says what share of eventual conversions has happened
//      by day d after trial start (prior shape, updated by observed conversions).
//   3. For a user at elapsed day t who hasn't converted yet:
//        P(convert in (t, t+h]) = p * (F(t+h) - F(t)) / (1 - p * F(t))
//   4. The headline range is a Monte Carlo sum of Bernoulli trials (P10-P90).
//
// Everything here is pure and unit-tested; the SQL layer only fetches rows.

import { addDays } from './ads/fx';
import {
  DAY_MS,
  getWeekStart,
  type TrialActivityRow,
  type TrialSettings,
  type TrialUser,
} from './trial';

export interface ForecastSettings {
  /** Days after trial end in which a purchase still counts (conversions run to ~day 29). */
  postTrialDays: number;
  /** Behavior features are read from the first N trial days. */
  earlyDays: number;
  /** Pseudo-observations pulling each segment toward the overall rate. */
  priorStrength: number;
  /** Pseudo-conversions pulling the observed timing curve toward the prior shape. */
  timingPriorStrength: number;
  simulations: number;
  monthlyPriceUsd: number;
  annualPriceUsd: number;
}

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = {
  postTrialDays: 16,
  earlyDays: 3,
  priorStrength: 10,
  timingPriorStrength: 10,
  simulations: 5000,
  monthlyPriceUsd: 12,
  annualPriceUsd: 108,
};

export const FORECAST_HORIZONS = [7, 14] as const;

/** Swap for logistic regression once there are >= this many conversions. */
export const MIN_CONVERSIONS_FOR_REGRESSION = 50;

// ---------------------------------------------------------------------------
// Features

export interface ForecastFeatures {
  /** Distinct active days among trial days 1..earlyDays (as of the cutoff). */
  earlyActiveDays: number;
  /** activation event within the first earlyDays trial days (as of the cutoff). */
  earlyActivated: boolean;
}

export interface ForecastUser extends ForecastFeatures {
  userId: string;
  trialStart: string;
  platform: string | null;
  isInternal: boolean;
  activeDays: number;
  activated: boolean;
  recurringCreated: boolean;
  paywallShown: boolean;
  pushEligible: boolean;
  pushOptIn: boolean;
  engagementCount: number;
  convertedAt: string | null;
  /**
   * Converted through a paid subscription status (Trial settings → paid
   * statuses) without a dated conversion event. Excluded from training and from
   * the forecast, because the conversion is real but its timing is unknown.
   */
  undatedConversion: boolean;
  /** monthly / annual, from the conversion event. */
  plan: string | null;
}

const milestoneIndex = (settings: TrialSettings, event: string) =>
  settings.milestones.findIndex(step => step.includes(event));

/**
 * Early features as of `cutoff`: only activity inside the first `earlyDays`
 * trial days that was recorded before the cutoff counts, so a back-test never
 * sees the future.
 */
export function computeEarlyFeatures(
  userId: string,
  trialStart: Date,
  activity: TrialActivityRow[],
  settings: TrialSettings,
  earlyDays: number,
  cutoff: Date,
): ForecastFeatures {
  const days = new Set<number>();
  let activated = false;
  for (const row of activity) {
    if (row.userId !== userId) continue;
    const day = Number(row.day);
    if (day < 0 || day >= earlyDays) continue;
    const at = row.firstAt ? +new Date(row.firstAt) : +trialStart + day * DAY_MS;
    if (at >= +cutoff) continue;
    if (row.eventName === settings.activeDayEvent) days.add(day);
    if (row.eventName === settings.activationEvent) activated = true;
  }
  return { earlyActiveDays: days.size, earlyActivated: activated };
}

/** Joins Trial report users with early features and the purchased plan. */
export function buildForecastUsers(
  users: TrialUser[],
  activity: TrialActivityRow[],
  plans: Map<string, string>,
  settings: TrialSettings,
  earlyDays: number,
  cutoff: Date,
): ForecastUser[] {
  const byUser = new Map<string, TrialActivityRow[]>();
  for (const row of activity) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }
  const recurring = milestoneIndex(settings, 'first_recurring_event_created');
  const paywall = milestoneIndex(settings, 'paywall_shown');

  return users.map(u => ({
    userId: u.userId,
    trialStart: u.trialStart,
    platform: u.platform,
    isInternal: u.isInternal,
    activeDays: u.activeDays,
    activated: u.activated,
    recurringCreated: recurring >= 0 && !!u.milestones[recurring],
    paywallShown: paywall >= 0 && !!u.milestones[paywall],
    pushEligible: u.pushEligible,
    pushOptIn: u.pushOptIn,
    engagementCount: u.engagementCount,
    convertedAt: u.convertedAt,
    undatedConversion: u.converted && !u.convertedAt,
    plan: plans.get(u.userId) ?? null,
    ...computeEarlyFeatures(
      u.userId,
      new Date(u.trialStart),
      byUser.get(u.userId) ?? [],
      settings,
      earlyDays,
      cutoff,
    ),
  }));
}

// ---------------------------------------------------------------------------
// Timing curve

export interface TimingCurve {
  /** Share of eventual conversions on each day after trial start (sums to 1). */
  daily: number[];
  /** Observed conversions the curve is based on. */
  n: number;
}

/**
 * Prior shape for when people buy: a few during the trial, a peak at trial end
 * (access stops), then a decaying tail through the post-trial window.
 */
export function priorTimingWeights(trialLengthDays: number, postTrialDays: number): number[] {
  const total = trialLengthDays + postTrialDays;
  const w = Array.from({ length: total }, (_, d) => {
    if (d < trialLengthDays - 1) return 0.1 / Math.max(trialLengthDays - 1, 1);
    if (d <= trialLengthDays) return 0.2;
    return 0;
  });
  const tail = Array.from({ length: total - trialLengthDays - 1 }, (_, i) => total - i);
  const tailSum = tail.reduce((s, x) => s + x, 0) || 1;
  tail.forEach((x, i) => {
    w[trialLengthDays + 1 + i] += (0.5 * x) / tailSum;
  });
  const sum = w.reduce((s, x) => s + x, 0);
  return w.map(x => x / sum);
}

export interface TimingEntry {
  /** Days observed so far (elapsed at the as-of date, capped at the window). */
  elapsed: number;
  /** Day of conversion after trial start, or null if not converted (yet). */
  convertedDay: number | null;
}

/** Rate used for the prior hazard when no trial has completed its window yet. */
export const DEFAULT_PRIOR_RATE = 0.1;

/**
 * When people buy, corrected for censoring (Kaplan–Meier style). Recent trials
 * haven't reached their late days yet, so simply counting conversion days
 * would make purchases look earlier than they are. Instead, a daily hazard
 *   h_d = (conversions on day d + k * prior hazard) / (users at risk on day d + k)
 * uses only trials that actually reached day d; days nobody reached yet fall
 * back to the prior shape. The curve is the resulting conversion mass per day,
 * normalized over the window.
 */
export function fitTimingCurve(
  entries: TimingEntry[],
  trialLengthDays: number,
  postTrialDays: number,
  strength: number,
): TimingCurve {
  const prior = priorTimingWeights(trialLengthDays, postTrialDays);
  const total = prior.length;
  const complete = entries.filter(e => e.elapsed >= total);
  const priorRate = complete.length
    ? Math.max(complete.filter(e => e.convertedDay !== null).length / complete.length, 0.01)
    : DEFAULT_PRIOR_RATE;

  const atRisk = prior.map(() => 0);
  const events = prior.map(() => 0);
  let n = 0;
  for (const e of entries) {
    const day = e.convertedDay === null ? null : Math.floor(e.convertedDay);
    const converted = day !== null && day >= 0 && day < total;
    if (converted) {
      events[day] += 1;
      n += 1;
    }
    const lastDay = converted ? day : Math.min(Math.ceil(e.elapsed), total) - 1;
    for (let d = 0; d <= lastDay; d++) atRisk[d] += 1;
  }

  let priorCdf = 0;
  let survival = 1;
  const mass = prior.map((w, d) => {
    const priorHazard = Math.min((priorRate * w) / Math.max(1 - priorRate * priorCdf, 1e-9), 1);
    priorCdf += w;
    const hazard = (events[d] + strength * priorHazard) / (atRisk[d] + strength);
    const m = survival * hazard;
    survival *= 1 - hazard;
    return m;
  });
  const sum = mass.reduce((a, b) => a + b, 0);
  return { daily: sum > 0 ? mass.map(m => m / sum) : prior, n };
}

/** F(t): share of eventual conversions by elapsed day t (linear within a day). */
export function timingCdf(curve: TimingCurve, t: number): number {
  if (t <= 0) return 0;
  const { daily } = curve;
  if (t >= daily.length) return 1;
  const whole = Math.floor(t);
  let sum = 0;
  for (let d = 0; d < whole; d++) sum += daily[d];
  return Math.min(1, sum + (t - whole) * daily[whole]);
}

// ---------------------------------------------------------------------------
// Behavior model (behind an interface so it can become logistic regression)

export interface ConversionPrediction {
  /** Eventual conversion probability within the conversion window. */
  p: number;
  segment: string;
  /** Training users in the segment. */
  n: number;
}

export interface ConversionModel {
  id: string;
  baseRate: number;
  /** Training users and conversions the model was fit on. */
  n: number;
  conversions: number;
  predict(features: ForecastFeatures): ConversionPrediction;
  segments: SegmentRate[];
}

export interface TrainingRow {
  features: ForecastFeatures;
  converted: boolean;
  /** F(elapsed): share of eventual conversions that could already be observed. */
  exposure: number;
}

export interface SegmentRate {
  segment: string;
  n: number;
  conversions: number;
  /** Censoring-adjusted raw rate (conversions / exposure), null when no exposure. */
  raw: number | null;
  smoothed: number;
}

export function segmentOf(f: ForecastFeatures): string {
  const days = f.earlyActiveDays >= 3 ? '3' : f.earlyActiveDays === 2 ? '2' : '0-1';
  return `${days}|${f.earlyActivated ? 'activated' : 'not-activated'}`;
}

/** Bayesian smoothing: (x + k * base) / (n + k). */
export function smoothRate(conversions: number, exposure: number, base: number, k: number) {
  const denom = exposure + k;
  return denom > 0 ? Math.min(1, Math.max(0, (conversions + k * base) / denom)) : base;
}

/**
 * Conversion rate per segment. Trials still inside their window may convert
 * later, so each counts with exposure F(elapsed) instead of 1 (expected-count
 * estimator): p = conversions / sum(F(elapsed)).
 */
export function fitSegmentModel(rows: TrainingRow[], priorStrength: number): ConversionModel {
  const exposure = rows.reduce((s, r) => s + r.exposure, 0);
  const conversions = rows.filter(r => r.converted).length;
  const baseRate = exposure > 0 ? Math.min(1, conversions / exposure) : 0;
  const groups = new Map<string, { n: number; conversions: number; exposure: number }>();

  for (const r of rows) {
    const key = segmentOf(r.features);
    const g = groups.get(key) ?? { n: 0, conversions: 0, exposure: 0 };
    g.n += 1;
    g.exposure += r.exposure;
    if (r.converted) g.conversions += 1;
    groups.set(key, g);
  }

  const segments: SegmentRate[] = [...groups]
    .map(([segment, g]) => ({
      segment,
      n: g.n,
      conversions: g.conversions,
      raw: g.exposure > 0 ? Math.min(1, g.conversions / g.exposure) : null,
      smoothed: smoothRate(g.conversions, g.exposure, baseRate, priorStrength),
    }))
    .sort((a, b) => (a.segment < b.segment ? -1 : 1));
  const bySegment = new Map(segments.map(s => [s.segment, s]));

  return {
    id: 'segment-v1',
    baseRate,
    n: rows.length,
    conversions,
    segments,
    predict(features) {
      const segment = segmentOf(features);
      const s = bySegment.get(segment);
      return { p: s ? s.smoothed : baseRate, segment, n: s?.n ?? 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-user probability

export interface UserProbability {
  /** Eventual conversion probability (given not converted yet). */
  pTotal: number;
  /** Conversion probability within each horizon. */
  p7: number;
  p14: number;
  segment: string;
  segmentN: number;
}

/**
 * Before the early-feature window has passed, the segment is based on partial
 * behavior, so it is blended with the overall rate (weight = share of the
 * window observed).
 */
export function userProbability(
  model: ConversionModel,
  curve: TimingCurve,
  features: ForecastFeatures,
  elapsedDays: number,
  earlyDays: number,
  horizons: readonly number[] = FORECAST_HORIZONS,
): UserProbability & { horizons: number[] } {
  const pred = model.predict(features);
  const w = Math.min(Math.max(elapsedDays / earlyDays, 0), 1);
  const p = w * pred.p + (1 - w) * model.baseRate;
  const f = timingCdf(curve, elapsedDays);
  const remaining = 1 - p * f;
  const within = (h: number) =>
    remaining > 0 ? (p * (timingCdf(curve, elapsedDays + h) - f)) / remaining : 0;
  const hs = horizons.map(within);

  return {
    pTotal: remaining > 0 ? (p * (1 - f)) / remaining : 0,
    p7: within(7),
    p14: within(14),
    segment: pred.segment,
    segmentN: pred.n,
    horizons: hs,
  };
}

// ---------------------------------------------------------------------------
// Simulation

/** Small deterministic PRNG so ranges don't jump between page loads. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulationRange {
  expected: number;
  low: number;
  high: number;
}

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : 0;

/**
 * Sum of independent Bernoulli(p_i) trials (optionally weighted by value_i),
 * simulated `runs` times. Returns the exact expectation and the P10-P90 range.
 */
export function simulateSum(
  probabilities: number[],
  values?: number[],
  runs = DEFAULT_FORECAST_SETTINGS.simulations,
  seed = 42,
): SimulationRange {
  const v = values ?? probabilities.map(() => 1);
  const expected = probabilities.reduce((s, p, i) => s + p * v[i], 0);
  if (!probabilities.length) return { expected: 0, low: 0, high: 0 };
  const rand = mulberry32(seed);
  const sums: number[] = new Array(runs);
  for (let r = 0; r < runs; r++) {
    let s = 0;
    for (let i = 0; i < probabilities.length; i++) if (rand() < probabilities[i]) s += v[i];
    sums[r] = s;
  }
  sums.sort((a, b) => a - b);
  return { expected, low: quantile(sums, 0.1), high: quantile(sums, 0.9) };
}

// ---------------------------------------------------------------------------
// Revenue per conversion

export interface RevenueTxnLike {
  source: string;
  kind: string;
  grossUsd: number | null;
  netUsd: number | null;
}

export interface FirstPaymentValue {
  /** Expected first payment per conversion, by platform. */
  byPlatform: Record<string, number>;
  monthlyShare: number;
  /**
   * Net of store/Stripe fees from synced transactions, gross list price when
   * nothing is synced, or partial when only one provider has transactions
   * (that provider's platforms are net, the others gross).
   */
  basis: 'net' | 'gross' | 'partial';
  netRatio: { stripe: number | null; revenuecat: number | null };
}

/**
 * Expected first payment = plan mix x list price x net ratio. The plan mix
 * comes from conversion events (smoothed toward 50/50 with 2 pseudo-counts);
 * the net ratio from real Stripe/RevenueCat transactions (same data as ROI).
 */
export function computeFirstPaymentValue(
  plans: (string | null)[],
  txns: RevenueTxnLike[],
  settings: ForecastSettings,
): FirstPaymentValue {
  const monthly = plans.filter(p => p === 'monthly').length;
  const annual = plans.filter(p => p === 'annual').length;
  const monthlyShare = (monthly + 1) / (monthly + annual + 2);
  const gross =
    monthlyShare * settings.monthlyPriceUsd + (1 - monthlyShare) * settings.annualPriceUsd;

  const ratio = (source: string, kinds: string[]) => {
    const rows = txns.filter(
      t =>
        t.source === source && kinds.includes(t.kind) && (t.grossUsd ?? 0) > 0 && t.netUsd !== null,
    );
    const g = rows.reduce((s, t) => s + (t.grossUsd ?? 0), 0);
    const n = rows.reduce((s, t) => s + (t.netUsd ?? 0), 0);
    return g > 0 ? Math.min(1, Math.max(0, n / g)) : null;
  };
  const stripe = ratio('stripe', ['payment']);
  const revenuecat = ratio('revenuecat', ['subscription', 'payment']);
  // A provider without synced transactions stays at gross: borrowing the other
  // provider's ratio would apply Stripe's ~3% fee to app-store sales (~30%).
  const basis =
    stripe !== null && revenuecat !== null
      ? 'net'
      : stripe === null && revenuecat === null
        ? 'gross'
        : 'partial';
  const web = gross * (stripe ?? 1);
  const app = gross * (revenuecat ?? 1);

  return {
    byPlatform: { web, ios: app, android: app, unknown: Math.min(web, app) },
    monthlyShare,
    basis,
    netRatio: { stripe, revenuecat },
  };
}

// ---------------------------------------------------------------------------
// Training set and back-test

export interface ForecastWindow {
  trialLengthDays: number;
  postTrialDays: number;
}

const elapsedDaysAt = (trialStart: string, at: Date) => (+at - +new Date(trialStart)) / DAY_MS;

/**
 * Users whose early-feature window had passed by `asOf`, labeled with what was
 * known at `asOf`. Conversions after the window don't count.
 */
export function buildTrainingRows(
  users: ForecastUser[],
  curve: TimingCurve,
  asOf: Date,
  window: ForecastWindow,
  earlyDays: number,
  featuresAt?: (u: ForecastUser) => ForecastFeatures,
): TrainingRow[] {
  const total = window.trialLengthDays + window.postTrialDays;
  return users
    .filter(u => elapsedDaysAt(u.trialStart, asOf) >= earlyDays)
    .map(u => {
      const elapsed = Math.min(elapsedDaysAt(u.trialStart, asOf), total);
      const convertedDay = u.convertedAt
        ? elapsedDaysAt(u.trialStart, new Date(u.convertedAt))
        : null;
      const converted =
        convertedDay !== null && convertedDay < total && +new Date(u.convertedAt) < +asOf;
      return {
        features: featuresAt ? featuresAt(u) : u,
        converted,
        exposure: timingCdf(curve, elapsed),
      };
    });
}

/** What was known about each trial's conversion timing at `asOf`. */
export function timingEntries(
  users: ForecastUser[],
  asOf: Date,
  window: ForecastWindow,
): TimingEntry[] {
  const total = window.trialLengthDays + window.postTrialDays;
  return users
    .filter(u => +new Date(u.trialStart) < +asOf)
    .map(u => {
      const known = u.convertedAt && +new Date(u.convertedAt) < +asOf;
      return {
        elapsed: Math.min(elapsedDaysAt(u.trialStart, asOf), total),
        convertedDay: known ? elapsedDaysAt(u.trialStart, new Date(u.convertedAt)) : null,
      };
    });
}

/** Fits the timing curve and segment model on data known at `asOf`. */
export function fitForecastModel(
  users: ForecastUser[],
  asOf: Date,
  window: ForecastWindow,
  settings: ForecastSettings,
  featuresAt?: (u: ForecastUser) => ForecastFeatures,
) {
  const known = users.filter(u => +new Date(u.trialStart) < +asOf);
  const curve = fitTimingCurve(
    timingEntries(known, asOf, window),
    window.trialLengthDays,
    window.postTrialDays,
    settings.timingPriorStrength,
  );
  const model = fitSegmentModel(
    buildTrainingRows(known, curve, asOf, window, settings.earlyDays, featuresAt),
    settings.priorStrength,
  );
  return { curve, model };
}

export interface BacktestResult {
  /** Trials that ended in the last `days` days and were unconverted at the cutoff. */
  users: number;
  predicted: SimulationRange;
  actual: number;
  withinRange: boolean;
  cutoffDaysBeforeEnd: number;
}

/**
 * For trials that ended in the last `days` days: refit the model as of 3 days
 * before each trial's end (features as of then, conversions known by then) and
 * predict conversions between that cutoff and now. Actual = conversions in that
 * span.
 */
export function backtest(
  users: ForecastUser[],
  activity: TrialActivityRow[],
  trialSettings: TrialSettings,
  settings: ForecastSettings,
  now: Date,
  days = 14,
  cutoffDaysBeforeEnd = 3,
): BacktestResult {
  const window = {
    trialLengthDays: trialSettings.trialLengthDays,
    postTrialDays: settings.postTrialDays,
  };
  const length = trialSettings.trialLengthDays * DAY_MS;
  const byUser = new Map<string, TrialActivityRow[]>();
  for (const row of activity) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }
  const featuresAt = (cutoff: Date) => (u: ForecastUser) =>
    computeEarlyFeatures(
      u.userId,
      new Date(u.trialStart),
      byUser.get(u.userId) ?? [],
      trialSettings,
      settings.earlyDays,
      cutoff,
    );

  const targets = users.filter(u => {
    const end = +new Date(u.trialStart) + length;
    const cutoff = end - cutoffDaysBeforeEnd * DAY_MS;
    return (
      end <= +now &&
      end > +now - days * DAY_MS &&
      !(u.convertedAt && +new Date(u.convertedAt) < cutoff)
    );
  });

  // One fit per cutoff day keeps this cheap while never peeking ahead.
  const fits = new Map<string, ReturnType<typeof fitForecastModel>>();
  const probabilities: number[] = [];
  let actual = 0;

  for (const u of targets) {
    const cutoff = new Date(+new Date(u.trialStart) + length - cutoffDaysBeforeEnd * DAY_MS);
    const key = cutoff.toISOString().slice(0, 10);
    const asOf = new Date(`${key}T00:00:00Z`);
    if (!fits.has(key))
      fits.set(key, fitForecastModel(users, asOf, window, settings, featuresAt(asOf)));
    const { curve, model } = fits.get(key);
    const elapsed = elapsedDaysAt(u.trialStart, cutoff);
    const horizon = elapsedDaysAt(u.trialStart, now) - elapsed;
    const prob = userProbability(model, curve, featuresAt(cutoff)(u), elapsed, settings.earlyDays, [
      horizon,
    ]);
    probabilities.push(prob.horizons[0]);
    if (u.convertedAt && +new Date(u.convertedAt) >= +cutoff && +new Date(u.convertedAt) < +now) {
      actual += 1;
    }
  }

  const predicted = simulateSum(probabilities, undefined, settings.simulations, 7);
  return {
    users: targets.length,
    predicted,
    actual,
    withinRange: actual >= predicted.low && actual <= predicted.high,
    cutoffDaysBeforeEnd,
  };
}

// ---------------------------------------------------------------------------
// The forecast

export type RiskFlag = 'expired' | 'lowEngagement' | 'notActivated';

export interface ForecastRow {
  userId: string;
  /** From the app's profiles (read-only view), attached by the API route. */
  email?: string | null;
  platform: string | null;
  plan: string | null;
  isInternal: boolean;
  trialStart: string;
  trialEnd: string;
  /** 1-based trial day, or null after the trial ended. */
  trialDay: number | null;
  daysSinceTrialEnd: number | null;
  phase: 'inTrial' | 'ended';
  activeDays: number;
  earlyActiveDays: number;
  activated: boolean;
  pTotal: number;
  p7: number;
  p14: number;
  segment: string;
  expectedRevenue14: number;
  flags: RiskFlag[];
}

export interface ForecastBreakdownRow {
  key: string;
  users: number;
  expected7: number;
  expected14: number;
}

export interface InsightRow {
  dimension: string;
  value: string;
  n: number;
  conversions: number;
  rate: number | null;
}

export interface TrialForecast {
  available: boolean;
  /** Why no forecast could be made (e.g. events not tracked yet). */
  reason?: 'noTracking' | 'noTraining';
  since: string | null;
  now: string;
  settings: ForecastSettings;
  trialLengthDays: number;
  headline: {
    users: number;
    conversions7: SimulationRange;
    conversions14: SimulationRange;
    revenue7: SimulationRange;
    revenue14: SimulationRange;
  };
  revenue: FirstPaymentValue;
  model: {
    id: string;
    baseRate: number;
    trainingUsers: number;
    conversions: number;
    segments: SegmentRate[];
    timingN: number;
    regressionReady: boolean;
  };
  byPhase: ForecastBreakdownRow[];
  byPlatform: ForecastBreakdownRow[];
  rows: ForecastRow[];
  insights: InsightRow[];
  /** Completed trials the insight rates are based on. */
  insightTrials: number;
  backtest: BacktestResult | null;
}

const emptyRange: SimulationRange = { expected: 0, low: 0, high: 0 };

/** Raw conversion rate by behavior over completed trials (descriptive, not the model). */
export function computeInsights(users: ForecastUser[]): InsightRow[] {
  const rows: InsightRow[] = [];
  const add = (dimension: string, value: string, group: ForecastUser[]) => {
    const conversions = group.filter(u => u.convertedAt).length;
    rows.push({
      dimension,
      value,
      n: group.length,
      conversions,
      rate: group.length ? conversions / group.length : null,
    });
  };
  const by = (dimension: string, fn: (u: ForecastUser) => string, order: string[]) => {
    for (const value of order)
      add(
        dimension,
        value,
        users.filter(u => fn(u) === value),
      );
  };
  const yesNo = (b: boolean) => (b ? 'yes' : 'no');

  by('activeDays', u => (u.activeDays >= 3 ? '3+' : String(u.activeDays)), ['0', '1', '2', '3+']);
  by(
    'earlyActiveDays',
    u => (u.earlyActiveDays >= 3 ? '3' : u.earlyActiveDays === 2 ? '2' : '0-1'),
    ['0-1', '2', '3'],
  );
  by('activated', u => yesNo(u.activated), ['yes', 'no']);
  by('recurringCreated', u => yesNo(u.recurringCreated), ['yes', 'no']);
  by('paywallShown', u => yesNo(u.paywallShown), ['yes', 'no']);
  const pushUsers = users.filter(u => u.pushEligible);
  for (const value of ['yes', 'no']) {
    add(
      'pushOptIn',
      value,
      pushUsers.filter(u => yesNo(u.pushOptIn) === value),
    );
  }
  by('platform', u => u.platform ?? 'unknown', ['ios', 'android', 'web']);

  return rows.filter(r => r.n > 0);
}

export function computeTrialForecast({
  users,
  activity,
  trialSettings,
  settings = DEFAULT_FORECAST_SETTINGS,
  since,
  now,
  revenueTxns,
  filters,
  runBacktest = true,
}: {
  users: ForecastUser[];
  activity: TrialActivityRow[];
  trialSettings: TrialSettings;
  settings?: ForecastSettings;
  /** Trials before this date are ignored (events not tracked yet). */
  since: string | null;
  now: Date;
  revenueTxns: RevenueTxnLike[];
  filters: { platform?: string; excludeInternal?: boolean };
  runBacktest?: boolean;
}): TrialForecast {
  const window = {
    trialLengthDays: trialSettings.trialLengthDays,
    postTrialDays: settings.postTrialDays,
  };
  const total = window.trialLengthDays + window.postTrialDays;
  const base = {
    since,
    now: now.toISOString(),
    settings,
    trialLengthDays: trialSettings.trialLengthDays,
  };
  const empty = (reason: TrialForecast['reason']): TrialForecast => ({
    ...base,
    available: false,
    reason,
    headline: {
      users: 0,
      conversions7: emptyRange,
      conversions14: emptyRange,
      revenue7: emptyRange,
      revenue14: emptyRange,
    },
    revenue: computeFirstPaymentValue([], revenueTxns, settings),
    model: {
      id: 'segment-v1',
      baseRate: 0,
      trainingUsers: 0,
      conversions: 0,
      segments: [],
      timingN: 0,
      regressionReady: false,
    },
    byPhase: [],
    byPlatform: [],
    rows: [],
    insights: [],
    insightTrials: 0,
    backtest: null,
  });

  if (!since) return empty('noTracking');

  // Training always uses every non-internal user (more data); the platform and
  // internal filters only decide which current trials are shown and summed.
  const tracked = users.filter(
    u => u.trialStart >= since && +new Date(u.trialStart) <= +now && !u.undatedConversion,
  );
  const training = tracked.filter(u => !u.isInternal);
  const { curve, model } = fitForecastModel(training, now, window, settings);
  if (!model.n) return empty('noTraining');

  const revenue = computeFirstPaymentValue(
    training.map(u => u.plan).filter(Boolean),
    revenueTxns,
    settings,
  );
  const firstPaymentFor = (platform: string | null) =>
    revenue.byPlatform[platform ?? 'unknown'] ?? revenue.byPlatform.unknown;

  const excludeInternal = filters.excludeInternal ?? true;
  const platform = filters.platform ?? 'all';
  const visible = tracked.filter(
    u => !(excludeInternal && u.isInternal) && (platform === 'all' || u.platform === platform),
  );

  const rows: ForecastRow[] = visible
    .filter(u => {
      const elapsed = elapsedDaysAt(u.trialStart, now);
      return !u.convertedAt && elapsed >= 0 && elapsed < total;
    })
    .map(u => {
      const elapsed = elapsedDaysAt(u.trialStart, now);
      const prob = userProbability(model, curve, u, elapsed, settings.earlyDays);
      const ended = elapsed >= window.trialLengthDays;
      const flags: RiskFlag[] = [];
      if (ended) flags.push('expired');
      if (elapsed >= settings.earlyDays && u.earlyActiveDays <= 1) flags.push('lowEngagement');
      if (elapsed >= settings.earlyDays && !u.activated) flags.push('notActivated');
      return {
        userId: u.userId,
        platform: u.platform,
        plan: u.plan,
        isInternal: u.isInternal,
        trialStart: u.trialStart,
        trialEnd: new Date(+new Date(u.trialStart) + window.trialLengthDays * DAY_MS).toISOString(),
        trialDay: ended ? null : Math.floor(elapsed) + 1,
        daysSinceTrialEnd: ended ? Math.floor(elapsed - window.trialLengthDays) : null,
        phase: (ended ? 'ended' : 'inTrial') as ForecastRow['phase'],
        activeDays: u.activeDays,
        earlyActiveDays: u.earlyActiveDays,
        activated: u.activated,
        pTotal: prob.pTotal,
        p7: prob.p7,
        p14: prob.p14,
        segment: prob.segment,
        expectedRevenue14: prob.p14 * firstPaymentFor(u.platform),
        flags,
      };
    })
    .sort((a, b) => (a.trialEnd < b.trialEnd ? -1 : 1));

  const p7 = rows.map(r => r.p7);
  const p14 = rows.map(r => r.p14);
  const values = rows.map(r => firstPaymentFor(r.platform));
  const breakdown = (key: (r: ForecastRow) => string, order: string[]) =>
    order
      .map(k => {
        const group = rows.filter(r => key(r) === k);
        return {
          key: k,
          users: group.length,
          expected7: group.reduce((s, r) => s + r.p7, 0),
          expected14: group.reduce((s, r) => s + r.p14, 0),
        };
      })
      .filter(r => r.users > 0);

  // Insight rates: completed trials as the Trial report defines them.
  const completed = training.filter(
    u =>
      elapsedDaysAt(u.trialStart, now) >=
      trialSettings.trialLengthDays + trialSettings.conversionSettleDays,
  );

  return {
    ...base,
    available: true,
    headline: {
      users: rows.length,
      conversions7: simulateSum(p7, undefined, settings.simulations, 1),
      conversions14: simulateSum(p14, undefined, settings.simulations, 2),
      revenue7: simulateSum(p7, values, settings.simulations, 3),
      revenue14: simulateSum(p14, values, settings.simulations, 4),
    },
    revenue,
    model: {
      id: model.id,
      baseRate: model.baseRate,
      trainingUsers: model.n,
      conversions: model.conversions,
      segments: model.segments,
      timingN: curve.n,
      regressionReady: model.conversions >= MIN_CONVERSIONS_FOR_REGRESSION,
    },
    byPhase: breakdown(r => r.phase, ['inTrial', 'ended']),
    byPlatform: breakdown(r => r.platform ?? 'unknown', ['ios', 'android', 'web', 'unknown']),
    rows,
    insights: computeInsights(completed),
    insightTrials: completed.length,
    backtest: runBacktest ? backtest(training, activity, trialSettings, settings, now) : null,
  };
}

/** Trials must have started once conversion, active-day and activation events were tracked. */
export function getForecastSince(trackingSince: {
  converted: string | null;
  active2: string | null;
  activated: string | null;
}): string | null {
  const dates = [trackingSince.converted, trackingSince.active2, trackingSince.activated];
  if (dates.some(d => d === null)) return null;
  return (dates as string[]).sort()[dates.length - 1];
}

// ---------------------------------------------------------------------------
// Accuracy tracking

export interface UserSnapshotLike {
  snapshotDate: string;
  userId: string;
  platform: string | null;
  trialStart: string;
  elapsedDays: number;
  pTotal: number;
  p7: number;
  outcome: boolean | null;
  convertedAt: string | null;
}

/**
 * Outcome of a snapshot row: true once the user converted (within the window),
 * false once their conversion window closed without a purchase, else null.
 */
export function resolveOutcome(
  trialStart: string,
  convertedAt: string | null,
  now: Date,
  window: ForecastWindow,
): { outcome: boolean | null; convertedAt: string | null } {
  const total = (window.trialLengthDays + window.postTrialDays) * DAY_MS;
  const end = +new Date(trialStart) + total;
  if (convertedAt && +new Date(convertedAt) < end) return { outcome: true, convertedAt };
  if (+now >= end) return { outcome: false, convertedAt: null };
  return { outcome: null, convertedAt: null };
}

export interface ForecastAccuracy {
  weeks: {
    weekOf: string;
    predicted: number;
    low: number;
    high: number;
    actual: number;
  }[];
  predicted: number;
  actual: number;
  calibration: { bucket: string; n: number; predicted: number; actual: number }[];
  resolvedUsers: number;
}

export const CALIBRATION_BUCKETS: [number, number, string][] = [
  [0, 0.05, '0–5%'],
  [0.05, 0.15, '5–15%'],
  [0.15, 0.3, '15–30%'],
  [0.3, 0.5, '30–50%'],
  [0.5, 1.000001, '50%+'],
];

/**
 * Last 4 weeks: for the first snapshot of each week whose 7-day horizon has
 * passed, predicted 7-day conversions (sum of the stored per-user P, with a
 * simulated P10–P90 range) vs. users from that snapshot who actually converted
 * within 7 days. Calibration: one snapshot per resolved user (the one closest
 * to 3 days before trial end), predicted P vs. actual rate per bucket.
 * Built from per-user rows so the page's platform filter applies (snapshots
 * always exclude internal users).
 */
export function computeForecastAccuracy(
  snapshots: UserSnapshotLike[],
  now: Date,
  trialLengthDays: number,
  platform = 'all',
): ForecastAccuracy {
  const userSnapshots =
    platform === 'all' ? snapshots : snapshots.filter(s => s.platform === platform);
  const today = now.toISOString().slice(0, 10);
  const latest = addDays(today, -7);
  const earliest = addDays(today, -35);
  const byDate = new Map<string, UserSnapshotLike[]>();
  for (const s of userSnapshots) {
    if (!byDate.has(s.snapshotDate)) byDate.set(s.snapshotDate, []);
    byDate.get(s.snapshotDate).push(s);
  }

  const firstOfWeek = new Map<string, string>();
  for (const date of [...byDate.keys()].sort()) {
    if (date < earliest || date > latest) continue;
    const week = getWeekStart(new Date(`${date}T12:00:00Z`), 'UTC');
    if (!firstOfWeek.has(week)) firstOfWeek.set(week, date);
  }

  const weeks = [...firstOfWeek]
    .map(([weekOf, date]) => {
      const rows = byDate.get(date) ?? [];
      const start = +new Date(`${date}T00:00:00Z`);
      const range = simulateSum(
        rows.map(r => r.p7),
        undefined,
        DEFAULT_FORECAST_SETTINGS.simulations,
        5,
      );
      const actual = rows.filter(
        s =>
          s.convertedAt &&
          +new Date(s.convertedAt) >= start &&
          +new Date(s.convertedAt) < start + 7 * DAY_MS,
      ).length;
      return { weekOf, predicted: range.expected, low: range.low, high: range.high, actual };
    })
    .sort((a, b) => (a.weekOf < b.weekOf ? -1 : 1))
    .slice(-4);

  const target = trialLengthDays - 3;
  const perUser = new Map<string, UserSnapshotLike>();
  for (const s of userSnapshots) {
    if (s.outcome === null) continue;
    const current = perUser.get(s.userId);
    if (!current || Math.abs(s.elapsedDays - target) < Math.abs(current.elapsedDays - target)) {
      perUser.set(s.userId, s);
    }
  }
  const resolved = [...perUser.values()];
  const calibration = CALIBRATION_BUCKETS.map(([lo, hi, bucket]) => {
    const group = resolved.filter(s => s.pTotal >= lo && s.pTotal < hi);
    return {
      bucket,
      n: group.length,
      predicted: group.length ? group.reduce((s, x) => s + x.pTotal, 0) / group.length : 0,
      actual: group.length ? group.filter(s => s.outcome).length / group.length : 0,
    };
  }).filter(b => b.n > 0);

  return {
    weeks,
    predicted: weeks.reduce((s, w) => s + w.predicted, 0),
    actual: weeks.reduce((s, w) => s + w.actual, 0),
    calibration,
    resolvedUsers: resolved.length,
  };
}

/** What the forecast API returns: the forecast plus accuracy from stored snapshots. */
export type TrialForecastReport = TrialForecast & { accuracy: ForecastAccuracy | null };
