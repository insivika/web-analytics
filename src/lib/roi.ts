// Marketing ROI funnel: pure computations (unit-tested).
// Ad spend → website visitors → trial starts → paying customers → their actual
// revenue to date. Revenue comes from Stripe and RevenueCat transactions (real
// fees and proceeds), never from assumed prices or fee rates.

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface RoiSettings {
  /** Default "to earn $Y" target for the headline. */
  targetRevenueUsd: number;
}

export const DEFAULT_ROI_SETTINGS: RoiSettings = { targetRevenueUsd: 1000 };

export function normalizeRoiSettings(value?: Partial<RoiSettings> | null): RoiSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<RoiSettings>;
  const t = Number(v.targetRevenueUsd);
  return {
    targetRevenueUsd: Number.isFinite(t)
      ? Math.min(Math.max(t, 1), 10_000_000)
      : DEFAULT_ROI_SETTINGS.targetRevenueUsd,
  };
}

export const ROI_SETTINGS_KEY = 'roi';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A provider transaction (see revenue_txn). Refunds/disputes carry negative amounts. */
export interface RevenueTxnInput {
  source: string;
  kind: string;
  userId: string | null;
  occurredAt: Date | string;
  grossUsd: number | null;
  feeUsd: number | null;
  netUsd: number | null;
}

export interface CohortUser {
  userId: string;
  trialStart: Date;
}

export interface CustomerRevenue {
  userId: string;
  trialStart: Date;
  gross: number;
  fees: number;
  net: number;
  sources: string[];
  /** True once the user has made at least one payment that wasn't fully refunded. */
  paying: boolean;
}

/**
 * Payments made after the trial started count toward that trial (a RevenueCat
 * subscription is dated at its store trial start, which can be a day or two
 * before the web trial start, hence the tolerance).
 */
export const TRIAL_START_TOLERANCE_DAYS = 2;

export function buildCustomerRevenue(
  cohort: CohortUser[],
  txns: RevenueTxnInput[],
): CustomerRevenue[] {
  const byUser = new Map<string, RevenueTxnInput[]>();
  for (const t of txns) {
    if (!t.userId) continue;
    if (!byUser.has(t.userId)) byUser.set(t.userId, []);
    byUser.get(t.userId).push(t);
  }

  return cohort.map(({ userId, trialStart }) => {
    const from = +trialStart - TRIAL_START_TOLERANCE_DAYS * DAY_MS;
    const own = (byUser.get(userId) ?? []).filter(t => +new Date(t.occurredAt) >= from);
    const gross = own.reduce((s, t) => s + (t.grossUsd ?? 0), 0);
    const net = own.reduce((s, t) => s + (t.netUsd ?? t.grossUsd ?? 0), 0);
    const fees = own.reduce((s, t) => s + (t.feeUsd ?? 0), 0);
    return {
      userId,
      trialStart,
      gross: round2(gross),
      fees: round2(fees),
      net: round2(net),
      sources: [...new Set(own.map(t => t.source))],
      paying: gross > 0.005,
    };
  });
}

export interface FunnelSummary {
  spendUsd: number;
  visitors: number;
  trialStarts: number;
  /** Trials that have ended (only these could have converted yet). */
  completedTrials: number;
  payingCustomers: number;
  grossRevenue: number;
  fees: number;
  netRevenue: number;
  visitorToTrial: number | null;
  trialToPaying: number | null;
  costPerVisitor: number | null;
  costPerTrial: number | null;
  cac: number | null;
  roas: number | null;
  revenuePerCustomer: number | null;
  /** Some trials are still running, so customers and revenue will still grow. */
  immature: boolean;
}

const div = (a: number, b: number) => (b > 0 ? a / b : null);

export function summarizeFunnel(
  customers: CustomerRevenue[],
  spendUsd: number,
  visitors: number,
  trialLengthDays: number,
  now: Date,
): FunnelSummary {
  const ended = customers.filter(c => +c.trialStart + trialLengthDays * DAY_MS <= +now);
  const paying = customers.filter(c => c.paying);
  const net = round2(paying.reduce((s, c) => s + c.net, 0));
  const r = (n: number | null, digits = 2) =>
    n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits;

  return {
    spendUsd: round2(spendUsd),
    visitors,
    trialStarts: customers.length,
    completedTrials: ended.length,
    payingCustomers: paying.length,
    grossRevenue: round2(paying.reduce((s, c) => s + c.gross, 0)),
    fees: round2(paying.reduce((s, c) => s + c.fees, 0)),
    netRevenue: net,
    visitorToTrial: r(div(customers.length, visitors), 4),
    // Among completed trials only, so running trials don't drag the rate down.
    trialToPaying: r(div(ended.filter(c => c.paying).length, ended.length), 4),
    costPerVisitor: r(div(spendUsd, visitors)),
    costPerTrial: r(div(spendUsd, customers.length)),
    cac: r(div(spendUsd, paying.length)),
    roas: r(div(net, spendUsd)),
    revenuePerCustomer: r(div(net, paying.length)),
    immature: ended.length < customers.length,
  };
}

/** Total of all provider money in [start, end): every customer, not just this funnel. */
export function sumCashIn(txns: RevenueTxnInput[], start: Date, end: Date, source?: string) {
  const rows = txns.filter(
    t =>
      (!source || t.source === source) &&
      +new Date(t.occurredAt) >= +start &&
      +new Date(t.occurredAt) < +end,
  );
  return {
    gross: round2(rows.reduce((s, t) => s + (t.grossUsd ?? 0), 0)),
    net: round2(rows.reduce((s, t) => s + (t.netUsd ?? t.grossUsd ?? 0), 0)),
  };
}

/** Spend needed to earn `targetUsd` net at the observed ROAS. */
export const spendNeededFor = (targetUsd: number, roas: number | null) =>
  roas && roas > 0 ? Math.round(targetUsd / roas) : null;

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
