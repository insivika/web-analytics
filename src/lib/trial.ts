// Trial report: definitions and the pure metric computations.
//
// Every metric is keyed on an event-data property (default `user_id`), never on
// session_id, because sessions don't follow a user from signup into the product.
// The SQL layer (src/queries/sql/reports/getTrial.ts) only fetches per-user
// aggregates; everything below is deterministic and unit-tested.

import { startOfWeek } from 'date-fns';
import { formatInTimeZone, utcToZonedTime } from 'date-fns-tz';

export const DAY_MS = 24 * 60 * 60 * 1000;

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
  conversionEvents: string[];
  statusProperty: string;
  paidStatuses: string[];
  /** Extra days after the trial in which a purchase still counts as converted. */
  conversionGraceDays: number;
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
  statusProperty: 'subscription_status',
  paidStatuses: ['active'],
  conversionGraceDays: 0,
  excludeInternal: true,
  internalProperty: 'is_internal',
  userIdProperty: 'user_id',
  platformProperty: 'platform',
};

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

    if (typeof fallback === 'string' && typeof current === 'string' && current.trim()) {
      (settings as any)[key] = current.trim();
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
  settings.conversionGraceDays = Math.min(settings.conversionGraceDays, 90);

  return settings;
}

/** All event names the report needs per-user activity for. */
export function getTrialEventNames(settings: TrialSettings): string[] {
  return [
    ...new Set([
      settings.activeDayEvent,
      settings.activationEvent,
      ...settings.milestones.flat(),
      ...settings.engagementEvents,
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
}

export interface TrialAttributeRow {
  userId: string;
  isInternal: boolean;
  platform: string | null;
  subscriptionStatus: string | null;
  pushOptIn: boolean;
  paidInWindow: boolean;
}

export interface TrialUser {
  userId: string;
  trialStart: string;
  platform: string | null;
  isInternal: boolean;
  /** 1-based current trial day, or null once the trial has ended. */
  currentTrialDay: number | null;
  activeDays: number;
  engagementCount: number;
  milestones: boolean[];
  activated: boolean;
  pushOptIn: boolean;
  converted: boolean;
  subscriptionStatus: string | null;
}

interface UserAccumulator {
  activeDaySet: Set<number>;
  events: Map<string, { count: number; firstDay: number }>;
}

/** Builds one row per trial user from the raw aggregates. */
export function buildTrialUsers(
  starts: Map<string, Date>,
  activity: TrialActivityRow[],
  attributes: TrialAttributeRow[],
  settings: TrialSettings,
  now: Date,
): TrialUser[] {
  const length = settings.trialLengthDays;
  const conversionDays = length + settings.conversionGraceDays;
  const acc = new Map<string, UserAccumulator>();

  for (const row of activity) {
    if (!starts.has(row.userId)) continue;
    const day = Number(row.day);
    if (day < 0 || day >= conversionDays) continue;

    let user = acc.get(row.userId);
    if (!user) {
      user = { activeDaySet: new Set(), events: new Map() };
      acc.set(row.userId, user);
    }

    const inTrial = day < length;

    if (row.eventName === settings.activeDayEvent && inTrial) {
      user.activeDaySet.add(day);
    }

    // Conversion events may land in the grace period; everything else is trial-only.
    if (!inTrial && !settings.conversionEvents.includes(row.eventName)) continue;

    const existing = user.events.get(row.eventName);
    const count = Number(row.count) || 0;
    if (existing) {
      existing.count += count;
      existing.firstDay = Math.min(existing.firstDay, day);
    } else {
      user.events.set(row.eventName, { count, firstDay: day });
    }
  }

  const attrs = new Map(attributes.map(a => [a.userId, a]));
  const inTrialEvent = (user: UserAccumulator | undefined, name: string) => {
    const event = user?.events.get(name);
    return !!event && event.firstDay < length;
  };

  return [...starts].map(([userId, start]) => {
    const user = acc.get(userId);
    const attr = attrs.get(userId);
    const elapsedDays = Math.floor((+now - +start) / DAY_MS);

    return {
      userId,
      trialStart: start.toISOString(),
      platform: attr?.platform ?? null,
      isInternal: !!attr?.isInternal,
      currentTrialDay: elapsedDays < length ? elapsedDays + 1 : null,
      activeDays: user?.activeDaySet.size ?? 0,
      engagementCount: settings.engagementEvents.reduce(
        (sum, name) => sum + (inTrialEvent(user, name) ? user.events.get(name).count : 0),
        0,
      ),
      milestones: settings.milestones.map(step => step.some(name => inTrialEvent(user, name))),
      activated: inTrialEvent(user, settings.activationEvent),
      pushOptIn: !!attr?.pushOptIn,
      converted:
        settings.conversionEvents.some(name => user?.events.has(name)) || !!attr?.paidInWindow,
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
  converted: number;
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);

export function computeKpis(users: TrialUser[]): TrialKpis {
  const n = users.length;
  const share = (fn: (u: TrialUser) => boolean) => pct(users.filter(fn).length, n);

  return {
    starts: n,
    activated: share(u => u.activated),
    active2: share(u => u.activeDays >= 2),
    active3: share(u => u.activeDays >= 3),
    pushOptIn: share(u => u.pushOptIn),
    converted: share(u => u.converted),
  };
}

export interface TrialFunnelStep {
  events: string[];
  reached: number;
  reachedInOrder: number;
  pct: number;
  pctInOrder: number;
  /** Median 1-based trial day on which the step was first reached. */
  medianDay: number | null;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function computeFunnel(
  users: TrialUser[],
  activity: TrialActivityRow[],
  settings: TrialSettings,
): TrialFunnelStep[] {
  const userSet = new Set(users.map(u => u.userId));
  const firstDays = new Map<string, number>();

  for (const row of activity) {
    if (!userSet.has(row.userId) || row.day < 0 || row.day >= settings.trialLengthDays) continue;
    const key = `${row.userId}\u0000${row.eventName}`;
    const existing = firstDays.get(key);
    if (existing === undefined || row.day < existing) firstDays.set(key, Number(row.day));
  }

  return settings.milestones.map((events, index) => {
    const reachedUsers = users.filter(u => u.milestones[index]);
    const inOrder = users.filter(u => u.milestones.slice(0, index + 1).every(Boolean));
    const days = reachedUsers
      .map(u => {
        const candidates = events
          .map(name => firstDays.get(`${u.userId}\u0000${name}`))
          .filter(d => d !== undefined);
        return candidates.length ? Math.min(...candidates) + 1 : undefined;
      })
      .filter(d => d !== undefined);

    return {
      events,
      reached: reachedUsers.length,
      reachedInOrder: inOrder.length,
      pct: pct(reachedUsers.length, users.length),
      pctInOrder: pct(inOrder.length, users.length),
      medianDay: median(days),
    };
  });
}

export interface TrialDailyActivePoint {
  day: number;
  active: number;
  eligible: number;
  pct: number;
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
  inProgress: boolean;
}

/** One row per signup week (weeks start Monday, in the viewer's timezone). */
export function computeWeeklyCohorts(
  users: TrialUser[],
  settings: TrialSettings,
  now: Date,
  timezone = 'UTC',
): TrialCohortRow[] {
  const groups = new Map<string, TrialUser[]>();

  for (const user of users) {
    const zoned = utcToZonedTime(new Date(user.trialStart), timezone);
    const week = formatInTimeZone(startOfWeek(zoned, { weekStartsOn: 1 }), 'UTC', 'yyyy-MM-dd');
    if (!groups.has(week)) groups.set(week, []);
    groups.get(week).push(user);
  }

  return [...groups]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([weekStart, group]) => ({
      weekStart,
      ...computeKpis(group),
      inProgress: group.some(
        u => +new Date(u.trialStart) + settings.trialLengthDays * DAY_MS > +now,
      ),
    }));
}

export type TrialNote = { type: 'noData'; event: string; platform?: string };

/** Notes for defined events that have no data yet, overall or per platform. */
export function computeNotes(
  users: TrialUser[],
  activity: TrialActivityRow[],
  settings: TrialSettings,
): TrialNote[] {
  const notes: TrialNote[] = [];
  const userSet = new Set(users.map(u => u.userId));
  const seen = new Map<string, Set<string>>();
  const platforms = new Map(users.map(u => [u.userId, u.platform]));

  for (const row of activity) {
    if (!userSet.has(row.userId)) continue;
    if (!seen.has(row.eventName)) seen.set(row.eventName, new Set());
    seen.get(row.eventName).add(platforms.get(row.userId) ?? 'unknown');
  }

  if (users.length === 0) {
    return [{ type: 'noData', event: settings.trialStartEvent }];
  }

  for (const event of getTrialEventNames(settings)) {
    if (!seen.has(event)) notes.push({ type: 'noData', event });
  }

  const presentPlatforms = TRIAL_PLATFORMS.filter(p => users.some(u => u.platform === p));

  for (const event of settings.engagementEvents) {
    const eventPlatforms = seen.get(event);
    if (!eventPlatforms) continue;
    for (const platform of presentPlatforms) {
      if (!eventPlatforms.has(platform)) notes.push({ type: 'noData', event, platform });
    }
  }

  return notes;
}

export interface TrialReport {
  settings: TrialSettings;
  window: TrialWindow;
  previousWindow: TrialWindow;
  kpis: TrialKpis;
  previousKpis: TrialKpis;
  funnel: TrialFunnelStep[];
  dailyActive: TrialDailyActivePoint[];
  histogram: ReturnType<typeof computeActiveDaysHistogram>;
  cohorts: TrialCohortRow[];
  users: TrialUser[];
  notes: TrialNote[];
  internalUsers: number;
}

export function computeTrialReport({
  occurrences,
  activity,
  attributes,
  settings,
  window,
  filters,
  now,
  timezone,
}: {
  occurrences: TrialStartOccurrence[];
  activity: TrialActivityRow[];
  attributes: TrialAttributeRow[];
  settings: TrialSettings;
  window: TrialWindow;
  filters: TrialUserFilters;
  now: Date;
  timezone?: string;
}): TrialReport {
  const previousWindow = getPreviousWindow(window);
  const allStarts = detectTrialStarts(occurrences, {
    startDate: previousWindow.startDate,
    endDate: window.endDate,
  });
  const allUsers = buildTrialUsers(allStarts, activity, attributes, settings, now);

  const inWindow = (u: TrialUser, w: TrialWindow) =>
    new Date(u.trialStart) >= w.startDate && new Date(u.trialStart) < w.endDate;

  const currentAll = allUsers.filter(u => inWindow(u, window));
  const current = filterTrialUsers(currentAll, filters);
  const previous = filterTrialUsers(
    allUsers.filter(u => inWindow(u, previousWindow)),
    filters,
  );

  return {
    settings,
    window,
    previousWindow,
    kpis: computeKpis(current),
    previousKpis: computeKpis(previous),
    funnel: computeFunnel(current, activity, settings),
    dailyActive: computeDailyActive(current, activity, settings, now),
    histogram: computeActiveDaysHistogram(current, settings),
    cohorts: computeWeeklyCohorts(current, settings, now, timezone),
    users: current.sort((a, b) => (a.trialStart < b.trialStart ? 1 : -1)),
    notes: computeNotes(current, activity, settings),
    internalUsers: currentAll.filter(u => u.isInternal).length,
  };
}

/** website_setting key that stores the trial definitions. */
export const TRIAL_SETTINGS_KEY = 'trial';
