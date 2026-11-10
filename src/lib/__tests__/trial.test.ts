import {
  buildTrialUsers,
  computeDailyActive,
  computeKpis,
  computeTrialReport,
  DAY_MS,
  DEFAULT_TRIAL_SETTINGS,
  detectTrialStarts,
  filterTrialUsers,
  normalizeTrialSettings,
  type TrialActivityRow,
  type TrialAttributeRow,
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
    const users = buildTrialUsers(starts, activity, [attr('u1'), attr('u2')], settings, now);
    const curve = computeDailyActive(users, activity, settings, now);

    expect(curve).toHaveLength(14);
    expect(curve[0]).toEqual({ day: 1, active: 2, eligible: 2, pct: 100 });
    expect(curve[1]).toEqual({ day: 2, active: 2, eligible: 2, pct: 100 });
    // Day 3 onwards: u2's trial hasn't reached it, so only u1 counts.
    expect(curve[2]).toEqual({ day: 3, active: 0, eligible: 1, pct: 0 });
    expect(curve[4]).toEqual({ day: 5, active: 1, eligible: 1, pct: 100 });
    // Day 12+: nobody has reached it yet.
    expect(curve[11]).toEqual({ day: 12, active: 0, eligible: 0, pct: 0 });
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
    const users = buildTrialUsers(starts, activity, attributes, settings, now);

    expect(filterTrialUsers(users, {}).map(u => u.userId)).toEqual(['external']);
    expect(filterTrialUsers(users, { excludeInternal: false })).toHaveLength(2);
  });

  test('excluding internal users changes the KPIs', () => {
    const report = (excludeInternal: boolean) =>
      computeTrialReport({
        occurrences: [...starts].map(([userId, createdAt]) => ({ userId, createdAt })),
        activity,
        attributes,
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

describe('buildTrialUsers', () => {
  test('counts milestones, engagement and conversion within the trial only', () => {
    const starts = new Map([['u', daysAgo(20)]]);
    const activity: TrialActivityRow[] = [
      ...active('u', 0, 3, 3, 20),
      { userId: 'u', eventName: 'first_calendar_opened', day: 0, count: 1 },
      { userId: 'u', eventName: 'event_created', day: 2, count: 5 },
      { userId: 'u', eventName: 'event_created', day: 15, count: 9 },
      { userId: 'u', eventName: 'subscription_started', day: 16, count: 1 },
    ];
    const [user] = buildTrialUsers(starts, activity, [attr('u')], settings, now);

    expect(user.activeDays).toBe(2);
    expect(user.engagementCount).toBe(5);
    expect(user.milestones).toEqual([true, false, false, false, false, false]);
    expect(user.converted).toBe(false);
    expect(user.currentTrialDay).toBeNull();

    const grace = normalizeTrialSettings({ conversionGraceDays: 7 });
    expect(buildTrialUsers(starts, activity, [attr('u')], grace, now)[0].converted).toBe(true);
  });

  test('a paid subscription status in the window counts as converted', () => {
    const starts = new Map([['u', daysAgo(3)]]);
    const [user] = buildTrialUsers(
      starts,
      [],
      [attr('u', { paidInWindow: true, subscriptionStatus: 'active' })],
      settings,
      now,
    );

    expect(user.converted).toBe(true);
    expect(user.currentTrialDay).toBe(4);
    expect(computeKpis([user]).converted).toBe(100);
  });
});

describe('normalizeTrialSettings', () => {
  test('keeps defaults for missing or invalid values and accepts a new start event', () => {
    const result = normalizeTrialSettings({
      trialStartEvent: 'signed_up',
      trialLengthDays: 'x' as any,
      milestones: [['a', 'b'], 'c' as any, []],
    });

    expect(result.trialStartEvent).toBe('signed_up');
    expect(result.trialLengthDays).toBe(14);
    expect(result.milestones).toEqual([['a', 'b'], ['c']]);
    expect(result.userIdProperty).toBe('user_id');
  });
});
