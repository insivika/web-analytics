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
  resolveTrialStarts,
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
    settings.pushShownEvent,
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
        eventStats: allStats(daysAgo(60)),
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

describe('trial start from trial_expires_at', () => {
  const expires = (userId: string, startDaysAgo: number, seenDaysAgo: number, dss?: number) => ({
    userId,
    expiresAt: new Date(+daysAgo(startDaysAgo) + 14 * DAY_MS),
    seenAt: daysAgo(seenDaysAgo),
    daysSinceSignup: dss ?? null,
  });

  test('derives the start from the earliest expiry and falls back to the start event', () => {
    const { starts } = resolveTrialStarts(
      [
        { userId: 'seed-only', createdAt: daysAgo(5) },
        // Derived start wins over a later onboarding event.
        { userId: 'both', createdAt: daysAgo(9) },
      ],
      [
        expires('both', 10, 10, 0),
        // A later, larger expiry value for the same user is ignored.
        { ...expires('both', 3, 3, 7) },
        expires('expiry-only', 20, 10, 10),
      ],
      settings,
      now,
    );

    expect(starts.get('both')).toEqual({
      start: daysAgo(10),
      source: 'trialExpiresAt',
      observedDuringTrial: true,
    });
    expect(starts.get('seed-only')).toMatchObject({ start: daysAgo(5), source: 'event' });
    expect(starts.get('expiry-only')).toMatchObject({
      start: daysAgo(20),
      observedDuringTrial: true,
    });
  });

  test('excludes trials whose expiry was only attached at or after trial end', () => {
    // Backfill pattern: first seen exactly at expiry (day 14) with days_since_signup 14.
    const resolved = resolveTrialStarts([], [expires('late', 30, 16, 14)], settings, now);

    expect(resolved.starts.has('late')).toBe(false);
    expect(resolved.lateAttached.get('late')).toEqual(daysAgo(30));

    const keep = normalizeTrialSettings({ excludeLateAttached: false });
    expect(
      resolveTrialStarts([], [expires('late', 30, 16, 14)], keep, now).starts.get('late'),
    ).toMatchObject({ start: daysAgo(30), observedDuringTrial: false });
    // Seen on day 12 of the trial: kept.
    expect(
      resolveTrialStarts([], [expires('ok', 30, 18, 12)], settings, now).starts.has('ok'),
    ).toBe(true);
  });

  test('skips re-trials of long-time users and future starts from bad expiry values', () => {
    const resolved = resolveTrialStarts(
      [{ userId: 'bad-expiry', createdAt: daysAgo(4) }],
      [
        // Seen 20 days after the derived start with days_since_signup 335: signed up long before.
        expires('retrial', 25, 5, 335),
        // Exactly at the limit (14 + 30 days) is still a trial.
        expires('edge', 10, 10, 44),
        {
          userId: 'bad-expiry',
          expiresAt: '2036-09-23T22:20:50Z',
          seenAt: daysAgo(1),
          daysSinceSignup: 3,
        },
      ],
      settings,
      now,
    );

    expect(resolved.starts.has('retrial')).toBe(false);
    expect(resolved.retrials.get('retrial')).toEqual(daysAgo(25));
    expect(resolved.starts.has('edge')).toBe(true);
    expect(resolved.starts.get('bad-expiry')).toMatchObject({ source: 'event', start: daysAgo(4) });

    const keepAll = normalizeTrialSettings({ excludeRetrials: false, excludeLateAttached: false });
    expect(
      resolveTrialStarts([], [expires('retrial', 25, 5, 335)], keepAll, now).starts.has('retrial'),
    ).toBe(true);
  });

  test('event mode ignores expiry values', () => {
    const eventMode = normalizeTrialSettings({ trialStartMode: 'event' });
    const { starts } = resolveTrialStarts(
      [{ userId: 'u', createdAt: daysAgo(5) }],
      [expires('u', 10, 10, 0), expires('v', 8, 8, 0)],
      eventMode,
      now,
    );

    expect([...starts.keys()]).toEqual(['u']);
    expect(starts.get('u')).toMatchObject({ start: daysAgo(5), source: 'event' });
  });

  test('report counts start sources and adds expiry-only users', () => {
    const report = computeTrialReport({
      occurrences: [{ userId: 'seed', createdAt: daysAgo(3) }],
      expiresRows: [expires('expiry', 6, 6, 0), expires('retrial', 8, 2, 400)],
      activity: [],
      attributes: [],
      conversions: [],
      eventStats: [],
      settings,
      window,
      filters: {},
      now,
    });

    expect(report.kpis.starts).toBe(2);
    expect(report.startSources).toEqual({
      trialExpiresAt: 1,
      event: 1,
      notObservedDuringTrial: 0,
      excludedRetrials: 1,
      excludedLateAttached: 0,
    });
  });
});

describe('journey conversion milestone', () => {
  test('uses the conversion rule, so it matches the Converted KPI', () => {
    const starts = new Map([
      ['late-convert', daysAgo(30)],
      ['in-trial-purchase-not-flagged', daysAgo(30)],
    ]);
    const activity: TrialActivityRow[] = [
      // A purchase event during the trial without is_trial_conversion: not a conversion.
      { userId: 'in-trial-purchase-not-flagged', eventName: 'paywall_purchased', day: 2, count: 1 },
    ];
    // Converted 16 days after start (after the trial), with is_trial_conversion.
    const conversions = [{ userId: 'late-convert', firstAt: new Date(+daysAgo(30) + 16 * DAY_MS) }];
    const users = build(starts, activity, [], conversions);
    const funnel = computeFunnel(users, settings);
    const last = funnel[funnel.length - 1];

    expect(last).toMatchObject({ reached: 1, medianHours: 16 * 24 });
    expect(computeKpis(users).converted).toBe(50);
  });
});

describe('weekly cohorts before the first trial start', () => {
  test('hides weeks that end before the first recorded trial start', () => {
    const users = build(new Map([['u', new Date('2026-10-14T10:00:00Z')]]));
    const rows = computeWeeklyCohorts(
      users,
      settings,
      now,
      'UTC',
      new Date('2026-10-14T10:00:00Z'),
    );

    expect(rows.map(r => r.weekStart)).toEqual([
      '2026-11-09',
      '2026-11-02',
      '2026-10-26',
      '2026-10-19',
      '2026-10-12',
    ]);
    expect(computeWeeklyCohorts([], settings, now, 'UTC', null)).toEqual([]);
  });
});

describe('push opt-in', () => {
  const since = daysAgo(3); // first push_prompt_shown ever recorded
  const starts = new Map([
    ['before', daysAgo(10)], // trial started before the prompt existed: not eligible
    ['opted', daysAgo(2)],
    ['declined', daysAgo(2)],
    ['answered-no-shown-event', daysAgo(1)],
    ['never-saw', daysAgo(1)],
  ]);
  const attributes = [
    attr('before', { pushOptIn: true, pushAnswered: true }),
    attr('opted', { pushOptIn: true, pushAnswered: true }),
    attr('declined', { pushOptIn: false, pushAnswered: true }),
    attr('answered-no-shown-event', { pushOptIn: false, pushAnswered: true }),
    attr('never-saw'),
  ];
  const users = buildTrialUsers(starts, [], attributes, [], settings, now, undefined, {
    since,
    shownUsers: new Set(['before', 'opted', 'declined']),
  });

  test('is measured among eligible trial starters who saw the prompt', () => {
    const kpis = computeKpis(users);

    expect(kpis.pushEligibleStarts).toBe(4);
    // Answering implies the prompt was shown, even without a shown event.
    expect(kpis.pushSeenUsers).toBe(3);
    expect(kpis.pushSeen).toBe(75);
    expect(kpis.pushOptIn).toBeCloseTo(33.33, 1);
    expect(users.find(u => u.userId === 'before')).toMatchObject({ pushEligible: false });
  });

  test('is null when nobody eligible saw the prompt, or the prompt never fired', () => {
    expect(computeKpis(users.filter(u => u.userId === 'never-saw'))).toMatchObject({
      pushOptIn: null,
      pushSeen: 0,
    });
    const noPrompt = buildTrialUsers(starts, [], attributes, [], settings, now, undefined, {
      since: null,
      shownUsers: new Set(),
    });
    expect(computeKpis(noPrompt)).toMatchObject({
      pushOptIn: null,
      pushSeen: null,
      pushEligibleStarts: 0,
    });
  });

  test('report exposes when push tracking started', () => {
    const report = computeTrialReport({
      occurrences: [{ userId: 'opted', createdAt: daysAgo(2) }],
      activity: [],
      attributes,
      conversions: [],
      pushShown: [{ userId: 'opted', firstAt: daysAgo(2) }],
      eventStats: allStats(daysAgo(60)).map(s =>
        s.eventName === settings.pushShownEvent ? { ...s, firstSeen: since } : s,
      ),
      settings,
      window,
      filters: {},
      now,
    });

    expect(report.pushSince).toBe(since.toISOString());
    expect(report.kpis).toMatchObject({ pushOptIn: 100, pushSeen: 100, pushSeenUsers: 1 });
    expect(report.comparisons.pushOptIn.available).toBe(false);
  });
});

describe('per-metric tracking start', () => {
  test('rates only count trials started on/after the metric was tracked', () => {
    // Activation tracked from 5 days ago; 'old' started before that.
    const starts = new Map([
      ['old', daysAgo(8)],
      ['new-active', daysAgo(3)],
      ['new-idle', daysAgo(2)],
    ]);
    const activity: TrialActivityRow[] = [
      { userId: 'new-active', eventName: 'activation_complete', day: 0, count: 1 },
    ];
    const users = build(starts, activity);
    const since = {
      activated: daysAgo(5).toISOString(),
      active2: daysAgo(60).toISOString(),
      active3: daysAgo(60).toISOString(),
      pushOptIn: null,
      converted: daysAgo(60).toISOString(),
    };
    const kpis = computeKpis(users, since);

    expect(kpis.activated).toBe(50);
    expect(kpis.n.activated).toBe(2);
    expect(kpis.n.active2).toBe(3);
    expect(kpis.pushOptIn).toBeNull();
    expect(
      computeKpis(
        users.filter(u => u.userId === 'old'),
        since,
      ).activated,
    ).toBeNull();
  });

  test('cohort weeks that ended before tracking are flagged', () => {
    const users = build(
      new Map([
        ['a', new Date('2026-10-13T10:00:00Z')],
        ['b', new Date('2026-11-03T10:00:00Z')],
      ]),
    );
    const since = {
      activated: '2026-10-08T00:00:00.000Z',
      active2: '2026-10-08T00:00:00.000Z',
      active3: '2026-10-08T00:00:00.000Z',
      pushOptIn: '2026-11-08T05:07:48.000Z',
      converted: '2026-10-08T00:00:00.000Z',
    };
    const rows = computeWeeklyCohorts(users, settings, now, 'UTC', undefined, since);
    const oct12 = rows.find(r => r.weekStart === '2026-10-12');
    const nov2 = rows.find(r => r.weekStart === '2026-11-02');

    expect(oct12.beforeTracking).toMatchObject({ activated: false, pushOptIn: true });
    expect(oct12.pushOptIn).toBeNull();
    expect(nov2.beforeTracking.pushOptIn).toBe(true);
    expect(rows.find(r => r.weekStart === '2026-11-09').beforeTracking.pushOptIn).toBe(false);
  });
});
