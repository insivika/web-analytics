import {
  customerValue,
  defaultInputs,
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
