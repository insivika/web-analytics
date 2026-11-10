// Trial report: definitions and the pure metric computations.
//
// Every metric is keyed on an event-data property (default `user_id`), never on
// session_id, because sessions don't follow a user from signup into the product.
// The SQL layer (src/queries/sql/reports/getTrial.ts) only fetches per-user
// aggregates; everything below is deterministic and unit-tested.

import { formatInTimeZone, zonedTimeToUtc } from 'date-fns-tz';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** Weekly cohort table always shows this many signup weeks. */
export const COHORT_WEEKS = 8;

/** Daily active points with fewer eligible users than this are shown greyed out. */
export const MIN_DAILY_ACTIVE_USERS = 10;

export const TRIAL_PLATFORMS = ['ios', 'android', 'web'] as const;

export type TrialPlatformFilter = 'all' | (typeof TRIAL_PLATFORMS)[number];

export interface TrialSettings {
  trialStartEvent: string;
  trialLengthDays: number;
  activeDayEvent: string;
  activationEvent: string;
  /** Ordered milestones; each step is reached by any one of its events. */
  milestones: string[][];
  engagementEvents: string[];
  pushEvent: string;
  pushAnswerProperty: string;
  pushAnswerValue: string;
  pushGrantedProperty: string;
  /** A user converts on the first of these events after their trial start... */
  conversionEvents: string[];
  /** ...that carries this property with this value (empty property = no requirement). */
  conversionProperty: string;
  conversionPropertyValue: string;
  /** Days after trial start in which a conversion counts; 0 = any time. */
  conversionWindowDays: number;
  /** A trial counts as completed this many days after it ends (store billing lag). */
  conversionSettleDays: number;
  statusProperty: string;
  /** Optional extra rule: a paid subscription status after trial start also converts. */
  paidStatuses: string[];
  excludeInternal: boolean;
  internalProperty: string;
  userIdProperty: string;
  platformProperty: string;
}

export const DEFAULT_TRIAL_SETTINGS: TrialSettings = {
  trialStartEvent: 'onboarding_seed_saved',
  trialLengthDays: 14,
  activeDayEvent: 'trial_day_active',
  activationEvent: 'activation_complete',
  milestones: [
    ['first_calendar_opened'],
    ['first_recurring_event_created'],
    ['first_category_created'],
    ['activation_complete'],
    ['paywall_shown'],
    ['paywall_purchased', 'subscription_started'],
  ],
  engagementEvents: [
    'event_created',
    'recurring_event_created',
    'category_assigned',
    'categories_opened',
  ],
  pushEvent: 'push_prompt_answered',
  pushAnswerProperty: 'answer',
  pushAnswerValue: 'yes',
  pushGrantedProperty: 'granted',
  conversionEvents: ['subscription_started', 'paywall_purchased'],
  conversionProperty: 'is_trial_conversion',
  conversionPropertyValue: 'true',
  conversionWindowDays: 0,
  conversionSettleDays: 3,
  statusProperty: 'subscription_status',
  paidStatuses: [],
  excludeInternal: true,
  internalProperty: 'is_internal',
  userIdProperty: 'user_id',
  platformProperty: 'platform',
};

/** String settings that may be intentionally empty. */
const OPTIONAL_STRINGS: (keyof TrialSettings)[] = ['conversionProperty', 'conversionPropertyValue'];

const cleanList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map(v => String(v).trim()).filter(Boolean))] : [];

/** Merges stored settings over the defaults and drops invalid values. */
export function normalizeTrialSettings(value?: Partial<TrialSettings> | null): TrialSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<TrialSettings>;
  const settings = { ...DEFAULT_TRIAL_SETTINGS };

  for (const key of Object.keys(DEFAULT_TRIAL_SETTINGS) as (keyof TrialSettings)[]) {
    const current = input[key];
    const fallback = DEFAULT_TRIAL_SETTINGS[key];

    if (current === undefined || current === null) continue;

    if (typeof fallback === 'string' && typeof current === 'string') {
      if (current.trim() || OPTIONAL_STRINGS.includes(key)) {
        (settings as any)[key] = current.trim();
      }
    } else if (typeof fallback === 'number' && Number.isFinite(Number(current))) {
      (settings as any)[key] = Math.max(0, Math.round(Number(current)));
    } else if (typeof fallback === 'boolean' && typeof current === 'boolean') {
      (settings as any)[key] = current;
    } else if (key === 'milestones' && Array.isArray(current)) {
      settings.milestones = (current as unknown[])
        .map(step => cleanList(Array.isArray(step) ? step : [step]))
        .filter(step => step.length > 0);
    } else if (Array.isArray(fallback) && Array.isArray(current)) {
      (settings as any)[key] = cleanList(current);
    }
  }

  settings.trialLengthDays = Math.min(Math.max(settings.trialLengthDays, 1), 90);
  settings.conversionWindowDays = Math.min(settings.conversionWindowDays, 365);
  settings.conversionSettleDays = Math.min(settings.conversionSettleDays, 60);

  return settings;
}

/** Event names that need per-user, per-trial-day activity. */
export function getTrialActivityEventNames(settings: TrialSettings): string[] {
  return [
    ...new Set([
      settings.activeDayEvent,
      settings.activationEvent,
      ...settings.milestones.flat(),
      ...settings.engagementEvents,
    ]),
  ].filter(Boolean);
}

/** Every event the definitions refer to. */
export function getTrialDefinitionEvents(settings: TrialSettings): string[] {
  return [
    ...new Set([
      settings.trialStartEvent,
      ...getTrialActivityEventNames(settings),
      settings.pushEvent,
      ...settings.conversionEvents,
    ]),
  ].filter(Boolean);
}

export interface TrialWindow {
  startDate: Date;
  endDate: Date;
}

/** The window of equal length immediately before `window`. */
export function getPreviousWindow({ startDate, endDate }: TrialWindow): TrialWindow {
  const length = +endDate - +startDate;
  return { startDate: new Date(+startDate - length), endDate: new Date(+startDate) };
}

/** Adds days to a yyyy-MM-dd calendar date (pure date math, no timezone). */
const addCalendarDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The Monday (yyyy-MM-dd) of the week containing `date` in `timezone`. Uses only
 * the zoned calendar date and ISO weekday, so it doesn't depend on the server's
 * own timezone.
 */
export function getWeekStart(date: Date, timezone = 'UTC'): string {
  const day = formatInTimeZone(date, timezone, 'yyyy-MM-dd');
  const isoWeekday = Number(formatInTimeZone(date, timezone, 'i'));
  return addCalendarDays(day, 1 - isoWeekday);
}

/** Monday 00:00 (in `timezone`) of the oldest week in the weekly cohort table. */
export function getCohortStart(now: Date, timezone = 'UTC'): Date {
  const oldest = addCalendarDays(getWeekStart(now, timezone), -7 * (COHORT_WEEKS - 1));
  return zonedTimeToUtc(`${oldest}T00:00:00`, timezone);
}

export interface TrialStartOccurrence {
  userId: string;
  createdAt: Date | string;
}

/**
 * A user's trial starts at their FIRST ever occurrence of the start event.
 * Users whose first occurrence falls outside [startDate, endDate) are not trial
 * starters for this window, even if they fired the event again inside it.
 */
export function detectTrialStarts(
  occurrences: TrialStartOccurrence[],
  { startDate, endDate }: TrialWindow,
): Map<string, Date> {
  const first = new Map<string, Date>();

  for (const { userId, createdAt } of occurrences) {
    if (!userId) continue;
    const date = new Date(createdAt);
    const existing = first.get(userId);
    if (!existing || date < existing) {
      first.set(userId, date);
    }
  }

  const starts = new Map<string, Date>();

  for (const [userId, date] of first) {
    if (date >= startDate && date < endDate) {
      starts.set(userId, date);
    }
  }

  return starts;
}

/** Per-user, per-event, per-trial-day aggregate (day 0 = first 24h of the trial). */
export interface TrialActivityRow {
  userId: string;
  eventName: string;
  day: number;
  count: number;
  firstAt?: Date | string;
}

export interface TrialAttributeRow {
  userId: string;
  isInternal: boolean;
  platform: string | null;
  subscriptionStatus: string | null;
  pushOptIn: boolean;
  /** Had a paid subscription status after trial start (only if paidStatuses is set). */
  paidInWindow: boolean;
}

/** First qualifying conversion event at or after the user's trial start. */
export interface TrialConversionRow {
  userId: string;
  firstAt: Date | string;
}

/** When each definition event was first recorded, and how often in the report period. */
export interface TrialEventStat {
  eventName: string;
  firstSeen: Date | string | null;
  periodCount: number;
}

export interface TrialUser {
  userId: string;
  trialStart: string;
  platform: string | null;
  isInternal: boolean;
  /** 1-based current trial day, or null once the trial has ended. */
  currentTrialDay: number | null;
  /** Trial ended at least `conversionSettleDays` ago, so conversion is final. */
  trialCompleted: boolean;
  activeDays: number;
  engagementCount: number;
  milestones: boolean[];
  /** Hours from trial start to first reaching each milestone (null = not reached). */
  milestoneHours: (number | null)[];
  activated: boolean;
  pushOptIn: boolean;
  converted: boolean;
  convertedAt: string | null;
  subscriptionStatus: string | null;
}

interface UserAccumulator {
  activeDaySet: Set<number>;
  events: Map<string, { count: number; firstAt: number | null }>;
}

const toTime = (value: Date | string | undefined | null) =>
  value === undefined || value === null ? null : +new Date(value);

/** Builds one row per trial user from the raw aggregates. */
export function buildTrialUsers(
  starts: Map<string, Date>,
  activity: TrialActivityRow[],
  attributes: TrialAttributeRow[],
  conversions: TrialConversionRow[],
  settings: TrialSettings,
  now: Date,
): TrialUser[] {
  const length = settings.trialLengthDays;
  const acc = new Map<string, UserAccumulator>();

  for (const row of activity) {
    if (!starts.has(row.userId)) continue;
    const day = Number(row.day);
    if (day < 0 || day >= length) continue;

    let user = acc.get(row.userId);
    if (!user) {
      user = { activeDaySet: new Set(), events: new Map() };
      acc.set(row.userId, user);
    }

    if (row.eventName === settings.activeDayEvent) {
      user.activeDaySet.add(day);
    }

    const existing = user.events.get(row.eventName);
    const count = Number(row.count) || 0;
    // Without an exact timestamp, fall back to the start of that trial day.
    const firstAt = toTime(row.firstAt) ?? +starts.get(row.userId) + day * DAY_MS;

    if (existing) {
      existing.count += count;
      existing.firstAt = Math.min(existing.firstAt ?? firstAt, firstAt);
    } else {
      user.events.set(row.eventName, { count, firstAt });
    }
  }

  const attrs = new Map(attributes.map(a => [a.userId, a]));
  const conversionAt = new Map<string, number>();
  for (const row of conversions) {
    const time = toTime(row.firstAt);
    if (time === null) continue;
    conversionAt.set(row.userId, Math.min(conversionAt.get(row.userId) ?? time, time));
  }

  return [...starts].map(([userId, start]) => {
    const user = acc.get(userId);
    const attr = attrs.get(userId);
    const elapsed = +now - +start;
    const elapsedDays = Math.floor(elapsed / DAY_MS);
    const firstHours = (names: string[]) => {
      const times = names
        .map(name => user?.events.get(name)?.firstAt)
        .filter((t): t is number => t !== undefined && t !== null);
      return times.length ? Math.max(0, (Math.min(...times) - +start) / HOUR_MS) : null;
    };

    // A conversion counts if it happened at or after trial start (and within the
    // optional window). The SQL layer already applies these rules; re-check here.
    const convertedTime = conversionAt.get(userId);
    const conversionValid =
      convertedTime !== undefined &&
      convertedTime >= +start &&
      (settings.conversionWindowDays === 0 ||
        convertedTime < +start + settings.conversionWindowDays * DAY_MS);
    const milestoneHours = settings.milestones.map(step => firstHours(step));

    return {
      userId,
      trialStart: start.toISOString(),
      platform: attr?.platform ?? null,
      isInternal: !!attr?.isInternal,
      currentTrialDay: elapsedDays < length ? elapsedDays + 1 : null,
      trialCompleted: elapsed >= (length + settings.conversionSettleDays) * DAY_MS,
      activeDays: user?.activeDaySet.size ?? 0,
      engagementCount: settings.engagementEvents.reduce(
        (sum, name) => sum + (user?.events.get(name)?.count ?? 0),
        0,
      ),
      milestones: milestoneHours.map(h => h !== null),
      milestoneHours,
      activated: !!user?.events.has(settings.activationEvent),
      pushOptIn: !!attr?.pushOptIn,
      converted: conversionValid || !!attr?.paidInWindow,
      convertedAt: conversionValid ? new Date(convertedTime).toISOString() : null,
      subscriptionStatus: attr?.subscriptionStatus ?? null,
    };
  });
}

export interface TrialUserFilters {
  platform?: TrialPlatformFilter;
  excludeInternal?: boolean;
}

/** Applies the platform and internal-user filters. */
export function filterTrialUsers(users: TrialUser[], filters: TrialUserFilters): TrialUser[] {
  const { platform = 'all', excludeInternal = true } = filters;

  return users.filter(
    user =>
      !(excludeInternal && user.isInternal) && (platform === 'all' || user.platform === platform),
  );
}

export interface TrialKpis {
  starts: number;
  activated: number;
  active2: number;
  active3: number;
  pushOptIn: number;
  /** % converted among completed trials; null when no trial in the group has completed. */
  converted: number | null;
  /** Number of completed trials the conversion rate is based on. */
  completedTrials: number;
}

export type TrialKpiKey = Exclude<keyof TrialKpis, 'completedTrials'>;

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);

export function computeKpis(users: TrialUser[]): TrialKpis {
  const n = users.length;
  const share = (fn: (u: TrialUser) => boolean) => pct(users.filter(fn).length, n);
  const completed = users.filter(u => u.trialCompleted);

  return {
    starts: n,
    activated: share(u => u.activated),
    active2: share(u => u.activeDays >= 2),
    active3: share(u => u.activeDays >= 3),
    pushOptIn: share(u => u.pushOptIn),
    converted: completed.length
      ? pct(completed.filter(u => u.converted).length, completed.length)
      : null,
    completedTrials: completed.length,
  };
}

export interface TrialComparison {
  /** False when the previous window starts before the KPI's events were tracked. */
  available: boolean;
  /** Date from which every event the KPI depends on has data; null = never recorded. */
  trackingStart: string | null;
}

/**
 * A KPI can only be compared with the previous window if all events it depends on
 * were already being recorded when that window started. For a step with
 * alternatives (e.g. conversion events), the earliest alternative counts.
 */
export function computeComparisons(
  settings: TrialSettings,
  stats: TrialEventStat[],
  previousWindow: TrialWindow,
  /** First time a conversion event carried the required conversion property. */
  conversionPropertyFirstSeen?: Date | string | null,
): Record<TrialKpiKey, TrialComparison> {
  const firstSeen = new Map(
    stats.filter(s => s.firstSeen).map(s => [s.eventName, +new Date(s.firstSeen)]),
  );
  const CONVERSION_PROPERTY = '\u0000conversionProperty';
  if (conversionPropertyFirstSeen) {
    firstSeen.set(CONVERSION_PROPERTY, +new Date(conversionPropertyFirstSeen));
  }
  const earliest = (names: string[]) => {
    const times = names.map(n => firstSeen.get(n)).filter((t): t is number => t !== undefined);
    return times.length ? Math.min(...times) : null;
  };
  const compare = (...groups: string[][]): TrialComparison => {
    const starts = groups.map(earliest);
    if (starts.some(t => t === null)) return { available: false, trackingStart: null };
    const trackingStart = Math.max(...(starts as number[]));
    return {
      available: +previousWindow.startDate >= trackingStart,
      trackingStart: new Date(trackingStart).toISOString(),
    };
  };
  const start = [settings.trialStartEvent];

  return {
    starts: compare(start),
    activated: compare(start, [settings.activationEvent]),
    active2: compare(start, [settings.activeDayEvent]),
    active3: compare(start, [settings.activeDayEvent]),
    pushOptIn: compare(start, [settings.pushEvent]),
    // With a required property (e.g. is_trial_conversion), conversions only count
    // from when that property was first recorded.
    converted: settings.conversionProperty
      ? compare(start, settings.conversionEvents, [CONVERSION_PROPERTY])
      : compare(start, settings.conversionEvents),
  };
}

export interface TrialFunnelStep {
  events: string[];
  /** Users who reached this milestone during the trial, in any order. */
  reached: number;
  pct: number;
  /** Median hours from trial start until the milestone was first reached. */
  medianHours: number | null;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function computeFunnel(users: TrialUser[], settings: TrialSettings): TrialFunnelStep[] {
  return settings.milestones.map((events, index) => {
    const hours = users
      .map(u => u.milestoneHours[index])
      .filter((h): h is number => h !== null && h !== undefined);

    return {
      events,
      reached: hours.length,
      pct: pct(hours.length, users.length),
      medianHours: median(hours),
    };
  });
}

export interface TrialDailyActivePoint {
  day: number;
  active: number;
  /** Users whose trial has reached this day (the denominator). */
  eligible: number;
  pct: number;
  /** Fewer than MIN_DAILY_ACTIVE_USERS eligible users: shown greyed out. */
  lowSample: boolean;
}

/**
 * % of the cohort active on each trial day. The denominator for day N only
 * includes users whose trial has already reached day N, so recent signups
 * don't drag the curve down.
 */
export function computeDailyActive(
  users: TrialUser[],
  activity: TrialActivityRow[],
  settings: TrialSettings,
  now: Date,
): TrialDailyActivePoint[] {
  const userSet = new Set(users.map(u => u.userId));
  const activeByDay = new Map<number, Set<string>>();

  for (const row of activity) {
    if (row.eventName !== settings.activeDayEvent || !userSet.has(row.userId)) continue;
    const day = Number(row.day);
    if (!activeByDay.has(day)) activeByDay.set(day, new Set());
    activeByDay.get(day).add(row.userId);
  }

  return Array.from({ length: settings.trialLengthDays }, (_, i) => {
    const eligibleUsers = users.filter(u => +now >= +new Date(u.trialStart) + i * DAY_MS);
    const activeSet = activeByDay.get(i) ?? new Set();
    const active = eligibleUsers.filter(u => activeSet.has(u.userId)).length;

    return {
      day: i + 1,
      active,
      eligible: eligibleUsers.length,
      pct: pct(active, eligibleUsers.length),
      lowSample: eligibleUsers.length < MIN_DAILY_ACTIVE_USERS,
    };
  });
}

export function computeActiveDaysHistogram(users: TrialUser[], settings: TrialSettings) {
  return {
    buckets: Array.from({ length: settings.trialLengthDays }, (_, i) => ({
      days: i + 1,
      users: users.filter(u => u.activeDays === i + 1).length,
    })),
    noActiveDays: users.filter(u => u.activeDays === 0).length,
  };
}

export interface TrialCohortRow extends TrialKpis {
  weekStart: string;
  /** At least one trial in the week hasn't ended yet. */
  inProgress: boolean;
  /** Every trial in the week has completed, so the conversion rate is final. */
  conversionFinal: boolean;
  /** All trials ended, but some are still inside the conversion settle period. */
  settling: boolean;
}

/**
 * The last COHORT_WEEKS signup weeks (weeks start Monday in `timezone`), newest
 * first, including weeks without trial starts. Conversion is only reported for
 * weeks in which every trial has completed.
 */
export function computeWeeklyCohorts(
  users: TrialUser[],
  settings: TrialSettings,
  now: Date,
  timezone = 'UTC',
): TrialCohortRow[] {
  const groups = new Map<string, TrialUser[]>();
  const currentWeek = getWeekStart(now, timezone);

  for (let i = 0; i < COHORT_WEEKS; i++) {
    groups.set(addCalendarDays(currentWeek, -7 * i), []);
  }

  for (const user of users) {
    const start = new Date(user.trialStart);
    if (start > now) continue;
    groups.get(getWeekStart(start, timezone))?.push(user);
  }

  return [...groups]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([weekStart, group]) => {
      const kpis = computeKpis(group);
      const conversionFinal = group.length > 0 && group.every(u => u.trialCompleted);
      const inProgress = group.some(
        u => +new Date(u.trialStart) + settings.trialLengthDays * DAY_MS > +now,
      );

      return {
        weekStart,
        ...kpis,
        converted: conversionFinal ? kpis.converted : null,
        conversionFinal,
        inProgress,
        settling: group.length > 0 && !inProgress && !conversionFinal,
      };
    });
}

export type TrialNote =
  | { type: 'noData'; event: string }
  /** The event has rows in the period, but none carry the user id property. */
  | { type: 'noUserId'; event: string; property: string };

/**
 * A note for each definition event with zero rows in the report period, plus one
 * when the start event fires but never carries the user id property (so the
 * report can't find any trial starts).
 */
export function computeNotes(
  settings: TrialSettings,
  stats: TrialEventStat[],
  occurrences: TrialStartOccurrence[] = [],
  period?: TrialWindow,
): TrialNote[] {
  const counts = new Map(stats.map(s => [s.eventName, Number(s.periodCount) || 0]));
  const notes: TrialNote[] = getTrialDefinitionEvents(settings)
    .filter(event => !counts.get(event))
    .map(event => ({ type: 'noData', event }));

  const startRows = counts.get(settings.trialStartEvent) ?? 0;
  const startsWithUserId = occurrences.some(({ createdAt }) => {
    const time = +new Date(createdAt);
    return !period || (time >= +period.startDate && time < +period.endDate);
  });

  if (startRows > 0 && !startsWithUserId) {
    notes.unshift({
      type: 'noUserId',
      event: settings.trialStartEvent,
      property: settings.userIdProperty,
    });
  }

  return notes;
}

export interface TrialReport {
  settings: TrialSettings;
  window: TrialWindow;
  previousWindow: TrialWindow;
  kpis: TrialKpis;
  previousKpis: TrialKpis;
  comparisons: Record<TrialKpiKey, TrialComparison>;
  funnel: TrialFunnelStep[];
  dailyActive: TrialDailyActivePoint[];
  histogram: ReturnType<typeof computeActiveDaysHistogram>;
  cohorts: TrialCohortRow[];
  users: TrialUser[];
  notes: TrialNote[];
  internalUsers: number;
}

/** "No data yet" notes cover the signup window, but never past now. */
export function getStatsPeriodEnd(window: TrialWindow, now: Date): Date {
  return new Date(Math.min(+window.endDate, +now));
}

/** The range of trial starts the report needs data for. */
export function getTrialDataRange(window: TrialWindow, now: Date, timezone?: string): TrialWindow {
  const previous = getPreviousWindow(window);
  const cohortStart = getCohortStart(now, timezone);

  return {
    startDate: new Date(Math.min(+previous.startDate, +cohortStart)),
    endDate: new Date(Math.max(+window.endDate, +now)),
  };
}

export function computeTrialReport({
  occurrences,
  activity,
  attributes,
  conversions,
  eventStats,
  conversionPropertyFirstSeen,
  settings,
  window,
  filters,
  now,
  timezone,
}: {
  occurrences: TrialStartOccurrence[];
  activity: TrialActivityRow[];
  attributes: TrialAttributeRow[];
  conversions: TrialConversionRow[];
  eventStats: TrialEventStat[];
  /** First time a conversion event carried settings.conversionProperty. */
  conversionPropertyFirstSeen?: Date | string | null;
  settings: TrialSettings;
  window: TrialWindow;
  filters: TrialUserFilters;
  now: Date;
  timezone?: string;
}): TrialReport {
  const previousWindow = getPreviousWindow(window);
  const allStarts = detectTrialStarts(occurrences, getTrialDataRange(window, now, timezone));
  const allUsers = filterTrialUsers(
    buildTrialUsers(allStarts, activity, attributes, conversions, settings, now),
    { excludeInternal: false, platform: filters.platform },
  );

  const inWindow = (u: TrialUser, w: TrialWindow) =>
    new Date(u.trialStart) >= w.startDate && new Date(u.trialStart) < w.endDate;
  const excludeInternal = filters.excludeInternal ?? true;
  const visible = allUsers.filter(u => !(excludeInternal && u.isInternal));

  const currentAll = allUsers.filter(u => inWindow(u, window));
  const current = visible.filter(u => inWindow(u, window));
  const previous = visible.filter(u => inWindow(u, previousWindow));

  return {
    settings,
    window,
    previousWindow,
    kpis: computeKpis(current),
    previousKpis: computeKpis(previous),
    comparisons: computeComparisons(
      settings,
      eventStats,
      previousWindow,
      conversionPropertyFirstSeen,
    ),
    funnel: computeFunnel(current, settings),
    dailyActive: computeDailyActive(current, activity, settings, now),
    histogram: computeActiveDaysHistogram(current, settings),
    cohorts: computeWeeklyCohorts(visible, settings, now, timezone),
    users: current.sort((a, b) => (a.trialStart < b.trialStart ? 1 : -1)),
    notes: computeNotes(settings, eventStats, occurrences, {
      startDate: window.startDate,
      endDate: getStatsPeriodEnd(window, now),
    }),
    internalUsers: currentAll.filter(u => u.isInternal).length,
  };
}

/** website_setting key that stores the trial definitions. */
export const TRIAL_SETTINGS_KEY = 'trial';
