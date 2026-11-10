// Marketing ROI by calendar month: pure computations (unit-tested).
// Net income = money in (Stripe + App Store/Google Play, after fees and refunds)
// minus ad spend (Meta + Google). Every number is per calendar month, so any
// period on the page is just a sum of months.

import { formatInTimeZone } from 'date-fns-tz';

export const ROI_TIMEZONE = 'America/Chicago';
export const ROI_MONTHS = 12;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The last `n` calendar months (yyyy-MM), oldest first, ending with the current month. */
export function lastMonths(n: number, now = new Date(), tz = ROI_TIMEZONE): string[] {
  const [y, m] = formatInTimeZone(now, tz, 'yyyy-MM').split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export const monthOf = (date: Date | string, tz = ROI_TIMEZONE) =>
  formatInTimeZone(new Date(date), tz, 'yyyy-MM');

/** First day of a yyyy-MM month as yyyy-MM-dd. */
export const monthStart = (month: string) => `${month}-01`;

/** Monthly prices are $5–12, yearly $54–108: anything this size or more is a yearly plan. */
export const YEARLY_MIN_USD = 40;

export interface StripeTxn {
  kind: string;
  userId: string | null;
  customerRef: string | null;
  occurredAt: Date | string;
  grossUsd: number | null;
  netUsd: number | null;
}

export interface AppStoreMonth {
  /** Proceeds after store commission and tax, refunds deducted. */
  proceeds: number;
  yearly: number;
  newCustomers: number;
}

export interface MonthInputs {
  spend: Map<string, { meta: number; google: number }>;
  visitors: Map<string, number>;
  trials: Map<string, number>;
  stripe: StripeTxn[];
  appStores: Map<string, AppStoreMonth> | null;
}

export interface MonthRow {
  month: string;
  spendMeta: number;
  spendGoogle: number;
  spend: number;
  visitors: number;
  trials: number;
  newCustomers: number;
  moneyStripe: number;
  moneyAppStores: number | null;
  moneyIn: number;
  yearly: number;
  netIncome: number;
}

export function buildMonths(months: string[], input: MonthInputs, tz = ROI_TIMEZONE): MonthRow[] {
  // A Stripe customer is new in the month of their first ever payment.
  const firstPayment = new Map<string, string>();
  const stripeNet = new Map<string, number>();
  const stripeYearly = new Map<string, number>();
  const sorted = [...input.stripe].sort(
    (a, b) => +new Date(a.occurredAt) - +new Date(b.occurredAt),
  );
  for (const t of sorted) {
    const month = monthOf(t.occurredAt, tz);
    const net = t.netUsd ?? t.grossUsd ?? 0;
    stripeNet.set(month, (stripeNet.get(month) ?? 0) + net);
    if (t.kind === 'payment' && (t.grossUsd ?? 0) > 0) {
      if ((t.grossUsd ?? 0) >= YEARLY_MIN_USD) {
        stripeYearly.set(month, (stripeYearly.get(month) ?? 0) + net);
      }
      const key = t.userId ?? t.customerRef;
      if (key && !firstPayment.has(key)) firstPayment.set(key, month);
    }
  }
  const newStripe = new Map<string, number>();
  for (const month of firstPayment.values()) newStripe.set(month, (newStripe.get(month) ?? 0) + 1);

  return months.map(month => {
    const spend = input.spend.get(month) ?? { meta: 0, google: 0 };
    const app = input.appStores?.get(month);
    const moneyStripe = round2(stripeNet.get(month) ?? 0);
    const moneyAppStores = input.appStores ? round2(app?.proceeds ?? 0) : null;
    const moneyIn = round2(moneyStripe + (moneyAppStores ?? 0));
    const total = round2(spend.meta + spend.google);
    return {
      month,
      spendMeta: round2(spend.meta),
      spendGoogle: round2(spend.google),
      spend: total,
      visitors: input.visitors.get(month) ?? 0,
      trials: input.trials.get(month) ?? 0,
      newCustomers: (newStripe.get(month) ?? 0) + (app?.newCustomers ?? 0),
      moneyStripe,
      moneyAppStores,
      moneyIn,
      yearly: round2((stripeYearly.get(month) ?? 0) + (app?.yearly ?? 0)),
      netIncome: round2(moneyIn - total),
    };
  });
}

export interface PeriodTotals extends Omit<MonthRow, 'month' | 'moneyAppStores'> {
  moneyAppStores: number | null;
  months: string[];
  costPerCustomer: number | null;
  visitorToTrial: number | null;
}

/** Sums a set of month rows into one period. */
export function sumMonths(rows: MonthRow[]): PeriodTotals {
  const sum = (k: keyof MonthRow) => round2(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0));
  const spend = sum('spend');
  const newCustomers = rows.reduce((s, r) => s + r.newCustomers, 0);
  const visitors = rows.reduce((s, r) => s + r.visitors, 0);
  const trials = rows.reduce((s, r) => s + r.trials, 0);
  return {
    months: rows.map(r => r.month),
    spendMeta: sum('spendMeta'),
    spendGoogle: sum('spendGoogle'),
    spend,
    visitors,
    trials,
    newCustomers,
    moneyStripe: sum('moneyStripe'),
    moneyAppStores: rows.some(r => r.moneyAppStores === null) ? null : sum('moneyAppStores'),
    moneyIn: sum('moneyIn'),
    yearly: sum('yearly'),
    netIncome: sum('netIncome'),
    costPerCustomer: newCustomers > 0 && spend > 0 ? round2(spend / newCustomers) : null,
    visitorToTrial: visitors > 0 ? Math.round((trials / visitors) * 1000) / 1000 : null,
  };
}

export const ROI_PERIODS = ['this-month', 'last-month', '3-months', '12-months'] as const;
export type RoiPeriod = (typeof ROI_PERIODS)[number];

/** Months (oldest first, current month last) that make up a period. */
export function periodRows(rows: MonthRow[], period: RoiPeriod): MonthRow[] {
  switch (period) {
    case 'this-month':
      return rows.slice(-1);
    case 'last-month':
      return rows.slice(-2, -1);
    case '3-months':
      return rows.slice(-3);
    default:
      return rows.slice(-12);
  }
}
