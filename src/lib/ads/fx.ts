// FX conversion for ad spend and revenue. Rates are stored as the USD value of
// one unit of a currency on a date (fx_rate.usd_rate). Daily ECB rates come from
// Frankfurter (no API key); manual rows override fetched ones.

export const FX_SOURCE_URL = 'https://api.frankfurter.dev/v1';

/** How many days back a missing rate (weekend, holiday) may be carried forward. */
export const FX_CARRY_FORWARD_DAYS = 7;

export interface FxRateRow {
  date: string; // yyyy-MM-dd
  currency: string;
  usdRate: number;
  source: 'frankfurter' | 'manual' | string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const toDateKey = (date: Date | string) =>
  (typeof date === 'string' ? date : date.toISOString()).slice(0, 10);

export const addDays = (day: string, days: number) =>
  toDateKey(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/**
 * Builds a lookup that returns the USD rate for a currency on a date, carrying
 * the last known rate forward up to FX_CARRY_FORWARD_DAYS days. Manual rates win
 * over fetched ones for the same day. USD is always 1.
 */
export function buildFxLookup(rows: FxRateRow[]) {
  const byKey = new Map<string, FxRateRow>();

  for (const row of rows) {
    const key = `${row.currency.toUpperCase()}:${toDateKey(row.date)}`;
    const existing = byKey.get(key);
    if (!existing || (row.source === 'manual' && existing.source !== 'manual')) {
      byKey.set(key, { ...row, currency: row.currency.toUpperCase() });
    }
  }

  return (currency: string, date: Date | string): number | null => {
    const cur = (currency || '').toUpperCase();
    if (cur === 'USD') return 1;

    let day = toDateKey(date);
    for (let i = 0; i <= FX_CARRY_FORWARD_DAYS; i++) {
      const rate = byKey.get(`${cur}:${day}`);
      if (rate && Number(rate.usdRate) > 0) return Number(rate.usdRate);
      day = addDays(day, -1);
    }
    return null;
  };
}

export type FxLookup = ReturnType<typeof buildFxLookup>;

/** Converts an amount to USD, or null when no rate is known for that day. */
export function toUsd(amount: number, currency: string, date: Date | string, fx: FxLookup) {
  const rate = fx(currency, date);
  return rate === null ? null : round4(amount * rate);
}

export const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Fetches daily ECB rates from Frankfurter for [start, end] and returns them as
 * USD-per-unit rows. Frankfurter quotes units per USD, so the stored rate is 1 / quote.
 */
export async function fetchFrankfurterRates(
  start: string,
  end: string,
  currencies: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<FxRateRow[]> {
  const symbols = [...new Set(currencies.map(c => c.toUpperCase()))].filter(c => c !== 'USD');
  if (!symbols.length) return [];

  // Ask for a few extra days before `start` so weekends at the start carry forward.
  const url = `${FX_SOURCE_URL}/${addDays(start, -FX_CARRY_FORWARD_DAYS)}..${end}?base=USD&symbols=${symbols.join(',')}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });

  if (!res.ok) {
    throw new Error(`FX fetch failed: HTTP ${res.status}`);
  }

  const json: any = await res.json();
  const rows: FxRateRow[] = [];

  for (const [date, quotes] of Object.entries<Record<string, number>>(json?.rates ?? {})) {
    for (const [currency, perUsd] of Object.entries(quotes)) {
      if (perUsd > 0) {
        rows.push({ date, currency, usdRate: round8(1 / perUsd), source: 'frankfurter' });
      }
    }
  }

  return rows;
}

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
