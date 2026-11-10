import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import {
  computeTrialReport,
  detectTrialStarts,
  getStatsPeriodEnd,
  getTrialActivityEventNames,
  getTrialDataRange,
  getTrialDefinitionEvents,
  type TrialActivityRow,
  type TrialAttributeRow,
  type TrialConversionRow,
  type TrialEventStat,
  type TrialSettings,
  type TrialStartOccurrence,
  type TrialUserFilters,
  type TrialWindow,
} from '@/lib/trial';

// Trial report queries. Users are identified by an event-data property
// (settings.userIdProperty, default `user_id`) joined to website_event by event id;
// session_id / distinct_id are never used to link a user's events.

function notSupported(): never {
  throw new Error('The trial report is only implemented for PostgreSQL.');
}

export async function getTrialReport(
  websiteId: string,
  parameters: {
    window: TrialWindow;
    settings: TrialSettings;
    filters: TrialUserFilters;
    timezone?: string;
  },
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(websiteId, parameters),
    [CLICKHOUSE]: notSupported,
  });
}

async function relationalQuery(
  websiteId: string,
  {
    window,
    settings,
    filters,
    timezone,
  }: {
    window: TrialWindow;
    settings: TrialSettings;
    filters: TrialUserFilters;
    timezone?: string;
  },
) {
  const now = new Date();
  // Current + previous window, plus the last 8 signup weeks for the cohort table.
  const range = getTrialDataRange(window, now, timezone);

  const [occurrences, eventStats, conversionPropertyFirstSeen] = await Promise.all([
    getTrialStartOccurrences(websiteId, settings, range.endDate),
    getTrialEventStats(websiteId, settings, {
      startDate: window.startDate,
      endDate: getStatsPeriodEnd(window, now),
    }),
    getConversionPropertyFirstSeen(websiteId, settings),
  ]);

  const cohort = [...detectTrialStarts(occurrences, range)];

  const [activity, attributes, conversions] = cohort.length
    ? await Promise.all([
        getTrialActivity(websiteId, settings, cohort),
        getTrialAttributes(websiteId, settings, cohort),
        getTrialConversions(websiteId, settings, cohort),
      ])
    : [[], [], []];

  return computeTrialReport({
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
  });
}

async function getTrialStartOccurrences(
  websiteId: string,
  settings: TrialSettings,
  endDate: Date,
): Promise<TrialStartOccurrence[]> {
  return prisma.rawQuery(
    `
    select u.string_value as "userId", e.created_at as "createdAt"
    from website_event e
    join event_data u
      on u.website_event_id = e.event_id
      and u.data_key = {{userIdProperty}}
    where e.website_id = {{websiteId::uuid}}
      and e.event_name = {{startEvent}}
      and e.created_at < {{endDate}}
      and u.string_value is not null
      and u.string_value <> ''
    `,
    {
      websiteId,
      startEvent: settings.trialStartEvent,
      userIdProperty: settings.userIdProperty,
      endDate,
    },
    'getTrialStartOccurrences',
  );
}

/**
 * First-ever date of each definition event, and its row count in `period`.
 * Per-event subqueries let both use the (website_id, event_name, created_at)
 * index instead of scanning the website's whole event history.
 */
async function getTrialEventStats(
  websiteId: string,
  settings: TrialSettings,
  period: TrialWindow,
): Promise<TrialEventStat[]> {
  const rows = await prisma.rawQuery(
    `
    select n.name as "eventName",
      (select min(e.created_at) from website_event e
        where e.website_id = {{websiteId::uuid}} and e.event_name = n.name) as "firstSeen",
      (select count(*)::int from website_event e
        where e.website_id = {{websiteId::uuid}} and e.event_name = n.name
          and e.created_at >= {{periodStart}} and e.created_at < {{periodEnd}}) as "periodCount"
    from unnest({{eventNames}}::text[]) as n(name)
    `,
    {
      websiteId,
      periodStart: period.startDate,
      periodEnd: period.endDate,
      eventNames: getTrialDefinitionEvents(settings),
    },
    'getTrialEventStats',
  );

  return rows.map((row: any) => ({ ...row, periodCount: Number(row.periodCount) }));
}

/** When a conversion event first carried the required conversion property. */
async function getConversionPropertyFirstSeen(
  websiteId: string,
  settings: TrialSettings,
): Promise<Date | null> {
  if (!settings.conversionProperty || !settings.conversionEvents.length) return null;

  const [row] = await prisma.rawQuery(
    `
    select min(e.created_at) as "firstSeen"
    from website_event e
    where e.website_id = {{websiteId::uuid}}
      and e.event_name = any({{conversionEvents}}::text[])
      and exists (
        select 1 from event_data p
        where p.website_event_id = e.event_id
          and p.data_key = {{conversionProperty}}
          and p.string_value = {{conversionPropertyValue}}
      )
    `,
    {
      websiteId,
      conversionEvents: settings.conversionEvents,
      conversionProperty: settings.conversionProperty,
      conversionPropertyValue: settings.conversionPropertyValue,
    },
    'getConversionPropertyFirstSeen',
  );

  return row?.firstSeen ?? null;
}

const cohortParams = (cohort: [string, Date][]) => ({
  userIds: cohort.map(([userId]) => userId),
  trialStarts: cohort.map(([, date]) => date.toISOString()),
  minStart: new Date(Math.min(...cohort.map(([, date]) => +date))),
});

const COHORT_CTE = `
  cohort as (
    select * from unnest({{userIds}}::text[], {{trialStarts}}::timestamptz[]) as c(user_id, trial_start)
  )`;

async function getTrialActivity(
  websiteId: string,
  settings: TrialSettings,
  cohort: [string, Date][],
): Promise<TrialActivityRow[]> {
  const rows = await prisma.rawQuery(
    `
    with ${COHORT_CTE}
    select c.user_id as "userId",
      e.event_name as "eventName",
      floor(extract(epoch from (e.created_at - c.trial_start)) / 86400)::int as day,
      count(*)::int as count,
      min(e.created_at) as "firstAt"
    from website_event e
    join event_data u
      on u.website_event_id = e.event_id
      and u.data_key = {{userIdProperty}}
    join cohort c on c.user_id = u.string_value
    where e.website_id = {{websiteId::uuid}}
      and e.created_at >= {{minStart}}
      and e.event_name = any({{eventNames}}::text[])
      and e.created_at >= c.trial_start
      and e.created_at < c.trial_start + make_interval(days => {{trialDays::int}})
    group by 1, 2, 3
    `,
    {
      websiteId,
      userIdProperty: settings.userIdProperty,
      eventNames: getTrialActivityEventNames(settings),
      trialDays: settings.trialLengthDays,
      ...cohortParams(cohort),
    },
    'getTrialActivity',
  );

  return rows.map((row: any) => ({ ...row, day: Number(row.day), count: Number(row.count) }));
}

/**
 * First conversion event per user at or after their trial start (any time, or
 * within conversionWindowDays), optionally requiring a property value such as
 * is_trial_conversion = true.
 */
async function getTrialConversions(
  websiteId: string,
  settings: TrialSettings,
  cohort: [string, Date][],
): Promise<TrialConversionRow[]> {
  if (!settings.conversionEvents.length) return [];

  return prisma.rawQuery(
    `
    with ${COHORT_CTE}
    select c.user_id as "userId", min(e.created_at) as "firstAt"
    from website_event e
    join event_data u
      on u.website_event_id = e.event_id
      and u.data_key = {{userIdProperty}}
    join cohort c on c.user_id = u.string_value
    where e.website_id = {{websiteId::uuid}}
      and e.created_at >= {{minStart}}
      and e.event_name = any({{conversionEvents}}::text[])
      and e.created_at >= c.trial_start
      and ({{windowDays::int}} = 0
        or e.created_at < c.trial_start + make_interval(days => {{windowDays::int}}))
      and ({{conversionProperty}}::text = ''
        or exists (
          select 1 from event_data p
          where p.website_event_id = e.event_id
            and p.data_key = {{conversionProperty}}
            and p.string_value = {{conversionPropertyValue}}
        ))
    group by 1
    `,
    {
      websiteId,
      userIdProperty: settings.userIdProperty,
      conversionEvents: settings.conversionEvents,
      windowDays: settings.conversionWindowDays,
      conversionProperty: settings.conversionProperty,
      conversionPropertyValue: settings.conversionPropertyValue,
      ...cohortParams(cohort),
    },
    'getTrialConversions',
  );
}

async function getTrialAttributes(
  websiteId: string,
  settings: TrialSettings,
  cohort: [string, Date][],
): Promise<TrialAttributeRow[]> {
  const keys = [
    settings.platformProperty,
    settings.internalProperty,
    settings.statusProperty,
    settings.pushAnswerProperty,
    settings.pushGrantedProperty,
  ];

  return prisma.rawQuery(
    `
    with ${COHORT_CTE},
    props as (
      select c.user_id, c.trial_start, e.event_name, e.created_at, p.data_key, p.string_value,
        floor(extract(epoch from (e.created_at - c.trial_start)) / 86400) as day
      from event_data p
      join website_event e on e.event_id = p.website_event_id
      join event_data u
        on u.website_event_id = p.website_event_id
        and u.data_key = {{userIdProperty}}
      join cohort c on c.user_id = u.string_value
      where p.website_id = {{websiteId::uuid}}
        and p.created_at >= {{minStart}}
        and p.data_key = any({{keys}}::text[])
    )
    select user_id as "userId",
      coalesce(bool_or(data_key = {{internalProperty}} and string_value = 'true'), false) as "isInternal",
      coalesce(
        (array_agg(string_value order by created_at)
          filter (where data_key = {{platformProperty}} and day >= 0 and string_value <> 'unknown'))[1],
        (array_agg(string_value order by created_at) filter (where data_key = {{platformProperty}}))[1]
      ) as platform,
      (array_agg(string_value order by created_at desc)
        filter (where data_key = {{statusProperty}}))[1] as "subscriptionStatus",
      coalesce(bool_or(
        event_name = {{pushEvent}} and day >= 0 and day < {{trialDays::int}}
        and ((data_key = {{pushAnswerProperty}} and string_value = {{pushAnswerValue}})
          or (data_key = {{pushGrantedProperty}} and string_value = 'true'))
      ), false) as "pushOptIn",
      coalesce(bool_or(
        data_key = {{statusProperty}} and string_value = any({{paidStatuses}}::text[])
        and day >= 0 and ({{windowDays::int}} = 0 or day < {{windowDays::int}})
      ), false) as "paidInWindow"
    from props
    group by user_id
    `,
    {
      websiteId,
      keys,
      userIdProperty: settings.userIdProperty,
      internalProperty: settings.internalProperty,
      platformProperty: settings.platformProperty,
      statusProperty: settings.statusProperty,
      pushEvent: settings.pushEvent,
      pushAnswerProperty: settings.pushAnswerProperty,
      pushAnswerValue: settings.pushAnswerValue,
      pushGrantedProperty: settings.pushGrantedProperty,
      paidStatuses: settings.paidStatuses,
      trialDays: settings.trialLengthDays,
      windowDays: settings.conversionWindowDays,
      ...cohortParams(cohort),
    },
    'getTrialAttributes',
  );
}

export async function getTrialUserEvents(
  websiteId: string,
  userId: string,
  { userIdProperty, startDate }: { userIdProperty: string; startDate: Date },
) {
  return runQuery({
    [PRISMA]: () =>
      prisma.rawQuery(
        `
        select e.event_id as "eventId", e.created_at as "createdAt", e.event_name as "eventName",
          e.hostname, e.url_path as "urlPath",
          (select jsonb_object_agg(d.data_key, coalesce(d.string_value, d.number_value::text, d.date_value::text))
            from event_data d where d.website_event_id = e.event_id) as properties
        from event_data u
        join website_event e on e.event_id = u.website_event_id
        where u.website_id = {{websiteId::uuid}}
          and u.created_at >= {{startDate}}
          and u.data_key = {{userIdProperty}}
          and u.string_value = {{userId}}
        order by e.created_at
        limit 1000
        `,
        { websiteId, userId, userIdProperty, startDate },
        'getTrialUserEvents',
      ),
    [CLICKHOUSE]: notSupported,
  });
}
