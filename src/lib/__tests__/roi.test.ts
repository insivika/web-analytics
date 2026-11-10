import { buildFxLookup, fetchFrankfurterRates, toUsd } from '../ads/fx';
import { isValidScriptSecret, mapGoogleRows, normalizeCustomerId } from '../ads/google';
import { fetchMetaInsights, MetaApiError, parseAccountIds } from '../ads/meta';
import {
  fetchRcCustomerRevenue,
  fetchRcMonthly,
  mapRcPurchase,
  mapRcSubscription,
} from '../revenue/revenuecat';
import {
  fetchStripeRevenue,
  mapStripeCharge,
  mapStripeDispute,
  mapStripeRefund,
} from '../revenue/stripe';
import { buildUserMap } from '../revenue/userMap';
import { buildMonths, lastMonths, periodRows, sumMonths } from '../roi';

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

  test('no App Store data: money in is Stripe only and flagged', () => {
    const rows = buildMonths(months, { ...input, appStores: null });
    expect(rows[1]).toMatchObject({ moneyAppStores: null, moneyIn: 74.16 });
    expect(sumMonths(rows).moneyAppStores).toBeNull();
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

describe('RevenueCat revenue', () => {
  test('uses cumulative subscription revenue and skips sandbox and trial-only', () => {
    const sub = (extra: any) => ({
      id: 'sub_1',
      environment: 'production',
      starts_at: 1762000000000,
      product_id: 'pro_monthly',
      total_revenue_in_usd: { gross: 29.97, commission: 4.5, tax: 2, proceeds: 23.47 },
      ...extra,
    });
    expect(mapRcSubscription(sub({}), 'fb-1')).toMatchObject({
      kind: 'subscription',
      grossUsd: 29.97,
      feeUsd: 6.5,
      netUsd: 23.47,
      userRef: 'fb-1',
    });
    expect(mapRcSubscription(sub({ environment: 'sandbox' }), 'fb-1')).toBeNull();
    expect(mapRcSubscription(sub({ total_revenue_in_usd: { gross: 0 } }), 'fb-1')).toBeNull();
  });

  test('refunded purchases carry no net revenue', () => {
    expect(
      mapRcPurchase(
        {
          id: 'p1',
          environment: 'production',
          purchased_at: 1,
          status: 'refunded',
          revenue_in_usd: { gross: 50, commission: 7.5, tax: 0, proceeds: 42.5 },
        },
        'fb-1',
      ),
    ).toMatchObject({ grossUsd: 50, netUsd: 0, refunded: true });
  });

  test('retries after a rate limit and treats unknown customers as empty', async () => {
    let hits = 0;
    const fetchImpl: any = async (url: string) => {
      if (url.includes('/customers/missing/'))
        return { ok: false, status: 404, json: async () => ({}) };
      hits++;
      if (hits === 1)
        return {
          ok: false,
          status: 429,
          headers: { get: () => '1' },
          json: async () => ({ backoff_ms: 10 }),
        };
      const items = url.includes('/subscriptions')
        ? [
            {
              id: 's',
              environment: 'production',
              starts_at: 1,
              total_revenue_in_usd: { gross: 10, commission: 1.5, tax: 0, proceeds: 8.5 },
            },
          ]
        : [];
      return { ok: true, status: 200, json: async () => ({ items, next_page: null }) };
    };
    const opts = { key: 'sk_x', projectId: 'proj', fetchImpl, sleep: async () => {} };
    expect(await fetchRcCustomerRevenue('fb-1', opts)).toHaveLength(1);
    expect(await fetchRcCustomerRevenue('missing', opts)).toEqual([]);
  });

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
      url.includes('transaction_type')
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
    expect(months.get('2026-10')).toEqual({ proceeds: 367.9, yearly: 245.37, newCustomers: 14 });
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
