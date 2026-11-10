import { buildFxLookup, fetchFrankfurterRates, toUsd } from '../ads/fx';
import { isValidScriptSecret, mapGoogleRows, normalizeCustomerId } from '../ads/google';
import { fetchMetaInsights, MetaApiError, parseAccountIds } from '../ads/meta';
import {
  buildUserRevenue,
  DAY_MS,
  DEFAULT_ROI_SETTINGS,
  estimateLtv,
  netRevenueUsd,
  normalizeRoiSettings,
  paybackDays,
  type RevenueEvent,
  spendNeededFor,
  summarizeCohort,
  sumSpend,
} from '../roi';

const settings = DEFAULT_ROI_SETTINGS;
const now = new Date('2026-11-10T12:00:00Z');
const daysAgo = (n: number) => new Date(+now - n * DAY_MS);
const fx = buildFxLookup([
  { date: '2026-11-06', currency: 'AUD', usdRate: 0.687, source: 'frankfurter' },
  { date: '2026-11-06', currency: 'GBP', usdRate: 1.338, source: 'frankfurter' },
  { date: '2026-11-06', currency: 'GBP', usdRate: 1.3, source: 'manual' },
]);

const charge = (userId: string, at: Date, extra: Partial<RevenueEvent> = {}): RevenueEvent => ({
  userId,
  createdAt: at,
  eventName: 'subscription_started',
  revenue: 12,
  currency: 'USD',
  priceUsd: null,
  provider: 'revenuecat',
  ...extra,
});

describe('FX conversion', () => {
  test('carries the last rate forward over weekends and prefers manual rates', () => {
    // Nov 8 2026 is a Sunday: uses Friday Nov 6.
    expect(fx('AUD', '2026-11-08')).toBe(0.687);
    expect(fx('GBP', '2026-11-06')).toBe(1.3);
    expect(fx('USD', '2020-01-01')).toBe(1);
    expect(toUsd(100, 'AUD', '2026-11-07', fx)).toBe(68.7);
  });

  test('returns null when no rate is known within the carry-forward window', () => {
    expect(fx('AUD', '2026-11-20')).toBeNull();
    expect(fx('JPY', '2026-11-06')).toBeNull();
  });

  test('Frankfurter quotes (units per USD) are stored as USD per unit', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ rates: { '2026-11-06': { AUD: 1.4554, GBP: 0.74711 } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const rows = await fetchFrankfurterRates(
      '2026-11-06',
      '2026-11-06',
      ['AUD', 'GBP', 'USD'],
      fakeFetch,
    );

    expect(rows).toEqual([
      { date: '2026-11-06', currency: 'AUD', usdRate: 0.68709633, source: 'frankfurter' },
      { date: '2026-11-06', currency: 'GBP', usdRate: 1.33849099, source: 'frankfurter' },
    ]);
  });
});

describe('net revenue', () => {
  test('applies store and Stripe fees and prefers price_usd', () => {
    expect(netRevenueUsd(charge('u', daysAgo(1)), settings, fx)).toBe(10.2); // 12 * 0.85
    expect(
      netRevenueUsd(charge('u', daysAgo(1), { provider: 'stripe', revenue: 8 }), settings, fx),
    ).toBe(
      7.47, // 8 * 0.971 - 0.30
    );
    expect(
      netRevenueUsd(
        charge('u', new Date('2026-11-07T00:00:00Z'), {
          revenue: 12.99,
          currency: 'AUD',
          priceUsd: 9.132,
        }),
        settings,
        fx,
      ),
    ).toBe(7.76); // price_usd 9.132 * 0.85
    expect(
      netRevenueUsd(
        charge('u', new Date('2026-11-07T00:00:00Z'), { revenue: 19, currency: 'AUD' }),
        settings,
        fx,
      ),
    ).toBe(11.1); // 19 * 0.687 * 0.85
  });

  test('is null without an FX rate', () => {
    expect(
      netRevenueUsd(charge('u', daysAgo(1), { currency: 'JPY', revenue: 1200 }), settings, fx),
    ).toBeNull();
  });
});

describe('revenue windows, ROAS, CAC, payback', () => {
  const cohort = [
    { userId: 'a', trialStart: daysAgo(100) },
    { userId: 'b', trialStart: daysAgo(100) },
    { userId: 'c', trialStart: daysAgo(20) },
  ];
  const events = [
    charge('a', new Date(+daysAgo(100) + 14 * DAY_MS)), // day 14: 10.20
    charge('a', new Date(+daysAgo(100) + 44 * DAY_MS), { eventName: 'subscription_renewed' }), // day 44
    charge('a', new Date(+daysAgo(100) + 95 * DAY_MS), { eventName: 'subscription_renewed' }), // day 95: outside 90
    charge('b', new Date(+daysAgo(110))), // before trial start: ignored
    charge('c', new Date(+daysAgo(20) + 15 * DAY_MS), { revenue: 108, provider: 'stripe' }), // 104.57
  ];
  const users = buildUserRevenue(cohort, events, settings, fx);

  test('counts net revenue within 30 and 90 days of trial start', () => {
    const s = summarizeCohort(users, 200, settings, now);

    expect(s.revenue[30]).toBe(114.77); // 10.20 + 104.57
    expect(s.revenue[90]).toBe(124.97); // + 10.20 on day 44
    expect(s.matureUsers).toEqual({ 30: 2, 90: 2 });
    expect(s.immature).toBe(true);
    expect(s.payingCustomers).toBe(2);
  });

  test('ROAS, CAC, cost per trial and payback', () => {
    const s = summarizeCohort(users, 100, settings, now);

    expect(s.roas).toBe(1.25); // 124.97 / 100
    expect(s.cac).toBe(50);
    expect(s.costPerTrial).toBe(33.33);
    // Cumulative: day 14 -> 10.20, day 15 -> 114.77 >= 100.
    expect(s.paybackDays).toBe(15);
    expect(paybackDays(users, 1000)).toBeNull();
    expect(spendNeededFor(1000, s.roas)).toBe(800);
    expect(spendNeededFor(1000, null)).toBeNull();
  });

  test('no spend: no ROAS or CAC', () => {
    const s = summarizeCohort(users, 0, settings, now);
    expect(s).toMatchObject({ roas: null, cac: null, costPerTrial: null, paybackDays: 0 });
  });

  test('sums USD spend in a half-open date range', () => {
    const rows = [
      { date: '2026-11-01', spendUsd: 10, spend: 10 },
      { date: '2026-11-02', spendUsd: null, spend: 5 },
      { date: '2026-11-03', spendUsd: 2.5, spend: 2.5 },
    ].map(r => ({
      ...r,
      channel: 'meta',
      campaignId: 'c',
      campaignName: null,
      currency: 'USD',
      impressions: 0,
      clicks: 0,
    }));

    expect(sumSpend(rows, '2026-11-01', '2026-11-03')).toBe(10);
    expect(sumSpend(rows, '2026-11-01', '2026-11-04')).toBe(12.5);
  });
});

describe('projected LTV', () => {
  test('ARPU per month divided by monthly churn', () => {
    const events = [
      charge('a', daysAgo(10)),
      charge('a', daysAgo(40)),
      charge('a', daysAgo(70)),
      charge('b', daysAgo(10)),
    ];
    const ltv = estimateLtv(
      events,
      [{ userId: 'b', createdAt: daysAgo(5) }],
      settings,
      fx,
      now,
      90,
    );

    // Net 40.80 over 3 months for 2 payers -> 6.80/month; churn 1/3/2 = 0.1667/month.
    expect(ltv.arpuMonthly).toBe(6.8);
    expect(ltv.monthlyChurn).toBe(0.1667);
    expect(ltv.projectedLtv).toBe(40.8);
  });

  test('no churn observed: no projection', () => {
    expect(estimateLtv([charge('a', daysAgo(5))], [], settings, fx, now).projectedLtv).toBeNull();
  });
});

describe('settings', () => {
  test('keeps defaults for invalid values and sorts windows', () => {
    expect(
      normalizeRoiSettings({ revenueWindows: [90, 30, 30, -1], storeFeeRate: 2 as any }),
    ).toMatchObject({
      revenueWindows: [30, 90],
      storeFeeRate: 0.5,
    });
  });
});

describe('Meta Insights client', () => {
  const page = (data: any[], next?: string) =>
    new Response(JSON.stringify({ data, paging: next ? { next } : {} }), { status: 200 });
  const row = (ad: string, spend: string) => ({
    date_start: '2026-11-09',
    account_currency: 'USD',
    campaign_id: '1',
    campaign_name: 'C',
    adset_id: '2',
    adset_name: 'S',
    ad_id: ad,
    ad_name: `Ad ${ad}`,
    spend,
    impressions: '100',
    clicks: '3',
  });

  test('follows pagination and sends the token in a header, not the URL', async () => {
    const calls: { url: string; auth: string }[] = [];
    const responses = [
      page([row('a', '1.50')], 'https://graph.facebook.com/next-page'),
      page([row('b', '2')]),
    ];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.authorization });
      return responses.shift();
    }) as unknown as typeof fetch;

    const rows = await fetchMetaInsights({
      accountId: 'act_1',
      token: 'secret-token',
      since: '2026-11-03',
      until: '2026-11-09',
      fetchImpl: fakeFetch,
    });

    expect(rows.map(r => [r.adId, r.spend, r.impressions, r.clicks])).toEqual([
      ['a', 1.5, 100, 3],
      ['b', 2, 100, 3],
    ]);
    expect(calls[0].url).toContain('level=ad');
    expect(calls[0].url).toContain('time_increment=1');
    expect(
      calls.every(c => !c.url.includes('secret-token') && c.auth === 'Bearer secret-token'),
    ).toBe(true);
    expect(calls[1].url).toBe('https://graph.facebook.com/next-page');
  });

  test('backs off and retries on rate limits', async () => {
    const waits: number[] = [];
    const responses = [
      new Response(
        JSON.stringify({ error: { code: 80000, error_subcode: 2446079, message: 'slow down' } }),
        {
          status: 400,
        },
      ),
      page([row('a', '1')]),
    ];
    const rows = await fetchMetaInsights({
      accountId: 'act_1',
      token: 't',
      since: '2026-11-09',
      until: '2026-11-09',
      fetchImpl: (async () => responses.shift()) as unknown as typeof fetch,
      sleep: async ms => {
        waits.push(ms);
      },
    });

    expect(rows).toHaveLength(1);
    expect(waits).toEqual([5000]);
  });

  test('reports expired tokens clearly', async () => {
    const expired = new Response(
      JSON.stringify({ error: { code: 190, error_subcode: 463, message: 'Session has expired' } }),
      { status: 400 },
    );
    const promise = fetchMetaInsights({
      accountId: 'act_1',
      token: 't',
      since: '2026-11-09',
      until: '2026-11-09',
      fetchImpl: (async () => expired) as unknown as typeof fetch,
    });

    await expect(promise).rejects.toBeInstanceOf(MetaApiError);
    await expect(promise).rejects.toMatchObject({ kind: 'token', code: 190 });
  });

  test('parses account ids with or without act_', () => {
    expect(parseAccountIds(' 123, act_456,123 ,')).toEqual(['act_123', 'act_456']);
  });
});

describe('Google Ads Script payload', () => {
  test('maps micros and normalizes the customer id', () => {
    const rows = mapGoogleRows({
      customerId: '123-456-7890',
      currency: 'usd',
      rangeStart: '2026-11-03',
      rangeEnd: '2026-11-09',
      rows: [
        {
          date: '2026-11-09',
          campaignId: '9',
          campaignName: 'Search',
          adGroupId: '8',
          adGroupName: 'G',
          adId: '7',
          adName: null,
          costMicros: 12_345_678,
          impressions: 10,
          clicks: 1,
        },
      ],
    });

    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
    expect(rows[0]).toMatchObject({
      channel: 'google',
      accountId: '1234567890',
      spend: 12.3457,
      currency: 'USD',
    });
  });

  test('checks the shared secret in constant time', () => {
    expect(isValidScriptSecret('abc', 'abc')).toBe(true);
    expect(isValidScriptSecret('abd', 'abc')).toBe(false);
    expect(isValidScriptSecret('ab', 'abc')).toBe(false);
    expect(isValidScriptSecret(null, 'abc')).toBe(false);
    expect(isValidScriptSecret('abc', undefined)).toBe(false);
  });
});
