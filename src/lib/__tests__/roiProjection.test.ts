import {
  buildRetention,
  customerValue,
  defaultInputs,
  outlook,
  type ProjectionMonth,
  paidVisitors,
  planEconomics,
  project,
  projectionBase,
} from '../roiProjection';

const month = (m: string, extra: Partial<ProjectionMonth>): ProjectionMonth => ({
  month: m,
  visitors: 0,
  trials: 0,
  newCustomers: 0,
  moneyIn: 0,
  metaSpend: 0,
  metaClicks: 0,
  googleSpend: 0,
  googleClicks: 0,
  otherSpend: 0,
  ...extra,
});

// Aug–Oct 2026, the real months behind the prototype.
const history = [
  month('2026-05', { visitors: 1570, trials: 23, newCustomers: 3, moneyIn: 310 }),
  month('2026-06', {
    visitors: 2061,
    trials: 20,
    newCustomers: 8,
    moneyIn: 473,
    googleSpend: 113.94,
    googleClicks: 93,
  }),
  month('2026-07', { visitors: 2427, trials: 38, newCustomers: 7, moneyIn: 605 }),
  month('2026-08', { visitors: 3206, trials: 39, newCustomers: 9, moneyIn: 558 }),
  month('2026-09', {
    visitors: 2856,
    trials: 37,
    newCustomers: 17,
    moneyIn: 609,
    metaSpend: 7.9,
    metaClicks: 2,
    googleSpend: 25.08,
    googleClicks: 26,
  }),
  month('2026-10', {
    visitors: 2630,
    trials: 95,
    newCustomers: 20,
    moneyIn: 998,
    metaSpend: 160.8,
    metaClicks: 88,
    googleSpend: 180.56,
    googleClicks: 169,
    otherSpend: 55.18,
  }),
];
const value = planEconomics({
  stripePrices: { month: { amount: 12 }, year: { amount: 108 } },
  storePrices: { monthly: 9.99, yearly: 99.99, keepRate: 0.7, yearlyShare: 0.1 },
  stripeFeeRate: 0.06,
  stripeYearlyShare: 0.33,
  stripeNewCustomers: 30,
  storeNewCustomers: 10,
  monthsKept: 6.7,
  recentYearlyPaid: 70.88,
  recentMonthlyPaid: 8.75,
});

describe('plan economics', () => {
  test('prices, fees and mix are weighted by where new customers paid', () => {
    // 30 of 40 new customers paid on the web.
    expect(value.webShare).toBe(0.75);
    expect(value.monthlyPrice).toBeCloseTo(0.75 * 12 + 0.25 * 9.99, 2);
    expect(value.yearlyPrice).toBeCloseTo(0.75 * 108 + 0.25 * 99.99, 2);
    expect(value.keepRate).toBeCloseTo(0.75 * 0.94 + 0.25 * 0.7, 3);
    expect(value.yearlyShare).toBeCloseTo(0.75 * 0.33 + 0.25 * 0.1, 2);
    expect(value.stripePricesMissing).toBe(false);
  });

  test('without Stripe price access, store prices and recent payments fill in', () => {
    const p = planEconomics({
      stripePrices: null,
      storePrices: null,
      stripeFeeRate: 0.06,
      stripeYearlyShare: 0.33,
      stripeNewCustomers: 10,
      storeNewCustomers: 0,
      monthsKept: null,
      recentYearlyPaid: 70.88,
      recentMonthlyPaid: 8.75,
    });
    expect(p.stripePricesMissing).toBe(true);
    expect(p.monthlyPrice).toBeNull();
    const i = defaultInputs(projectionBase(history, 3), p);
    expect(i.monthlyPrice).toBe(8.75);
    expect(i.yearlyPrice).toBe(70.88);
    expect(i.monthsKept).toBe(6);
  });

  test('a yearly customer pays up front, a monthly one for each month they stay', () => {
    const v = customerValue({
      ...defaultInputs(projectionBase(history, 3), value),
      yearlyShare: 0.25,
      yearlyPrice: 100,
      monthlyPrice: 10,
      monthsKept: 6,
      keepRate: 0.9,
    });
    expect(v.firstMonth).toBeCloseTo(0.9 * (0.25 * 100 + 0.75 * 10), 6);
    expect(v.firstYear).toBeCloseTo(0.9 * (0.25 * 100 + 0.75 * 60), 6);
  });
});

describe('ad spend projection', () => {
  const base = projectionBase(history, 3);

  test('base comes from the chosen months, with organic visitors net of ad clicks', () => {
    expect(base.months).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(Math.round(base.visitors)).toBe(2897);
    expect(Math.round(base.organicVisitors)).toBe(2802);
    expect(base.metaCpc).toBeCloseTo(168.7 / 90, 3);
    expect(base.googleCpc).toBeCloseTo(205.64 / 195, 3);
    expect(base.visitorToTrial).toBeCloseTo(171 / 8692, 5);
    expect(base.trialToPaying).toBeCloseTo(46 / 171, 5);
  });

  test("starting values reproduce today's numbers", () => {
    const p = project(base, defaultInputs(base, value));
    expect(p.netIncome).toBeCloseTo(p.todayNetIncome, 6);
    expect(p.projected.newCustomers).toBeCloseTo(p.today.newCustomers, 6);
    // Today's net income is average money in minus all ad spend, app installs included.
    expect(p.todayNetIncome).toBeCloseTo(721.67 - (56.23 + 68.55) - 18.39, 1);
  });

  test('more spend brings more visitors and customers, at a cost', () => {
    const inputs = { ...defaultInputs(base, value), metaSpend: 500 };
    const p = project(base, inputs);
    expect(p.projected.visitors).toBeGreaterThan(p.today.visitors);
    expect(p.projected.newCustomers).toBeGreaterThan(p.today.newCustomers);
    expect(p.costPerCustomerFromAds).toBeGreaterThan(0);
    expect(p.beyondHistory).toBe(true);
  });

  test('ad visitors converting worse means fewer customers from ads', () => {
    const inputs = { ...defaultInputs(base, value), metaSpend: 500 };
    const same = project(base, inputs);
    const worse = project(base, { ...inputs, adVisitorQuality: 0.5 });
    expect(worse.customersFromAds).toBeCloseTo(same.customersFromAds / 2, 6);
  });

  test('clicks get pricier past the spend you had, and cost the same below it', () => {
    expect(paidVisitors(100, 1, 200, 0.15)).toBe(100);
    expect(paidVisitors(400, 1, 200, 0)).toBe(400);
    // Doubling past the reference with 15% pricier clicks: 400 / 1.15.
    expect(paidVisitors(400, 1, 200, 0.15)).toBeCloseTo(400 / 1.15, 6);
    expect(paidVisitors(100, null, 0, 0.15)).toBe(0);
  });

  test('a platform with no clicks in the window falls back to all history', () => {
    const one = projectionBase(history.slice(0, 4), 1); // August: no ads at all
    expect(one.googleCpc).toBeCloseTo(113.94 / 93, 3);
    expect(one.metaCpc).toBeNull();
  });

  test('no ads: customers from ads are zero and so is the return', () => {
    const p = project(base, { ...defaultInputs(base, value), metaSpend: 0, googleSpend: 0 });
    expect(p.customersFromAds).toBe(0);
    expect(p.costPerCustomerFromAds).toBeNull();
    expect(p.firstYearReturn).toBe(0);
  });
});

describe('12-month outlook', () => {
  const base = projectionBase(history, 3);
  const retention = buildRetention([
    { kind: 'monthly', age: 2, eligible: 100, paying: 80 },
    { kind: 'monthly', age: 3, eligible: 100, paying: 70 },
    // Too few customers to trust: the curve holds at the last good value.
    { kind: 'monthly', age: 4, eligible: 5, paying: 5 },
    { kind: 'monthly', age: 5, eligible: 100, paying: 60 },
    { kind: 'yearly', age: 13, eligible: 15, paying: 7 },
  ]);

  test('retention curve starts at 1 and never rises', () => {
    expect(retention.monthly.slice(0, 5)).toEqual([1, 0.8, 0.7, 0.7, 0.6]);
    expect(retention.monthly).toHaveLength(12);
    expect(retention.yearlyRenewal).toBeCloseTo(7 / 15, 3);
  });

  test("today's spend: the outlook is flat at today's net income", () => {
    const o = outlook(base, defaultInputs(base, value), retention);
    expect(o.extraCustomersPerMonth).toBeCloseTo(0, 6);
    expect(o.months.every(m => Math.abs(m.projected - m.today) < 1e-6)).toBe(true);
    expect(o.paybackMonth).toBeNull();
  });

  test('extra customers stack up month over month', () => {
    const inputs = {
      ...defaultInputs(base, value),
      metaSpend: base.metaSpend + 500,
      yearlyShare: 0,
      monthlyPrice: 10,
      keepRate: 1,
    };
    const o = outlook(base, inputs, { ...retention, monthly: Array(12).fill(1) });
    const gain = (m: number) => o.months[m - 1].projected - o.months[m - 1].today;
    // With no drop-off, month t earns t batches of monthly revenue.
    expect(gain(2) - gain(1)).toBeCloseTo(o.extraCustomersPerMonth * 10, 6);
    expect(o.months[11].extraPaying).toBeCloseTo(12 * o.extraCustomersPerMonth, 6);
  });

  test('payback is the first month the running total turns positive', () => {
    const inputs = {
      ...defaultInputs(base, value),
      googleSpend: base.googleSpend + 100,
      yearlyShare: 0,
      monthlyPrice: 200,
      keepRate: 1,
    };
    const o = outlook(base, inputs, { ...retention, monthly: Array(12).fill(1) });
    let running = 0;
    let first = 0;
    for (const m of o.months) {
      running += m.projected - m.today;
      if (running > 0) {
        first = m.month;
        break;
      }
    }
    expect(first).toBeGreaterThan(0);
    expect(o.paybackMonth).toBe(first);
  });
});
