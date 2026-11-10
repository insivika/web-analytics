import { buildFxLookup, fetchFrankfurterRates, toUsd } from '../ads/fx';
import { isValidScriptSecret, mapGoogleRows, normalizeCustomerId } from '../ads/google';
import { fetchMetaInsights, MetaApiError, parseAccountIds } from '../ads/meta';
import { fetchRcMonthly } from '../revenue/revenuecat';
import {
  fetchStripeRevenue,
  mapStripeCharge,
  mapStripeDispute,
  mapStripeRefund,
} from '../revenue/stripe';
import { buildUserMap } from '../revenue/userMap';
import {
  buildMonths,
  lastMonths,
  latestSync,
  monthOf,
  periodBand,
  periodRows,
  STALE_AFTER_HOURS,
  staleSources,
  sumMonths,
} from '../roi';

const now = new Date('2026-11-10T12:00:00Z');
const fx = buildFxLookup([
  { date: '2026-11-06', currency: 'AUD', usdRate: 0.687, source: 'frankfurter' },
  { date: '2026-11-06', currency: 'GBP', usdRate: 1.338, source: 'frankfurter' },
  { date: '2026-11-06', currency: 'GBP', usdRate: 1.3, source: 'manual' },
]);

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

describe('monthly ROI', () => {
  const months = lastMonths(3, now);
  const stripe = [
    // Old customer renewing: money in, not a new customer.
    {
      kind: 'payment',
      userId: 'old',
      customerRef: 'cus_old',
      occurredAt: '2026-06-03T15:00:00Z',
      grossUsd: 5,
      netUsd: 4.55,
    },
    {
      kind: 'payment',
      userId: 'old',
      customerRef: 'cus_old',
      occurredAt: '2026-10-03T15:00:00Z',
      grossUsd: 5,
      netUsd: 4.55,
    },
    // New yearly customer in October.
    {
      kind: 'payment',
      userId: 'y',
      customerRef: 'cus_y',
      occurredAt: '2026-10-20T15:00:00Z',
      grossUsd: 72,
      netUsd: 69.61,
    },
    // New monthly customer in November, then a refund for someone else.
    {
      kind: 'payment',
      userId: null,
      customerRef: 'cus_n',
      occurredAt: '2026-11-02T15:00:00Z',
      grossUsd: 8,
      netUsd: 7.47,
    },
    {
      kind: 'refund',
      userId: 'old',
      customerRef: 'cus_old',
      occurredAt: '2026-11-05T15:00:00Z',
      grossUsd: -5,
      netUsd: -5,
    },
  ];
  const input = {
    spend: new Map([
      ['2026-10', { meta: 200, google: 15.98 }],
      ['2026-11', { meta: 160.27, google: 0 }],
    ]),
    visitors: new Map([
      ['2026-10', 2648],
      ['2026-11', 968],
    ]),
    trials: new Map([
      ['2026-10', 89],
      ['2026-11', 63],
    ]),
    stripe,
    appStores: new Map([
      ['2026-10', { proceeds: 367.9, yearly: 245.37, newCustomers: 14 }],
      ['2026-11', { proceeds: 42.8, yearly: 0, newCustomers: 3 }],
    ]),
  };

  test('lists the last calendar months, current month last', () => {
    expect(months).toEqual(['2026-09', '2026-10', '2026-11']);
  });

  test('money in, yearly plans, new customers and net income per month', () => {
    const rows = buildMonths(months, input);
    expect(rows[1]).toMatchObject({
      month: '2026-10',
      spend: 215.98,
      moneyStripe: 74.16,
      moneyAppStores: 367.9,
      moneyIn: 442.06,
      yearly: 314.98,
      newCustomers: 15,
      netIncome: 226.08,
    });
    expect(rows[2]).toMatchObject({ moneyIn: 45.27, newCustomers: 4, netIncome: -115 });
    expect(rows[0]).toMatchObject({ spend: 0, moneyIn: 0, netIncome: 0 });
  });

  test('periods are sums of months', () => {
    const rows = buildMonths(months, input);
    expect(sumMonths(periodRows(rows, 'this-month'))).toMatchObject({ netIncome: -115 });
    expect(sumMonths(periodRows(rows, 'last-month'))).toMatchObject({ netIncome: 226.08 });
    const q = sumMonths(periodRows(rows, '3-months'));
    expect(q).toMatchObject({
      spend: 376.25,
      moneyIn: 487.33,
      netIncome: 111.08,
      newCustomers: 19,
      costPerCustomer: 19.8,
      visitorToTrial: 0.042,
    });
  });

  test('web app users are kept apart from visitors', () => {
    const rows = buildMonths(months, {
      ...input,
      appUsers: new Map([
        ['2026-10', 503],
        ['2026-11', 112],
      ]),
    });
    expect(rows[1]).toMatchObject({ visitors: 2648, appUsers: 503 });
    expect(sumMonths(rows)).toMatchObject({ visitors: 3616, appUsers: 615 });
    // Leaving them out of the input means zero, not missing.
    expect(buildMonths(months, input)[1].appUsers).toBe(0);
  });

  test('months are UTC, matching RevenueCat', () => {
    // 9 PM in Chicago on Oct 31 is already November in UTC.
    expect(monthOf('2026-11-01T02:00:00Z')).toBe('2026-11');
    expect(monthOf('2026-10-31T23:59:00Z')).toBe('2026-10');
  });

  test('yearly refunds come off the yearly-plan total', () => {
    const rows = buildMonths(months, {
      ...input,
      stripe: [
        ...stripe,
        {
          kind: 'refund',
          userId: 'y',
          customerRef: 'cus_y',
          occurredAt: '2026-11-08T15:00:00Z',
          grossUsd: -72,
          netUsd: -72,
        },
      ],
    });
    expect(rows[2].yearly).toBe(-72);
    expect(rows[2].moneyStripe).toBe(-69.53);
  });

  test('no App Store data: money in is Stripe only and flagged', () => {
    const rows = buildMonths(months, { ...input, appStores: null });
    expect(rows[1]).toMatchObject({ moneyAppStores: null, moneyIn: 74.16 });
    expect(sumMonths(rows).moneyAppStores).toBeNull();
  });
});

describe('sync health and chart band', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const hoursAgo = (h: number) => new Date(+now - h * 3_600_000);

  test('latest sync compares times, not strings', () => {
    // As strings "Wed…" sorts after "Tue…", but Tuesday Nov 10 is later than Wednesday Nov 4.
    const sources = [
      { source: 'fx', lastSuccessAt: new Date('2026-11-04T10:00:00Z') },
      { source: 'stripe', lastSuccessAt: new Date('2026-11-10T10:00:00Z') },
      { source: 'google', lastSuccessAt: null },
    ];
    expect(latestSync(sources)?.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect(latestSync([{ source: 'x', lastSuccessAt: null }])).toBeNull();
  });

  test('sources not synced within the stale window are flagged', () => {
    const stale = staleSources(
      [
        { source: 'meta', lastSuccessAt: hoursAgo(2) },
        { source: 'google', lastSuccessAt: hoursAgo(STALE_AFTER_HOURS + 1) },
        { source: 'stripe', lastSuccessAt: null },
      ],
      now,
    );
    expect(stale.map(s => s.source)).toEqual(['google']);
  });

  test('period band is relative to the first shown month and clamped', () => {
    const all = ['2025-12', '2026-01', '2026-02', '2026-03'];
    expect(periodBand(all, 1, ['2026-02', '2026-03'])).toEqual([1, 2]);
    // Period starts before the first shown month: shade from the first shown one.
    expect(periodBand(all, 2, all)).toEqual([0, 1]);
    expect(periodBand(all, 0, [])).toEqual([-1, -1]);
  });
});

describe('Stripe revenue', () => {
  const bt = (amount: number, fee: number, currency = 'usd') => ({
    amount,
    fee,
    net: amount - fee,
    currency,
  });
  const customer = { id: 'cus_1', metadata: { user_id: 'fb-uid-1' } };

  test('maps charges with the fee and net Stripe booked', () => {
    const row = mapStripeCharge({
      id: 'ch_1',
      status: 'succeeded',
      paid: true,
      amount: 999,
      currency: 'usd',
      created: 1762000000,
      balance_transaction: bt(999, 59),
      customer,
      refunded: false,
      description: 'Pro monthly',
    });
    expect(row).toMatchObject({
      kind: 'payment',
      externalId: 'ch_1',
      grossUsd: 9.99,
      feeUsd: 0.59,
      netUsd: 9.4,
      userRef: 'fb-uid-1',
      customerRef: 'cus_1',
    });
    expect(mapStripeCharge({ id: 'ch_2', status: 'failed', paid: false })).toBeNull();
  });

  test('refunds and disputes are negative', () => {
    expect(
      mapStripeRefund({
        id: 're_1',
        status: 'succeeded',
        amount: 999,
        currency: 'usd',
        created: 1762000000,
        balance_transaction: bt(-999, 0),
        charge: { customer },
      }),
    ).toMatchObject({
      kind: 'refund',
      amount: -9.99,
      grossUsd: -9.99,
      netUsd: -9.99,
      userRef: 'fb-uid-1',
    });
    expect(
      mapStripeDispute({
        id: 'dp_1',
        amount: 999,
        currency: 'usd',
        created: 1762000000,
        charge: { customer },
        balance_transactions: [bt(-999, 1500)],
      }),
    ).toMatchObject({ kind: 'dispute', grossUsd: -9.99, feeUsd: 15, netUsd: -24.99 });
  });

  test('non-USD settlement leaves USD empty for FX conversion', () => {
    const row = mapStripeCharge({
      id: 'ch_3',
      status: 'succeeded',
      paid: true,
      amount: 1000,
      currency: 'gbp',
      created: 1762000000,
      balance_transaction: bt(1000, 50, 'gbp'),
      customer: 'cus_9',
    });
    expect(row).toMatchObject({ grossUsd: null, customerRef: 'cus_9', userRef: null });
  });

  test('pages through lists with the key in a header', async () => {
    const calls: { url: string; auth: string }[] = [];
    const fetchImpl: any = async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.authorization });
      const page = url.includes('starting_after') ? 2 : 1;
      const data = url.includes('/v1/charges')
        ? [
            {
              id: `ch_${page}`,
              status: 'succeeded',
              paid: true,
              amount: 500,
              currency: 'usd',
              created: 1,
              balance_transaction: bt(500, 30),
            },
          ]
        : [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data, has_more: url.includes('/v1/charges') && page === 1 }),
      };
    };
    const rows = await fetchStripeRevenue('rk_test_x', 0, fetchImpl);
    expect(rows.map(r => r.externalId)).toEqual(['ch_1', 'ch_2']);
    expect(calls.every(c => c.auth === 'Bearer rk_test_x' && !c.url.includes('rk_test'))).toBe(
      true,
    );
  });
});

describe('Stripe disputes', () => {
  test('disputes are re-read from an earlier date than charges', async () => {
    const urls: string[] = [];
    const fetchImpl: any = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) };
    };
    await fetchStripeRevenue('rk_test_x', 2000, fetchImpl, 1000);
    const created = (path: string) =>
      new URL(urls.find(u => u.includes(path))).searchParams.get('created[gte]');
    expect(created('/v1/charges')).toBe('2000');
    expect(created('/v1/disputes')).toBe('1000');
  });

  test('a won dispute nets to just the fee', () => {
    const row = mapStripeDispute({
      id: 'dp_won',
      amount: 999,
      currency: 'usd',
      created: 1762000000,
      balance_transactions: [
        { amount: -999, fee: 1500, net: -2499, currency: 'usd' },
        { amount: 999, fee: 0, net: 999, currency: 'usd' },
      ],
    });
    expect(row).toMatchObject({ grossUsd: 0, feeUsd: 15, netUsd: -15 });
  });
});

describe('RevenueCat revenue', () => {
  test('reads monthly proceeds, yearly part and new subscriptions from the revenue chart', async () => {
    const chart = (segments: string[], vals: [number, number, number, number][]) => ({
      ok: true,
      status: 200,
      json: async () => ({
        segments: segments.map((n, i) => ({ display_name: n, is_total: i === 0 })),
        values: vals.map(([cohort, measure, segment, value]) => ({
          cohort,
          measure,
          segment,
          value,
        })),
      }),
    });
    const oct = 1790812800;
    const fetchImpl: any = async (url: string) =>
      url.includes('segment=store')
        ? chart(
            ['Total', 'App Store', 'Stripe'],
            [
              [oct, 0, 1, 347.9],
              [oct, 0, 2, 20],
            ],
          )
        : url.includes('transaction_type')
          ? chart(
              ['Total', 'New', 'Renewal'],
              [
                [oct, 0, 0, 367.9],
                [oct, 1, 1, 14],
                [oct, 0, 1, 344.11],
              ],
            )
          : chart(
              ['Total', 'P1Y', 'P1M'],
              [
                [oct, 0, 1, 245.37],
                [oct, 0, 2, 122.53],
              ],
            );
    const months = await fetchRcMonthly('2026-10-01', '2026-10-31', {
      key: 'k',
      projectId: 'p',
      fetchImpl,
    });
    // Purchases RevenueCat tracks through Stripe are left out (Stripe is counted on its own).
    expect(months.get('2026-10')).toEqual({ proceeds: 347.9, yearly: 245.37, newCustomers: 14 });
  });
});

describe('user mapping', () => {
  const map = buildUserMap([
    { user_id: 'u-1', firebase_user_id: 'fb-1', stripe_customer_id: 'cus_1' },
    { user_id: 'u-2', firebase_user_id: null, stripe_customer_id: null },
  ]);

  test('resolves Supabase ids, older Firebase ids and Stripe customer ids', () => {
    expect(map.resolve('u-2')).toBe('u-2');
    expect(map.resolve('fb-1')).toBe('u-1');
    expect(map.resolve(null, 'cus_1')).toBe('u-1');
    expect(map.resolve('unknown', 'cus_x')).toBeNull();
    expect(map.firebaseUid('u-1')).toBe('fb-1');
    expect(map.firebaseUid('u-2')).toBeNull();
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
