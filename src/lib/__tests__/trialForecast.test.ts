import { DAY_MS, DEFAULT_TRIAL_SETTINGS, type TrialActivityRow } from '../trial';
import {
  backtest,
  buildTrainingRows,
  computeEarlyFeatures,
  computeFirstPaymentValue,
  computeForecastAccuracy,
  computeTrialForecast,
  DEFAULT_FORECAST_SETTINGS,
  type ForecastUser,
  fitSegmentModel,
  fitTimingCurve,
  getForecastSince,
  priorTimingWeights,
  resolveOutcome,
  segmentOf,
  simulateSum,
  smoothRate,
  timingCdf,
  userProbability,
} from '../trialForecast';

const settings = DEFAULT_TRIAL_SETTINGS;
const fs = DEFAULT_FORECAST_SETTINGS;
const now = new Date('2026-11-10T12:00:00Z');
const daysAgo = (d: number) => new Date(+now - d * DAY_MS).toISOString();

const user = (over: Partial<ForecastUser> = {}): ForecastUser => ({
  userId: 'u',
  trialStart: daysAgo(20),
  platform: 'ios',
  isInternal: false,
  activeDays: 1,
  activated: false,
  recurringCreated: false,
  paywallShown: false,
  pushEligible: true,
  pushOptIn: false,
  engagementCount: 0,
  convertedAt: null,
  undatedConversion: false,
  plan: null,
  earlyActiveDays: 1,
  earlyActivated: false,
  ...over,
});

describe('smoothRate', () => {
  it('pulls small segments toward the base rate', () => {
    // 1 of 2 converted (50%) with base 10% and k = 10 → (1 + 1) / 12
    expect(smoothRate(1, 2, 0.1, 10)).toBeCloseTo(2 / 12);
    // Large segments keep their own rate.
    expect(smoothRate(400, 1000, 0.1, 10)).toBeCloseTo(401 / 1010);
    // No data → base rate.
    expect(smoothRate(0, 0, 0.13, 10)).toBeCloseTo(0.13);
  });
});

describe('timing curve', () => {
  it('prior sums to 1 and peaks at trial end', () => {
    const w = priorTimingWeights(14, 16);
    expect(w).toHaveLength(30);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1);
    expect(w[13]).toBeGreaterThan(w[5]);
    expect(w[14]).toBeGreaterThan(w[29]);
  });

  const done = (convertedDay: number | null) => ({ elapsed: 30, convertedDay });

  it('mixes observed days with the prior and gives a monotone CDF', () => {
    const curve = fitTimingCurve(
      [14, 14, 15, 18, 20].map(done).concat(Array.from({ length: 30 }, () => done(null))),
      14,
      16,
      10,
    );
    expect(curve.n).toBe(5);
    expect(curve.daily.reduce((s, x) => s + x, 0)).toBeCloseTo(1);
    expect(timingCdf(curve, 0)).toBe(0);
    expect(timingCdf(curve, 30)).toBe(1);
    expect(timingCdf(curve, 14.5)).toBeGreaterThan(timingCdf(curve, 14));
    expect(timingCdf(curve, 21)).toBeGreaterThan(timingCdf(curve, 14));
  });

  it('corrects for censoring: recent trials do not make purchases look early', () => {
    // 20 complete trials: 4 buy on day 20. 200 recent trials (elapsed 15): 4 buy on day 14.
    const entries = [
      ...Array.from({ length: 4 }, () => done(20)),
      ...Array.from({ length: 16 }, () => done(null)),
      ...Array.from({ length: 4 }, () => ({ elapsed: 15, convertedDay: 14 })),
      ...Array.from({ length: 196 }, () => ({ elapsed: 15, convertedDay: null })),
    ];
    const curve = fitTimingCurve(entries, 14, 16, 10);
    // Naive counting would put half the mass by day 15 (4 of 8 conversions);
    // per user at risk, day 20 (4 of ~20) carries far more than day 14 (4 of 220).
    expect(timingCdf(curve, 15)).toBeLessThan(0.4);
    expect(curve.daily[20]).toBeGreaterThan(curve.daily[14]);
    expect(curve.n).toBe(8);
  });

  it('uses the prior shape where no trial has data', () => {
    const curve = fitTimingCurve([], 14, 16, 10);
    const prior = priorTimingWeights(14, 16);
    curve.daily.forEach((d, i) => {
      expect(d).toBeCloseTo(prior[i], 2);
    });
  });
});

describe('fitSegmentModel', () => {
  it('uses exposure so open trials are not counted as failures', () => {
    const rows = [
      { features: { earlyActiveDays: 3, earlyActivated: true }, converted: true, exposure: 1 },
      { features: { earlyActiveDays: 3, earlyActivated: true }, converted: false, exposure: 0.1 },
      { features: { earlyActiveDays: 1, earlyActivated: false }, converted: false, exposure: 1 },
    ];
    const model = fitSegmentModel(rows, 10);
    expect(model.baseRate).toBeCloseTo(1 / 2.1);
    const engaged = model.predict({ earlyActiveDays: 3, earlyActivated: true });
    expect(engaged.segment).toBe('3|activated');
    expect(engaged.p).toBeCloseTo((1 + 10 * (1 / 2.1)) / (1.1 + 10));
    // Unseen segment falls back to the base rate.
    expect(model.predict({ earlyActiveDays: 2, earlyActivated: false }).p).toBeCloseTo(1 / 2.1);
  });

  it('buckets early active days', () => {
    expect(segmentOf({ earlyActiveDays: 0, earlyActivated: false })).toBe('0-1|not-activated');
    expect(segmentOf({ earlyActiveDays: 2, earlyActivated: true })).toBe('2|activated');
    expect(segmentOf({ earlyActiveDays: 5, earlyActivated: true })).toBe('3|activated');
  });
});

describe('userProbability', () => {
  const curve = fitTimingCurve([], 14, 16, 10);
  const model = fitSegmentModel(
    [
      { features: { earlyActiveDays: 3, earlyActivated: true }, converted: true, exposure: 1 },
      { features: { earlyActiveDays: 1, earlyActivated: false }, converted: false, exposure: 1 },
    ],
    0,
  );

  it('blends toward the base rate while early behavior is incomplete', () => {
    const f = { earlyActiveDays: 1, earlyActivated: true };
    const day0 = userProbability(model, curve, { earlyActiveDays: 3, earlyActivated: true }, 0, 3);
    const day3 = userProbability(model, curve, { earlyActiveDays: 3, earlyActivated: true }, 3, 3);
    // At t = 0 only the base rate (0.5) counts; by day 3 the segment (1.0) does.
    expect(day0.pTotal).toBeCloseTo(0.5);
    expect(day3.pTotal).toBeGreaterThan(day0.pTotal);
    expect(userProbability(model, curve, f, 1.5, 3).pTotal).toBeLessThanOrEqual(1);
  });

  it('horizon probabilities grow with the horizon and stay below the total', () => {
    const p = userProbability(model, curve, { earlyActiveDays: 1, earlyActivated: false }, 10, 3);
    expect(p.p7).toBeLessThanOrEqual(p.p14);
    expect(p.p14).toBeLessThanOrEqual(p.pTotal + 1e-9);
  });

  it('conditions on not having converted yet: P falls as the window runs out', () => {
    const m = fitSegmentModel(
      [{ features: { earlyActiveDays: 3, earlyActivated: true }, converted: true, exposure: 4 }],
      0,
    ); // p = 0.25
    const f = { earlyActiveDays: 3, earlyActivated: true };
    const early = userProbability(m, curve, f, 5, 3).pTotal;
    const late = userProbability(m, curve, f, 25, 3).pTotal;
    expect(early).toBeGreaterThan(late);
    expect(userProbability(m, curve, f, 30, 3).pTotal).toBe(0);
  });
});

describe('simulateSum', () => {
  it('returns the exact expectation and a P10–P90 range around it', () => {
    const p = Array.from({ length: 100 }, () => 0.2);
    const r = simulateSum(p, undefined, 5000, 1);
    expect(r.expected).toBeCloseTo(20);
    // Binomial(100, 0.2): sd = 4 → P10 ≈ 15, P90 ≈ 25
    expect(r.low).toBeGreaterThanOrEqual(13);
    expect(r.low).toBeLessThanOrEqual(17);
    expect(r.high).toBeGreaterThanOrEqual(23);
    expect(r.high).toBeLessThanOrEqual(27);
  });

  it('is deterministic for a seed and handles values and empty input', () => {
    const p = [0.5, 0.5, 0.1];
    expect(simulateSum(p, undefined, 1000, 3)).toEqual(simulateSum(p, undefined, 1000, 3));
    expect(simulateSum(p, [10, 10, 100]).expected).toBeCloseTo(20);
    expect(simulateSum([])).toEqual({ expected: 0, low: 0, high: 0 });
    expect(simulateSum([1, 1, 0])).toMatchObject({ low: 2, high: 2 });
  });
});

describe('computeEarlyFeatures', () => {
  const start = new Date(daysAgo(10));
  const row = (eventName: string, day: number): TrialActivityRow => ({
    userId: 'u',
    eventName,
    day,
    count: 1,
    firstAt: new Date(+start + day * DAY_MS + 3600_000),
  });
  const activity = [
    row('trial_day_active', 0),
    row('trial_day_active', 1),
    row('activation_complete', 1),
    row('trial_day_active', 2),
    row('trial_day_active', 5),
  ];

  it('only counts the first N trial days', () => {
    expect(computeEarlyFeatures('u', start, activity, settings, 3, now)).toEqual({
      earlyActiveDays: 3,
      earlyActivated: true,
    });
  });

  it('never looks past the cutoff', () => {
    const cutoff = new Date(+start + 1 * DAY_MS);
    expect(computeEarlyFeatures('u', start, activity, settings, 3, cutoff)).toEqual({
      earlyActiveDays: 1,
      earlyActivated: false,
    });
  });
});

describe('buildTrainingRows', () => {
  const curve = fitTimingCurve([], 14, 16, 10);
  const window = { trialLengthDays: 14, postTrialDays: 16 };

  it('ignores conversions after the as-of date and gives open trials partial exposure', () => {
    const asOf = new Date(daysAgo(5));
    const rows = buildTrainingRows(
      [
        user({ trialStart: daysAgo(40), convertedAt: daysAgo(25) }),
        user({ trialStart: daysAgo(20), convertedAt: daysAgo(2) }), // after asOf
        user({ trialStart: daysAgo(6) }), // early window not over at asOf
      ],
      curve,
      asOf,
      window,
      3,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ converted: true, exposure: 1 });
    expect(rows[1].converted).toBe(false);
    expect(rows[1].exposure).toBeCloseTo(timingCdf(curve, 15));
  });
});

describe('computeFirstPaymentValue', () => {
  it('uses plan mix, list prices and real net ratios', () => {
    const v = computeFirstPaymentValue(
      ['monthly', 'monthly', 'annual'],
      [
        { source: 'stripe', kind: 'payment', grossUsd: 100, netUsd: 96 },
        { source: 'revenuecat', kind: 'subscription', grossUsd: 100, netUsd: 70 },
        { source: 'stripe', kind: 'refund', grossUsd: -10, netUsd: -10 },
      ],
      fs,
    );
    const share = 3 / 5; // (2 + 1) / (3 + 2)
    const gross = share * 12 + (1 - share) * 108;
    expect(v.monthlyShare).toBeCloseTo(share);
    expect(v.basis).toBe('net');
    expect(v.byPlatform.web).toBeCloseTo(gross * 0.96);
    expect(v.byPlatform.ios).toBeCloseTo(gross * 0.7);
  });

  it('keeps a provider without transactions at gross instead of borrowing the other ratio', () => {
    const v = computeFirstPaymentValue(
      [],
      [{ source: 'stripe', kind: 'payment', grossUsd: 100, netUsd: 94 }],
      fs,
    );
    expect(v.basis).toBe('partial');
    expect(v.byPlatform.web).toBeCloseTo(60 * 0.94);
    expect(v.byPlatform.ios).toBeCloseTo(60);
  });

  it('falls back to gross without transactions', () => {
    const v = computeFirstPaymentValue([], [], fs);
    expect(v.basis).toBe('gross');
    expect(v.byPlatform.ios).toBeCloseTo(60);
  });
});

describe('resolveOutcome', () => {
  const window = { trialLengthDays: 14, postTrialDays: 16 };

  it('resolves conversions, closed windows and open trials', () => {
    expect(resolveOutcome(daysAgo(20), daysAgo(3), now, window)).toEqual({
      outcome: true,
      convertedAt: daysAgo(3),
    });
    expect(resolveOutcome(daysAgo(31), null, now, window)).toEqual({
      outcome: false,
      convertedAt: null,
    });
    expect(resolveOutcome(daysAgo(20), null, now, window).outcome).toBeNull();
    // Purchases after the window don't count as trial conversions.
    expect(resolveOutcome(daysAgo(60), daysAgo(2), now, window).outcome).toBe(false);
  });
});

describe('getForecastSince', () => {
  it('needs every event tracked and takes the latest date', () => {
    expect(
      getForecastSince({ converted: '2026-10-08', active2: '2026-10-01', activated: '2026-09-01' }),
    ).toBe('2026-10-08');
    expect(getForecastSince({ converted: null, active2: '2026-10-01', activated: 'x' })).toBeNull();
  });
});

/** A synthetic cohort: engaged users convert at day ~15 with 40%, others 5%. */
function cohort(n: number) {
  const users: ForecastUser[] = [];
  const activity: TrialActivityRow[] = [];
  for (let i = 0; i < n; i++) {
    const startDays = 50 - (i % 50);
    const engaged = i % 3 === 0;
    const id = `u${i}`;
    const start = daysAgo(startDays);
    const converts = engaged ? i % 5 < 2 : i % 20 === 1;
    const convertedDay = 14 + (i % 4);
    users.push(
      user({
        userId: id,
        trialStart: start,
        activeDays: engaged ? 4 : 1,
        activated: engaged,
        earlyActiveDays: engaged ? 3 : 1,
        earlyActivated: engaged,
        convertedAt:
          converts && startDays > convertedDay
            ? new Date(+new Date(start) + convertedDay * DAY_MS).toISOString()
            : null,
        plan: converts ? 'monthly' : null,
        platform: i % 2 ? 'ios' : 'web',
      }),
    );
    for (let d = 0; d < (engaged ? 3 : 1); d++) {
      activity.push({
        userId: id,
        eventName: 'trial_day_active',
        day: d,
        count: 1,
        firstAt: new Date(+new Date(start) + d * DAY_MS + 60_000),
      });
    }
    if (engaged) {
      activity.push({
        userId: id,
        eventName: 'activation_complete',
        day: 0,
        count: 1,
        firstAt: new Date(+new Date(start) + 120_000),
      });
    }
  }
  return { users, activity };
}

describe('computeTrialForecast', () => {
  const { users, activity } = cohort(300);

  it('forecasts only unconverted users inside the conversion window, respecting filters', () => {
    const f = computeTrialForecast({
      users,
      activity,
      trialSettings: settings,
      since: daysAgo(60),
      now,
      revenueTxns: [],
      filters: { platform: 'ios', excludeInternal: true },
    });
    expect(f.available).toBe(true);
    expect(f.rows.every(r => r.platform === 'ios')).toBe(true);
    expect(f.rows.every(r => +new Date(r.trialStart) > +now - 30 * DAY_MS)).toBe(true);
    expect(f.headline.conversions14.expected).toBeGreaterThanOrEqual(
      f.headline.conversions7.expected,
    );
    expect(f.headline.conversions14.low).toBeLessThanOrEqual(f.headline.conversions14.expected);
    expect(f.headline.conversions14.high).toBeGreaterThanOrEqual(f.headline.conversions14.expected);
    // Engaged users get higher probabilities than low-engagement ones.
    const engaged = f.model.segments.find(s => s.segment === '3|activated');
    const low = f.model.segments.find(s => s.segment === '0-1|not-activated');
    expect(engaged.smoothed).toBeGreaterThan(low.smoothed);
    expect(f.rows.some(r => r.flags.includes('lowEngagement'))).toBe(true);
    expect(
      f.insights.find(i => i.dimension === 'activated' && i.value === 'yes').rate,
    ).toBeGreaterThan(f.insights.find(i => i.dimension === 'activated' && i.value === 'no').rate);
  });

  it('leaves out users converted through a paid status without a dated event', () => {
    const paid = user({ userId: 'paid', trialStart: daysAgo(16), undatedConversion: true });
    const f = computeTrialForecast({
      users: [...users, paid],
      activity,
      trialSettings: settings,
      since: daysAgo(60),
      now,
      revenueTxns: [],
      filters: {},
      runBacktest: false,
    });
    expect(f.rows.find(r => r.userId === 'paid')).toBeUndefined();
  });

  it('is unavailable when the events are not tracked', () => {
    const f = computeTrialForecast({
      users,
      activity,
      trialSettings: settings,
      since: null,
      now,
      revenueTxns: [],
      filters: {},
    });
    expect(f).toMatchObject({ available: false, reason: 'noTracking' });
  });

  it('back-test lands near the actual number on a well-behaved cohort', () => {
    const b = backtest(users, activity, settings, fs, now);
    expect(b.users).toBeGreaterThan(0);
    expect(b.predicted.low).toBeLessThanOrEqual(b.predicted.high);
    expect(Math.abs(b.predicted.expected - b.actual)).toBeLessThan(Math.max(4, b.actual));
  });
});

describe('computeForecastAccuracy', () => {
  const snap = (
    date: string,
    userId: string,
    pTotal: number,
    outcome: boolean | null,
    convertedAt: string | null,
    elapsedDays = 11,
    platform = 'ios',
  ) => ({
    snapshotDate: date,
    userId,
    platform,
    trialStart: '2026-10-01T00:00:00Z',
    elapsedDays,
    pTotal,
    p7: pTotal / 2,
    outcome,
    convertedAt,
  });
  const rows = [
    snap('2026-10-18', 'a', 0.4, true, '2026-10-22T00:00:00Z', 2), // Sunday: week of Oct 12
    snap('2026-10-19', 'a', 0.6, true, '2026-10-22T00:00:00Z'),
    snap('2026-10-19', 'b', 0.02, false, null),
    snap('2026-10-19', 'c', 0.2, true, '2026-10-30T00:00:00Z'), // after 7 days
    snap('2026-10-20', 'd', 0.9, null, null), // same week, later snapshot: ignored
    snap('2026-10-19', 'w', 0.5, false, null, 11, 'web'),
    snap('2026-11-08', 'e', 0.5, null, null), // 7-day horizon not over
  ];

  it('compares weekly 7-day predictions with actual conversions and buckets calibration', () => {
    const acc = computeForecastAccuracy(rows, now, 14);
    expect(acc.weeks.map(w => w.weekOf)).toEqual(['2026-10-12', '2026-10-19']);
    expect(acc.weeks[0]).toMatchObject({ predicted: 0.2, actual: 1 });
    expect(acc.weeks[1].predicted).toBeCloseTo(0.3 + 0.01 + 0.1 + 0.25);
    expect(acc.weeks[1].actual).toBe(1);
    expect(acc.weeks[1].low).toBeLessThanOrEqual(acc.weeks[1].high);
    expect(acc.resolvedUsers).toBe(4);
    expect(acc.calibration.find(b => b.bucket === '50%+')).toMatchObject({ n: 2 });
    expect(acc.calibration.find(b => b.bucket === '0–5%')).toMatchObject({ n: 1, actual: 0 });
  });

  it('applies the platform filter', () => {
    const acc = computeForecastAccuracy(rows, now, 14, 'web');
    expect(acc.weeks).toHaveLength(1);
    expect(acc.weeks[0]).toMatchObject({ weekOf: '2026-10-19', predicted: 0.25, actual: 0 });
    expect(acc.resolvedUsers).toBe(1);
  });
});
