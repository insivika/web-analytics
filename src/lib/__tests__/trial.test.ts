import {
  buildTrialUsers,
  COHORT_WEEKS,
  computeComparisons,
  computeDailyActive,
  computeFunnel,
  computeKpis,
  computeNotes,
  computeTrialReport,
  computeWeeklyCohorts,
  DAY_MS,
  DEFAULT_TRIAL_SETTINGS,
  detectTrialStarts,
  filterTrialUsers,
  getCohortStart,
  getWeekStart,
  HOUR_MS,
  normalizeTrialSettings,
  type TrialActivityRow,
  type TrialAttributeRow,
  type TrialConversionRow,
  type TrialEventStat,
} from '../trial';

const settings = DEFAULT_TRIAL_SETTINGS;
const now = new Date('2026-11-10T12:00:00Z');
const daysAgo = (n: number) => new Date(+now - n * DAY_MS);
const window = { startDate: daysAgo(14), endDate: now };

const attr = (userId: string, extra: Partial<TrialAttributeRow> = {}): TrialAttributeRow => ({
  userId,
  isInternal: false,
  platform: 'ios',
  subscriptionStatus: 'trialing',
  pushOptIn: false,
  paidInWindow: false,
  ...extra,
});

const active = (userId: string, ...days: number[]): TrialActivityRow[] =>
  days.map(day => ({ userId, eventName: 'trial_day_active', day, count: 1 }));

const build = (
  starts: Map<string, Date>,
  activity: TrialActivityRow[] = [],
  attributes: TrialAttributeRow[] = [],
  conversions: TrialConversionRow[] = [],
  s = settings,
) => buildTrialUsers(starts, activity, attributes, conversions, s, now);

const allStats = (firstSeen: Date, periodCount = 5): TrialEventStat[] =>
  [
    settings.trialStartEvent,
    settings.activeDayEvent,
    settings.activationEvent,
    settings.pushEvent,
    ...settings.milestones.flat(),
    ...settings.engagementEvents,
    ...settings.conversionEvents,
  ].map(eventName => ({ eventName, firstSeen, periodCount }));

describe('detectTrialStarts', () => {
  test('uses the first occurrence per user', () => {
    const starts = detectTrialStarts(
      [
        { userId: 'a', createdAt: daysAgo(3) },
        { userId: 'a', createdAt: daysAgo(5) },
        { userId: 'a', createdAt: daysAgo(1) },
        { userId: 'b', createdAt: daysAgo(2).toISOString() },
      ],
      window,
    );

    expect(starts.get('a')).toEqual(daysAgo(5));
    expect(starts.get('b')).toEqual(daysAgo(2));
  });

  test('excludes users whose first occurrence is before the window', () => {
    const starts = detectTrialStarts(
      [
        { userId: 'old', createdAt: daysAgo(30) },
        { userId: 'old', createdAt: daysAgo(2) },
        { userId: 'new', createdAt: daysAgo(2) },
      ],
      window,
    );

    expect([...starts.keys()]).toEqual(['new']);
  });

  test('window end is exclusive and empty user ids are ignored', () => {
    const starts = detectTrialStarts(
      [
        { userId: 'edge', createdAt: now },
        { userId: '', createdAt: daysAgo(1) },
        { userId: 'start-edge', createdAt: window.startDate },
      ],
      window,
    );

    expect([...starts.keys()]).toEqual(['start-edge']);
  });
});

describe('computeDailyActive', () => {
  test('day N denominator only includes users whose trial has reached day N', () => {
    // u1 started 10 days ago (trial day 11 today), u2 started 1 day ago (day 2 today).
    const starts = new Map([
      ['u1', daysAgo(10)],
      ['u2', daysAgo(1)],
    ]);
    const activity = [...active('u1', 0, 1, 4), ...active('u2', 0, 1)];
    const users = build(starts, activity, [attr('u1'), attr('u2')]);
    const curve = computeDailyActive(users, activity, settings, now);

    expect(curve).toHaveLength(14);
    expect(curve[0]).toMatchObject({ day: 1, active: 2, eligible: 2, pct: 100 });
    expect(curve[1]).toMatchObject({ day: 2, active: 2, eligible: 2, pct: 100 });
    // Day 3 onwards: u2's trial hasn't reached it, so only u1 counts.
    expect(curve[2]).toMatchObject({ day: 3, active: 0, eligible: 1, pct: 0 });
    expect(curve[4]).toMatchObject({ day: 5, active: 1, eligible: 1, pct: 100 });
    // Day 12+: nobody has reached it yet.
    expect(curve[11]).toMatchObject({ day: 12, active: 0, eligible: 0, pct: 0 });
    // Fewer than 10 eligible users: flagged as a low sample.
    expect(curve.every(p => p.lowSample)).toBe(true);
  });
});

describe('internal user exclusion', () => {
  const starts = new Map([
    ['internal', daysAgo(5)],
    ['external', daysAgo(5)],
  ]);
  const activity = [...active('internal', 0, 1, 2), ...active('external', 0)];
  const attributes = [attr('internal', { isInternal: true }), attr('external')];

  test('filterTrialUsers drops internal users by default', () => {
    const users = build(starts, activity, attributes);

    expect(filterTrialUsers(users, {}).map(u => u.userId)).toEqual(['external']);
    expect(filterTrialUsers(users, { excludeInternal: false })).toHaveLength(2);
  });

  test('excluding internal users changes the KPIs', () => {
    const report = (excludeInternal: boolean) =>
      computeTrialReport({
        occurrences: [...starts].map(([userId, createdAt]) => ({ userId, createdAt })),
        activity,
        attributes,
        conversions: [],
        eventStats: [],
        settings,
        window,
        filters: { excludeInternal },
        now,
      });

    expect(report(true).kpis).toMatchObject({ starts: 1, active2: 0, active3: 0 });
    expect(report(false).kpis).toMatchObject({ starts: 2, active2: 50, active3: 50 });
    expect(report(true).internalUsers).toBe(1);
  });
});

describe('conversion', () => {
  test('a trial conversion any time after trial start counts', () => {
    const starts = new Map([['u', daysAgo(25)]]);
    // Store charges at trial end: converted 17 days after start (after the 14-day trial).
    const conversions = [{ userId: 'u', firstAt: new Date(+daysAgo(25) + 17 * DAY_MS) }];
    const [user] = build(starts, [], [attr('u')], conversions);

    expect(user.converted).toBe(true);
    expect(user.trialCompleted).toBe(true);
    expect(user.convertedAt).toBe(new Date(+daysAgo(25) + 17 * DAY_MS).toISOString());
  });

  test('a conversion before trial start does not count', () => {
    const starts = new Map([['u', daysAgo(20)]]);
    const [user] = build(starts, [], [attr('u')], [{ userId: 'u', firstAt: daysAgo(30) }]);

    expect(user.converted).toBe(false);
  });

  test('an optional conversion window limits how late a conversion may happen', () => {
    const starts = new Map([['u', daysAgo(40)]]);
    const conversions = [{ userId: 'u', firstAt: new Date(+daysAgo(40) + 20 * DAY_MS) }];
    const windowed = normalizeTrialSettings({ conversionWindowDays: 14 });

    expect(build(starts, [], [attr('u')], conversions, windowed)[0].converted).toBe(false);
    expect(build(starts, [], [attr('u')], conversions)[0].converted).toBe(true);
  });

  test('conversion rate only covers completed trials (length + settle days)', () => {
    const starts = new Map([
      ['done-converted', daysAgo(20)],
      ['done-not', daysAgo(18)],
      // 15 days in: trial ended but billing has not settled (14 + 3 days).
      ['settling', daysAgo(15)],
      ['running', daysAgo(3)],
    ]);
    const users = build(starts, [], [], [{ userId: 'done-converted', firstAt: daysAgo(5) }]);
    const kpis = computeKpis(users);

    expect(kpis.completedTrials).toBe(2);
    expect(kpis.converted).toBe(50);
    expect(kpis.starts).toBe(4);
  });

  test('conversion is null when no trial has completed', () => {
    const users = build(new Map([['u', daysAgo(3)]]));

    expect(computeKpis(users)).toMatchObject({ converted: null, completedTrials: 0 });
  });

  test('a paid status after trial start converts only when paid statuses are configured', () => {
    const starts = new Map([['u', daysAgo(20)]]);
    const attributes = [attr('u', { paidInWindow: true, subscriptionStatus: 'active' })];

    expect(build(starts, [], attributes)[0].converted).toBe(true);
  });
});

describe('buildTrialUsers', () => {
  test('counts milestones, engagement and active days within the trial only', () => {
    const starts = new Map([['u', daysAgo(20)]]);
    const activity: TrialActivityRow[] = [
      ...active('u', 0, 3, 3, 20),
      {
        userId: 'u',
        eventName: 'first_calendar_opened',
        day: 0,
        count: 1,
        firstAt: new Date(+daysAgo(20) + 2 * HOUR_MS),
      },
      { userId: 'u', eventName: 'event_created', day: 2, count: 5 },
      { userId: 'u', eventName: 'event_created', day: 15, count: 9 },
    ];
    const [user] = build(starts, activity, [attr('u')]);

    expect(user.activeDays).toBe(2);
    expect(user.engagementCount).toBe(5);
    expect(user.milestones).toEqual([true, false, false, false, false, false]);
    expect(user.milestoneHours[0]).toBeCloseTo(2);
    expect(user.currentTrialDay).toBeNull();
  });
});

describe('computeFunnel', () => {
  test('reports reach in any order and the median hours from trial start', () => {
    const starts = new Map([
      ['a', daysAgo(10)],
      ['b', daysAgo(10)],
      ['c', daysAgo(10)],
    ]);
    const at = (h: number) => new Date(+daysAgo(10) + h * HOUR_MS);
    const activity: TrialActivityRow[] = [
      { userId: 'a', eventName: 'first_calendar_opened', day: 0, count: 1, firstAt: at(1) },
      { userId: 'b', eventName: 'first_calendar_opened', day: 0, count: 1, firstAt: at(5) },
      // c skips milestone 1 but reaches milestone 2: still counted for milestone 2.
      {
        userId: 'c',
        eventName: 'first_recurring_event_created',
        day: 2,
        count: 1,
        firstAt: at(50),
      },
    ];
    const funnel = computeFunnel(build(starts, activity), settings);

    expect(funnel[0]).toMatchObject({ reached: 2, medianHours: 3 });
    expect(funnel[0].pct).toBeCloseTo(66.67, 1);
    expect(funnel[1]).toMatchObject({ reached: 1, medianHours: 50 });
    expect(funnel[2]).toMatchObject({ reached: 0, medianHours: null });
  });
});

describe('computeComparisons', () => {
  const previous = { startDate: daysAgo(28), endDate: daysAgo(14) };

  test('hides the delta when tracking started after the previous window began', () => {
    const stats = allStats(daysAgo(60)).map(s =>
      s.eventName === settings.pushEvent ? { ...s, firstSeen: daysAgo(2) } : s,
    );
    const result = computeComparisons(settings, stats, previous);

    expect(result.starts.available).toBe(true);
    expect(result.pushOptIn).toEqual({ available: false, trackingStart: daysAgo(2).toISOString() });
  });

  test('uses the earliest alternative for multi-event steps', () => {
    const stats = allStats(daysAgo(60)).map(s =>
      s.eventName === 'paywall_purchased' ? { ...s, firstSeen: daysAgo(1) } : s,
    );

    expect(computeComparisons(settings, stats, previous, daysAgo(60)).converted.available).toBe(
      true,
    );
  });

  test('is unavailable when an event was never recorded', () => {
    const stats = allStats(daysAgo(60)).filter(s => s.eventName !== settings.activationEvent);

    expect(computeComparisons(settings, stats, previous).activated).toEqual({
      available: false,
      trackingStart: null,
    });
  });
});

describe('computeWeeklyCohorts', () => {
  test('always returns the last 8 signup weeks and finalizes conversion per week', () => {
    // now = Tue Nov 10 2026; current week starts Mon Nov 9.
    const starts = new Map([
      ['old', new Date('2026-10-13T10:00:00Z')], // week of Oct 12, completed
      ['new', new Date('2026-11-09T10:00:00Z')], // current week, in progress
      ['too-old', new Date('2026-09-01T10:00:00Z')], // before the 8-week range
    ]);
    const users = build(starts, [], [], [{ userId: 'old', firstAt: '2026-10-28T00:00:00Z' }]);
    const rows = computeWeeklyCohorts(users, settings, now, 'UTC');

    expect(rows).toHaveLength(COHORT_WEEKS);
    expect(rows[0]).toMatchObject({ weekStart: '2026-11-09', starts: 1, inProgress: true });
    expect(rows[0].converted).toBeNull();
    expect(rows.find(r => r.weekStart === '2026-10-12')).toMatchObject({
      starts: 1,
      converted: 100,
      conversionFinal: true,
      inProgress: false,
    });
    expect(rows[COHORT_WEEKS - 1].weekStart).toBe('2026-09-21');
    expect(rows.reduce((sum, r) => sum + r.starts, 0)).toBe(2);
  });
});

describe('computeNotes', () => {
  test('only notes events with zero rows in the period', () => {
    const stats = allStats(daysAgo(60)).map(s =>
      s.eventName === 'category_assigned' ? { ...s, periodCount: 0 } : s,
    );
    const withoutPush = stats.filter(s => s.eventName !== settings.pushEvent);

    const starts = [{ userId: 'u', createdAt: daysAgo(2) }];

    expect(computeNotes(settings, stats, starts)).toEqual([
      { type: 'noData', event: 'category_assigned' },
    ]);
    expect(computeNotes(settings, withoutPush, starts).map(n => n.event)).toContain(
      settings.pushEvent,
    );
  });
});

describe('normalizeTrialSettings', () => {
  test('keeps defaults for invalid values, accepts a new start event and an empty property', () => {
    const result = normalizeTrialSettings({
      trialStartEvent: 'signed_up',
      trialLengthDays: 'x' as any,
      milestones: [['a', 'b'], 'c' as any, []],
      conversionProperty: '',
    });

    expect(result.trialStartEvent).toBe('signed_up');
    expect(result.trialLengthDays).toBe(14);
    expect(result.milestones).toEqual([['a', 'b'], ['c']]);
    expect(result.conversionProperty).toBe('');
    expect(result.userIdProperty).toBe('user_id');
  });
});

describe('review fixes', () => {
  test('notes a start event that fires but never carries the user id', () => {
    const stats = allStats(daysAgo(60));
    const period = { startDate: daysAgo(14), endDate: now };

    expect(computeNotes(settings, stats, [], period)[0]).toEqual({
      type: 'noUserId',
      event: settings.trialStartEvent,
      property: 'user_id',
    });
    expect(computeNotes(settings, stats, [{ userId: 'u', createdAt: daysAgo(2) }], period)).toEqual(
      [],
    );
  });

  test('conversion comparison waits for the conversion property to be recorded', () => {
    const previous = { startDate: daysAgo(28), endDate: daysAgo(14) };
    const stats = allStats(daysAgo(60));

    expect(computeComparisons(settings, stats, previous, daysAgo(60)).converted.available).toBe(
      true,
    );
    expect(computeComparisons(settings, stats, previous, daysAgo(5)).converted).toEqual({
      available: false,
      trackingStart: daysAgo(5).toISOString(),
    });
    // Property never recorded: no comparison.
    expect(computeComparisons(settings, stats, previous, null).converted.available).toBe(false);
    // No property required: only the events matter.
    const noProperty = normalizeTrialSettings({ conversionProperty: '' });
    expect(computeComparisons(noProperty, stats, previous, null).converted.available).toBe(true);
  });

  test('week keys do not depend on the server timezone', () => {
    const original = process.env.TZ;
    const results: string[][] = [];

    for (const tz of ['UTC', 'Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      results.push([
        getWeekStart(new Date('2026-11-09T00:30:00Z'), 'Europe/Berlin'),
        getWeekStart(new Date('2026-11-08T23:30:00Z'), 'UTC'),
        getCohortStart(now, 'Europe/Berlin').toISOString(),
      ]);
    }
    process.env.TZ = original;

    expect(results[0]).toEqual(['2026-11-09', '2026-11-02', '2026-09-20T22:00:00.000Z']);
    expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
  });

  test('weeks whose trials ended but have not settled are marked settling', () => {
    // 15 days ago: trial ended (14 days) but within the 3-day settle period.
    const users = build(new Map([['u', daysAgo(15)]]));
    const row = computeWeeklyCohorts(users, settings, now, 'UTC').find(r => r.starts === 1);

    expect(row).toMatchObject({ inProgress: false, conversionFinal: false, settling: true });
    expect(row.converted).toBeNull();
  });
});
