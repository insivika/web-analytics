import {
  breakEvenRate,
  buildEconomics,
  type ChannelData,
  cohortTrialToPaying,
  customerValueWithin,
  DEFAULT_SETTINGS,
  DEFAULT_TAP_TO_SIGNUP,
  estimatedPaidConversion,
  leverBreakEven,
  measuredConversion,
  netPer100,
  returnPer100,
  sensitivity,
  valueModel,
  valueWithYearlyShare,
  wilsonInterval,
} from '../roiBreakEven';
import {
  type PlanEconomics,
  type ProjectionInputs,
  type ProjectionMonth,
  project,
  projectionBase,
  type Retention,
  withPaidVisits,
} from '../roiProjection';

// Today's model: 26% yearly at $108.27 net, 74% monthly at $11.62 net, 58% of
// monthly customers still paying at 6 months and 37% at 12.
const retention: Retention = {
  monthly: [1, 0.85, 0.76, 0.69, 0.63, 0.58, 0.53, 0.49, 0.45, 0.42, 0.39, 0.37],
  yearlyRenewal: 0.47,
  yearlyRenewalSample: 30,
  monthlySample: 120,
};
const prices = { yearlyShare: 0.26, yearlyPrice: 108.27, monthlyPrice: 11.62, keepRate: 1 };
const model = valueModel(prices, retention);

describe('customerValueWithin', () => {
  test('one month: the yearly payment plus one monthly payment, by plan mix', () => {
    expect(customerValueWithin(model, 1)).toBeCloseTo(0.26 * 108.27 + 0.74 * 11.62, 6);
    expect(customerValueWithin(model, 1)).toBeCloseTo(36.75, 1);
  });

  test('twelve months: monthly customers pay while still on the curve', () => {
    const kept = retention.monthly.reduce((s, v) => s + v, 0);
    expect(customerValueWithin(model, 12)).toBeCloseTo(0.26 * 108.27 + 0.74 * 11.62 * kept, 6);
    expect(customerValueWithin(model, 12)).toBeCloseTo(89.72, 1);
  });

  test('grows with the window and never counts a yearly renewal (month 13)', () => {
    const v = [1, 3, 6, 12].map(n => customerValueWithin(model, n));
    expect(v).toEqual([...v].sort((a, b) => a - b));
    expect(customerValueWithin(model, 24)).toBeCloseTo(customerValueWithin(model, 12), 6);
  });

  test('per-customer costs come off every active month', () => {
    const withCost = valueModel(prices, retention, 1);
    const kept = retention.monthly.slice(0, 6).reduce((s, v) => s + v, 0);
    expect(customerValueWithin(model, 6) - customerValueWithin(withCost, 6)).toBeCloseTo(
      0.26 * 6 + 0.74 * kept,
      6,
    );
  });

  test('a higher yearly share is worth more when yearly beats a year of monthly', () => {
    expect(valueWithYearlyShare(model, 0.4, 12)).toBeGreaterThan(customerValueWithin(model, 12));
  });
});

describe('breakEvenRate', () => {
  test('cost per paid visit over customer value', () => {
    expect(breakEvenRate(1.87, 91)).toBeCloseTo(0.0205, 4);
    expect(breakEvenRate(1.05, 91)).toBeCloseTo(0.0115, 4);
    expect(breakEvenRate(1.87, 37)).toBeCloseTo(0.0505, 4);
  });

  test('no cost or no value: no break-even', () => {
    expect(breakEvenRate(null, 91)).toBeNull();
    expect(breakEvenRate(0, 91)).toBeNull();
    expect(breakEvenRate(1.5, 0)).toBeNull();
  });

  test('net per $100 is zero exactly at the break-even rate', () => {
    const be = breakEvenRate(1.5, 90) as number;
    expect(netPer100(1.5, be, 90)).toBeCloseTo(0, 6);
    expect(returnPer100(1.5, be, 90)).toBeCloseTo(100, 6);
    const pts = sensitivity(1.5, 90, 0.05, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ rate: 0, net: -100 });
  });
});

describe('estimatedPaidConversion', () => {
  test('(web signups + taps × tap-to-signup) ÷ visits × trial-to-paying', () => {
    // Facebook, last 30 days: 148 paid visits → 45 store taps + 7 web signups.
    const e = estimatedPaidConversion({ visits: 148, taps: 45, webSignups: 7 }, 0.2, 0.25);
    expect(e.webSignupRate).toBeCloseTo(7 / 148, 6);
    expect(e.tapRate).toBeCloseTo(45 / 148, 6);
    expect(e.signupRate).toBeCloseTo((7 + 9) / 148, 6);
    expect(e.rate).toBeCloseTo(((7 + 9) / 148) * 0.25, 6);
  });

  test('no visits: no rate', () => {
    expect(
      estimatedPaidConversion({ visits: 0, taps: 0, webSignups: 0 }, 0.2, 0.3).rate,
    ).toBeNull();
  });

  test('measured: traced payers over paid visits old enough to have paid', () => {
    expect(measuredConversion({ payers: 3, matureVisits: 200, visits: 260 })).toEqual({
      rate: 0.015,
      payers: 3,
      matureVisits: 200,
      immature: true,
    });
  });
});

const month = (m: string, extra: Partial<ProjectionMonth>): ProjectionMonth => ({
  month: m,
  visitors: 1500,
  trials: 30,
  newCustomers: 6,
  moneyIn: 600,
  metaSpend: 0,
  metaClicks: 0,
  googleSpend: 0,
  googleClicks: 0,
  otherSpend: 0,
  ...extra,
});
const history = [
  month('2026-08', {}),
  month('2026-09', { metaSpend: 100, metaClicks: 80, googleSpend: 60, googleClicks: 50 }),
  month('2026-10', { metaSpend: 277, metaClicks: 160, googleSpend: 159, googleClicks: 150 }),
];
const plans: PlanEconomics = {
  webShare: 1,
  monthlyPrice: 11.62,
  yearlyPrice: 108.27,
  keepRate: 1,
  yearlyShare: 0.26,
  monthsKept: 7,
  sources: {
    stripeMonthly: null,
    stripeYearly: null,
    storeMonthly: null,
    storeYearly: null,
    stripeKeepRate: null,
    storeKeepRate: null,
    recentYearlyPaid: null,
    recentMonthlyPaid: null,
  },
  stripePricesMissing: false,
};
const channels: ChannelData = {
  months: [
    {
      month: '2026-10',
      channel: 'meta',
      visits: 148,
      matureVisits: 120,
      taps: 45,
      webSignups: 7,
      payers: 0,
    },
    {
      month: '2026-10',
      channel: 'google',
      visits: 151,
      matureVisits: 130,
      taps: 22,
      webSignups: 5,
      payers: 0,
    },
  ],
  app: [{ month: '2026-10', taps: 120, appSignups: 96 }],
  adCustomers: 5,
  adCustomersThreeMonths: 5,
  adRetention: null,
};

describe('buildEconomics', () => {
  const e = buildEconomics(history, channels, plans, retention, 1, DEFAULT_SETTINGS);

  test("today's break-even rates: Meta ≈ 2.1%, Google ≈ 1.2%, blended ≈ 1.6% at 12 months", () => {
    expect(e.channels.meta.costPerVisit).toBeCloseTo(1.87, 2);
    expect(e.channels.google.costPerVisit).toBeCloseTo(1.05, 2);
    expect(e.channels.meta.breakEven[12]).toBeCloseTo(0.021, 3);
    expect(e.channels.google.breakEven[12]).toBeCloseTo(0.0117, 3);
    expect(e.channels.blended.breakEven[12]).toBeCloseTo(0.0162, 3);
    expect(e.channels.meta.breakEven[1]).toBeCloseTo(0.051, 3);
    expect(e.channels.google.breakEven[1]).toBeCloseTo(0.0286, 3);
    expect(e.channels.blended.breakEven[1]).toBeCloseTo(0.0396, 3);
  });

  test('uses the estimate until 10 payers are traced, at the assumed tap-to-signup rate', () => {
    expect(e.tapToSignup).toEqual({
      value: DEFAULT_TAP_TO_SIGNUP,
      assumed: true,
      observedCeiling: 0.8,
    });
    expect(e.channels.meta.rateSource).toBe('estimated');
    expect(e.channels.meta.rate).toBeCloseTo(((7 + 45 * 0.2) / 148) * (6 / 30), 6);
    expect(e.channels.meta.actualCac).toBeNull();
    const withPayers = buildEconomics(
      history,
      { ...channels, months: channels.months.map(m => ({ ...m, payers: 12 })) },
      plans,
      retention,
      1,
      DEFAULT_SETTINGS,
    );
    expect(withPayers.channels.meta.rateSource).toBe('measured');
    expect(withPayers.channels.meta.rate).toBeCloseTo(12 / 120, 6);
    expect(withPayers.channels.meta.actualCac).toBeCloseTo(277 / 12, 6);
  });

  test('status compares the rate with the break-even rate', () => {
    // Meta estimate ≈ 2.2% vs 2.1% needed at 12 months; ≈ 5.1% needed at 1 month.
    expect(e.channels.meta.status[12]).toBe('profitable');
    expect(e.channels.meta.status[1]).toBe('notYet');
    const thin = buildEconomics(
      history,
      { ...channels, months: channels.months.map(m => ({ ...m, visits: 20 })) },
      plans,
      retention,
      1,
      DEFAULT_SETTINGS,
    );
    expect(thin.channels.meta.status[12]).toBe('notEnoughData');
  });

  test('months with meaningful ad spend', () => {
    expect(e.adMonths).toBe(2);
  });
});

describe('simulator with paid conversion', () => {
  const base = withPaidVisits(projectionBase(history, 1), { meta: 277 / 148, google: 159 / 151 });
  const inputs: ProjectionInputs = {
    metaSpend: 277,
    googleSpend: 159,
    visitorToTrial: 0.02,
    trialToPaying: 0.2,
    adVisitorQuality: 1,
    yearlyShare: 0.26,
    monthlyPrice: 11.62,
    yearlyPrice: 108.27,
    monthsKept: 7,
    keepRate: 1,
    pricier: 0,
    metaPaidConversion: 0.02,
    googlePaidConversion: 0.03,
  };

  test('buys paid visits at cost per paid visit and keeps the rest organic', () => {
    expect(base.metaCpc).toBeCloseTo(1.872, 3);
    expect(base.organicVisitors).toBeCloseTo(1500 - 148 - 151, 6);
  });

  test('extra paid visits convert at their channel rate, not the all-visitor rate', () => {
    const p = project(base, { ...inputs, metaSpend: 277 + 187.2 });
    // $187.20 more on Meta buys 100 visits; 2% become paying customers.
    expect(p.projected.newCustomers - p.today.newCustomers).toBeCloseTo(2, 2);
  });

  test('per-customer and fixed costs come off net income', () => {
    const p = project(base, inputs);
    const q = project(base, { ...inputs, fixedMonthlyCosts: 50 });
    expect(p.todayNetIncome - q.todayNetIncome).toBeCloseTo(50, 6);
  });
});

describe('rolling last 30 days', () => {
  const rolling: ChannelData = {
    ...channels,
    months: [
      ...channels.months,
      {
        month: 'last30',
        channel: 'meta',
        visits: 148,
        matureVisits: 90,
        taps: 45,
        webSignups: 7,
        payers: 0,
      },
      {
        month: 'last30',
        channel: 'google',
        visits: 151,
        matureVisits: 95,
        taps: 22,
        webSignups: 5,
        payers: 0,
      },
    ],
    app: [...channels.app, { month: 'last30', taps: 100, appSignups: 70 }],
    last30Spend: { meta: 277, google: 159 },
  };
  const e = buildEconomics(history, rolling, plans, retention, 'last30', DEFAULT_SETTINGS);

  test('paid traffic and spend come from the rolling rows', () => {
    expect(e.lookback).toBe('last30');
    expect(e.channels.meta.visits).toBe(148);
    expect(e.channels.meta.spend).toBe(277);
    expect(e.channels.meta.costPerVisit).toBeCloseTo(277 / 148, 6);
    expect(e.channels.blended.costPerVisit).toBeCloseTo(436 / 299, 6);
    expect(e.tapToSignup.observedCeiling).toBeCloseTo(0.7, 6);
  });

  test('money in and the simulator baseline come from the last completed month', () => {
    expect(e.months).toEqual(['2026-10']);
    expect(e.base.metaSpend).toBe(277);
    expect(e.base.googleSpend).toBe(159);
  });
});

describe('projection against a baseline', () => {
  test('a better paid rate at the same spend adds customers against today', () => {
    const base = withPaidVisits(projectionBase(history, 1), { meta: 2, google: 1 });
    const today: ProjectionInputs = {
      metaSpend: 277,
      googleSpend: 159,
      visitorToTrial: 0.02,
      trialToPaying: 0.2,
      adVisitorQuality: 1,
      yearlyShare: 0.26,
      monthlyPrice: 11.62,
      yearlyPrice: 108.27,
      monthsKept: 7,
      keepRate: 1,
      pricier: 0,
      metaPaidConversion: 0.01,
      googlePaidConversion: 0.01,
    };
    const better = { ...today, metaPaidConversion: 0.02, googlePaidConversion: 0.02 };
    expect(
      project(base, better).projected.newCustomers - project(base, better).today.newCustomers,
    ).toBeCloseTo(0, 6);
    const p = project(base, better, today);
    // 277/2 + 159/1 = 297.5 paid visits, each 1 point likelier to pay.
    expect(p.projected.newCustomers - p.today.newCustomers).toBeCloseTo(2.975, 6);
  });
});

describe('trial-to-paying by trial cohort', () => {
  const cohorts = [
    { month: '2026-08', trials: 39, paid: 10 },
    { month: '2026-09', trials: 37, paid: 9 },
    { month: '2026-10', trials: 60, paid: 8 },
  ];

  test('paid ÷ trials over the chosen months', () => {
    expect(cohortTrialToPaying(cohorts, ['2026-08', '2026-09'])).toEqual({
      rate: 19 / 76,
      trials: 76,
      paid: 19,
    });
    expect(cohortTrialToPaying(cohorts, ['2026-05'])).toBeNull();
  });

  test('replaces the same-month ratio in the model', () => {
    const e = buildEconomics(history, channels, plans, retention, 1, DEFAULT_SETTINGS, cohorts);
    // Last 6 completed months of the history (Aug–Oct here): 27 of 136.
    expect(e.trialToPaying).toBeCloseTo(27 / 136, 6);
    expect(e.channels.meta.rate).toBeCloseTo(((7 + 45 * 0.2) / 148) * (27 / 136), 6);
  });
});

describe('leverBreakEven', () => {
  it('finds where each lever alone breaks even', () => {
    const l = { trial: 0.08, paying: 0.15, costPerVisit: 0.8, value: 50 };
    const b = leverBreakEven(l);
    expect(b.trial).toBeCloseTo(0.8 / (0.15 * 50));
    expect(b.paying).toBeCloseTo(0.8 / (0.08 * 50));
    expect(b.costPerVisit).toBeCloseTo(0.6);
    expect(b.value).toBeCloseTo(0.8 / 0.012);
    expect(returnPer100(l.costPerVisit, (b.trial as number) * l.paying, l.value)).toBeCloseTo(100);
  });

  it('returns null when a lever cannot fix it', () => {
    expect(
      leverBreakEven({ trial: 0, paying: 0.15, costPerVisit: 0.8, value: 50 }).paying,
    ).toBeNull();
  });
});

describe('wilsonInterval', () => {
  it('brackets the observed share', () => {
    const [lo, hi] = wilsonInterval(37, 187) as [number, number];
    expect(lo).toBeGreaterThan(0.14);
    expect(lo).toBeLessThan(0.198);
    expect(hi).toBeGreaterThan(0.198);
    expect(hi).toBeLessThan(0.27);
  });
  it('is null without a sample', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});
