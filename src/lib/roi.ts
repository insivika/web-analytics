// Paid-acquisition ROI: pure computations (unit-tested). Cohorts are trial starters
// grouped by trial-start date (same definition as the Trial report). Revenue is
// net of store/processor fees, converted to USD, within N days of trial start.

import type { FxLookup } from './ads/fx';
import { toUsd } from './ads/fx';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface RoiSettings {
  /** Revenue windows in days after trial start; the last one is the ROI window. */
  revenueWindows: number[];
  /** Fee share kept by the store for RevenueCat (App Store / Google Play). */
  storeFeeRate: number;
  /** Stripe fee: percentage + fixed USD per charge. */
  stripeFeeRate: number;
  stripeFeeFixedUsd: number;
  /** Default "to earn $Y" target for the headline. */
  targetRevenueUsd: number;
}

export const DEFAULT_ROI_SETTINGS: RoiSettings = {
  revenueWindows: [30, 90],
  storeFeeRate: 0.15,
  stripeFeeRate: 0.029,
  stripeFeeFixedUsd: 0.3,
  targetRevenueUsd: 1000,
};

export function normalizeRoiSettings(value?: Partial<RoiSettings> | null): RoiSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<RoiSettings>;
  const num = (x: unknown, fallback: number, min: number, max: number) =>
    Number.isFinite(Number(x)) ? Math.min(Math.max(Number(x), min), max) : fallback;
  const windows = Array.isArray(v.revenueWindows)
    ? [
        ...new Set(
          v.revenueWindows.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 730),
        ),
      ].sort((a, b) => a - b)
    : [];

  return {
    revenueWindows: windows.length ? windows : DEFAULT_ROI_SETTINGS.revenueWindows,
    storeFeeRate: num(v.storeFeeRate, DEFAULT_ROI_SETTINGS.storeFeeRate, 0, 0.5),
    stripeFeeRate: num(v.stripeFeeRate, DEFAULT_ROI_SETTINGS.stripeFeeRate, 0, 0.2),
    stripeFeeFixedUsd: num(v.stripeFeeFixedUsd, DEFAULT_ROI_SETTINGS.stripeFeeFixedUsd, 0, 5),
    targetRevenueUsd: num(v.targetRevenueUsd, DEFAULT_ROI_SETTINGS.targetRevenueUsd, 1, 10_000_000),
  };
}

export const ROI_SETTINGS_KEY = 'roi';

/** A subscription_started / subscription_renewed event. */
export interface RevenueEvent {
  userId: string;
  createdAt: Date | string;
  eventName: string;
  revenue: number | null;
  currency: string | null;
  priceUsd: number | null;
  provider: string | null;
}

/** Net USD for one charge, or null when the currency has no FX rate. */
export function netRevenueUsd(event: RevenueEvent, settings: RoiSettings, fx: FxLookup) {
  const gross =
    event.priceUsd !== null && event.priceUsd !== undefined && Number(event.priceUsd) > 0
      ? Number(event.priceUsd)
      : event.revenue === null
        ? null
        : toUsd(Number(event.revenue), event.currency || 'USD', event.createdAt, fx);

  if (gross === null) return null;
  if (gross <= 0) return 0;

  const provider = (event.provider || '').toLowerCase();
  const net =
    provider === 'stripe'
      ? gross * (1 - settings.stripeFeeRate) - settings.stripeFeeFixedUsd
      : gross * (1 - settings.storeFeeRate);

  return Math.max(0, Math.round(net * 100) / 100);
}

export interface CohortUser {
  userId: string;
  trialStart: Date;
}

export interface UserRevenue {
  userId: string;
  trialStart: Date;
  /** Net USD per charge with days since trial start (charges before start are ignored). */
  charges: { days: number; netUsd: number }[];
  missingFx: number;
}

/** Attaches each cohort user's net charges (on/after trial start). */
export function buildUserRevenue(
  users: CohortUser[],
  events: RevenueEvent[],
  settings: RoiSettings,
  fx: FxLookup,
): UserRevenue[] {
  const byUser = new Map<string, RevenueEvent[]>();
  for (const e of events) {
    if (!byUser.has(e.userId)) byUser.set(e.userId, []);
    byUser.get(e.userId).push(e);
  }

  return users.map(({ userId, trialStart }) => {
    const charges: UserRevenue['charges'] = [];
    let missingFx = 0;
    for (const e of byUser.get(userId) ?? []) {
      const at = +new Date(e.createdAt);
      if (at < +trialStart) continue;
      const net = netRevenueUsd(e, settings, fx);
      if (net === null) {
        missingFx += 1;
        continue;
      }
      charges.push({ days: (at - +trialStart) / DAY_MS, netUsd: net });
    }
    return { userId, trialStart, charges, missingFx };
  });
}

/** Net revenue within `days` of trial start. */
export const revenueWithin = (user: UserRevenue, days: number) =>
  user.charges.filter(c => c.days < days).reduce((s, c) => s + c.netUsd, 0);

export interface CohortSummary {
  trialStarts: number;
  payingCustomers: number;
  /** Net revenue per window, keyed by window days (revenue so far for immature users). */
  revenue: Record<number, number>;
  /** Users whose trial started at least `window` days ago, per window. */
  matureUsers: Record<number, number>;
  spendUsd: number;
  roas: number | null;
  cac: number | null;
  costPerTrial: number | null;
  /** Days after trial start until cumulative cohort revenue covers spend; null = not yet. */
  paybackDays: number | null;
  /** True when any trial in the cohort is younger than the ROI window. */
  immature: boolean;
  missingFx: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Days until the cohort's cumulative net revenue (each charge placed at its day
 * since that user's trial start) reaches spend. Null when it hasn't yet.
 */
export function paybackDays(users: UserRevenue[], spendUsd: number): number | null {
  if (spendUsd <= 0) return 0;
  const charges = users.flatMap(u => u.charges).sort((a, b) => a.days - b.days);
  let total = 0;
  for (const c of charges) {
    total += c.netUsd;
    if (total >= spendUsd) return Math.ceil(c.days);
  }
  return null;
}

export function summarizeCohort(
  users: UserRevenue[],
  spendUsd: number,
  settings: RoiSettings,
  now: Date,
): CohortSummary {
  const windows = settings.revenueWindows;
  const roiWindow = windows[windows.length - 1];
  const revenue: Record<number, number> = {};
  const matureUsers: Record<number, number> = {};

  for (const w of windows) {
    revenue[w] = round2(users.reduce((s, u) => s + revenueWithin(u, w), 0));
    matureUsers[w] = users.filter(u => +now - +u.trialStart >= w * DAY_MS).length;
  }

  const paying = users.filter(u => u.charges.length > 0).length;
  const roiRevenue = revenue[roiWindow];

  return {
    trialStarts: users.length,
    payingCustomers: paying,
    revenue,
    matureUsers,
    spendUsd: round2(spendUsd),
    roas: spendUsd > 0 ? Math.round((roiRevenue / spendUsd) * 1000) / 1000 : null,
    cac: paying > 0 && spendUsd > 0 ? round2(spendUsd / paying) : null,
    costPerTrial: users.length > 0 && spendUsd > 0 ? round2(spendUsd / users.length) : null,
    paybackDays: paybackDays(users, spendUsd),
    immature: matureUsers[roiWindow] < users.length,
    missingFx: users.reduce((s, u) => s + u.missingFx, 0),
  };
}

/** "To earn $Y you'd need to spend about $Z at current efficiency" (null without ROAS). */
export const spendNeededFor = (targetUsd: number, roas: number | null) =>
  roas && roas > 0 ? round2(targetUsd / roas) : null;

export interface LtvEstimate {
  /** Average net monthly revenue per paying user over the lookback. */
  arpuMonthly: number | null;
  /** Monthly churn = cancellations per month / paying users. */
  monthlyChurn: number | null;
  /** Projected LTV = ARPU / churn (null when churn is 0 or unknown). */
  projectedLtv: number | null;
  payingUsers: number;
  cancellations: number;
  lookbackDays: number;
}

/**
 * Projected LTV from the last `lookbackDays`: net revenue per paying user per
 * month divided by observed monthly churn. Clearly an estimate ("projected").
 */
export function estimateLtv(
  events: RevenueEvent[],
  cancellations: { userId: string; createdAt: Date | string }[],
  settings: RoiSettings,
  fx: FxLookup,
  now: Date,
  lookbackDays = 90,
): LtvEstimate {
  const since = +now - lookbackDays * DAY_MS;
  const recent = events.filter(e => +new Date(e.createdAt) >= since);
  const payers = new Set(recent.map(e => e.userId));
  const net = recent.reduce((s, e) => s + (netRevenueUsd(e, settings, fx) ?? 0), 0);
  const months = lookbackDays / 30;
  const cancels = cancellations.filter(c => +new Date(c.createdAt) >= since).length;

  const arpuMonthly = payers.size ? net / payers.size / months : null;
  const monthlyChurn = payers.size ? cancels / months / payers.size : null;

  return {
    arpuMonthly: arpuMonthly === null ? null : round2(arpuMonthly),
    monthlyChurn: monthlyChurn === null ? null : Math.round(monthlyChurn * 10000) / 10000,
    projectedLtv: arpuMonthly !== null && monthlyChurn ? round2(arpuMonthly / monthlyChurn) : null,
    payingUsers: payers.size,
    cancellations: cancels,
    lookbackDays,
  };
}

export interface SpendDay {
  date: string; // yyyy-MM-dd
  channel: string;
  campaignId: string;
  campaignName: string | null;
  spendUsd: number | null;
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
}

/** Total USD spend for days in [start, end) (yyyy-MM-dd strings). */
export function sumSpend(rows: SpendDay[], start: string, end: string) {
  return round2(
    rows.filter(r => r.date >= start && r.date < end).reduce((s, r) => s + (r.spendUsd ?? 0), 0),
  );
}
