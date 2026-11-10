import { Box, Column, Grid, ProgressBar, Row, Text } from '@umami/react-zen';
import { Fragment, type ReactNode } from 'react';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages } from '@/components/hooks';
import { ChangeLabel } from '@/components/metrics/ChangeLabel';
import { MetricsBar } from '@/components/metrics/MetricsBar';
import { formatDate } from '@/lib/date';
import { formatLongNumber } from '@/lib/format';
import {
  COHORT_WEEKS,
  MIN_DAILY_ACTIVE_USERS,
  type TrialComparison,
  type TrialKpiKey,
  type TrialReport,
} from '@/lib/trial';

const formatPct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);

/** "4 min", "5 h", "2.5 d" — fine-grained early on so day-1 milestones differ. */
export function formatDuration(hours: number | null) {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel title={title} style={{ minWidth: 0 }}>
      <Column gap="4">{children}</Column>
    </Panel>
  );
}

/** All missing-data notes, in one place at the top of the report. */
export function TrialNotes({ report }: { report: TrialReport }) {
  const { formatMessage, messages } = useMessages();
  const showInternal = report.internalUsers > 0 && report.users.every(u => !u.isInternal);

  if (!report.notes.length && !showInternal) return null;

  return (
    <Column gap="1">
      {report.notes.map(note =>
        note.type === 'noUserId' ? (
          <Text key={`${note.type}:${note.event}`} weight="bold" size="2">
            {formatMessage(messages.noUserIdForEvent, {
              event: note.event,
              property: note.property,
            })}
          </Text>
        ) : (
          <Text key={`${note.type}:${note.event}`} color="muted" size="2">
            {formatMessage(messages.noDataForEvent, { event: note.event })}
          </Text>
        ),
      )}
      {showInternal && (
        <Text color="muted" size="2">
          {formatMessage(messages.internalUsersExcluded, { x: report.internalUsers })}
        </Text>
      )}
    </Column>
  );
}

function KpiCard({
  label,
  value,
  previous,
  isPercent,
  comparison,
  emptyText,
  details,
}: {
  label: string;
  value: number | null;
  previous: number | null;
  isPercent?: boolean;
  comparison: TrialComparison;
  emptyText?: string;
  /** Extra lines under the value (e.g. the push prompt reach). */
  details?: string[];
}) {
  const { formatMessage, messages } = useMessages();
  const { locale } = useLocale();

  let footer: ReactNode;

  if (value === null) {
    footer = (
      <Text color="muted" size="1">
        {emptyText}
      </Text>
    );
  } else if (!comparison.available) {
    footer = (
      <Text color="muted" size="1">
        {comparison.trackingStart
          ? formatMessage(messages.noComparisonTrackingStarted, {
              date: formatDate(new Date(comparison.trackingStart), 'PP', locale),
            })
          : formatMessage(messages.noComparisonNoData)}
      </Text>
    );
  } else if (previous === null) {
    // Tracking covers the previous window, but none of its trials have completed.
    footer = (
      <Text color="muted" size="1">
        {formatMessage(messages.noComparisonPreviousUnfinished)}
      </Text>
    );
  } else {
    const diff = value - previous;
    // Rates change in percentage points; counts change relative to the previous window.
    const change = isPercent ? diff : previous > 0 ? (diff / previous) * 100 : 0;
    const text = isPercent
      ? `${diff >= 0 ? '+' : ''}${Math.round(diff)} pts`
      : previous > 0
        ? `${Math.abs(Math.round(change))}%`
        : '—';
    footer = (
      <Row>
        <ChangeLabel value={Math.round(change)} title={text}>
          {text}
        </ChangeLabel>
      </Row>
    );
  }

  return (
    <Column
      justifyContent="flex-start"
      paddingX="6"
      paddingY="4"
      borderRadius="3"
      backgroundColor
      border
      gap="1"
    >
      <Text weight="bold">{label}</Text>
      <Text size="8" weight="bold" wrap="nowrap">
        {isPercent ? formatPct(value) : value === null ? '—' : formatLongNumber(value)}
      </Text>
      {details?.map(line => (
        <Text key={line} color="muted" size="1">
          {line}
        </Text>
      ))}
      {footer}
    </Column>
  );
}

export function TrialKpis({ report }: { report: TrialReport }) {
  const { formatMessage, labels, messages } = useMessages();
  const { kpis, previousKpis, comparisons } = report;
  const windowDays = Math.round(
    (+new Date(report.window.endDate) - +new Date(report.window.startDate)) / 864e5,
  );

  const { locale } = useLocale();
  const pushSince = report.pushSince
    ? formatDate(new Date(report.pushSince), 'MMM d', locale)
    : null;
  const pushEmptyText = !pushSince
    ? formatMessage(messages.noPushPromptYet)
    : kpis.pushEligibleStarts === 0
      ? formatMessage(messages.noTrialStartsSince, { date: pushSince })
      : formatMessage(messages.noOneSawPrompt);

  const cards: {
    key: TrialKpiKey;
    label: string;
    isPercent?: boolean;
    emptyText?: string;
    details?: string[];
  }[] = [
    { key: 'starts', label: formatMessage(labels.trialStarts) },
    { key: 'activated', label: formatMessage(labels.activated), isPercent: true },
    { key: 'active2', label: formatMessage(labels.activeDaysAtLeast, { x: 2 }), isPercent: true },
    { key: 'active3', label: formatMessage(labels.activeDaysAtLeast, { x: 3 }), isPercent: true },
    {
      key: 'pushOptIn',
      label: formatMessage(labels.pushOptIn),
      isPercent: true,
      emptyText: pushEmptyText,
      details: pushSince
        ? [
            formatMessage(messages.pushSince, { date: pushSince }),
            ...(kpis.pushSeen === null
              ? []
              : [
                  formatMessage(messages.sawPrompt, {
                    pct: formatPct(kpis.pushSeen),
                    n: kpis.pushSeenUsers,
                  }),
                ]),
          ]
        : undefined,
    },
    {
      key: 'converted',
      label: formatMessage(labels.convertedCompletedTrials, { n: kpis.completedTrials }),
      isPercent: true,
      emptyText: formatMessage(messages.trialsNotFinished),
    },
  ];

  // Rates only count trials started on/after the metric's tracking date. Say so
  // when the window reaches back before it, and show the n each rate uses.
  const windowStart = new Date(report.window.startDate).toISOString();
  for (const card of cards) {
    if (card.key === 'starts' || card.key === 'pushOptIn') continue;
    const since = report.trackingSince[card.key];
    const lines: string[] = [];
    if (since && windowStart < since) {
      lines.push(
        formatMessage(messages.pushSince, { date: formatDate(new Date(since), 'MMM d', locale) }),
      );
    }
    if (card.key !== 'converted') {
      lines.push(formatMessage(messages.rateN, { n: kpis.n[card.key] }));
    }
    if (since === null) card.emptyText = formatMessage(messages.noComparisonNoData);
    else if (kpis.n[card.key] === 0 && card.key !== 'converted') {
      card.emptyText = formatMessage(messages.noTrialStartsSince, {
        date: formatDate(new Date(since), 'MMM d', locale),
      });
    }
    card.details = lines;
  }

  return (
    <Column gap="2">
      <MetricsBar>
        {cards.map(({ key, ...card }) => (
          <KpiCard
            key={key}
            value={kpis[key]}
            previous={previousKpis[key]}
            comparison={comparisons[key]}
            {...card}
          />
        ))}
      </MetricsBar>
      <Text color="muted" size="1">
        {[
          formatMessage(messages.trialStartSources, {
            derived: report.startSources.trialExpiresAt,
            property: report.settings.trialExpiresProperty,
            event: report.startSources.event,
            startEvent: report.settings.trialStartEvent,
          }),
          report.startSources.excludedLateAttached > 0 &&
            formatMessage(messages.excludedLateAttached, {
              x: report.startSources.excludedLateAttached,
            }),
          report.startSources.excludedRetrials > 0 &&
            formatMessage(messages.excludedRetrials, { x: report.startSources.excludedRetrials }),
          report.startSources.notObservedDuringTrial > 0 &&
            formatMessage(messages.notObservedDuringTrial, {
              x: report.startSources.notObservedDuringTrial,
            }),
          formatMessage(messages.changeVsPrevious, { x: windowDays }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </Column>
  );
}

export function TrialFunnel({ report }: { report: TrialReport }) {
  const { formatMessage, labels } = useMessages();

  return (
    <Section title={formatMessage(labels.trialJourney)}>
      <Grid columns="minmax(180px, 2fr) 3fr auto" gap="3" alignItems="center">
        <Text color="muted">{formatMessage(labels.milestone)}</Text>
        <Text color="muted">{formatMessage(labels.reached)}</Text>
        <Text color="muted" align="right">
          {formatMessage(labels.medianTimeFromStart)}
        </Text>
        {report.funnel.map((step, index) => (
          <Fragment key={step.events.join('|')}>
            <Text weight="bold">{`${index + 1}. ${step.events.join(' / ')}`}</Text>
            <Row alignItems="center" gap="3">
              <ProgressBar value={step.pct} minValue={0} maxValue={100} style={{ width: '100%' }} />
              <Text weight="bold" wrap="nowrap">
                {`${formatPct(step.pct)} (${step.reached})`}
              </Text>
            </Row>
            <Text align="right">{formatDuration(step.medianHours)}</Text>
          </Fragment>
        ))}
      </Grid>
    </Section>
  );
}

function VerticalBars({
  bars,
}: {
  bars: {
    key: string | number;
    label: string;
    value: number;
    max: number;
    title: string;
    text: string;
    caption?: string;
    muted?: boolean;
  }[];
}) {
  return (
    <Row alignItems="flex-end" gap="2" height="240px" paddingTop="6">
      {bars.map(bar => (
        <Column
          key={bar.key}
          flexGrow="1"
          alignItems="center"
          gap="1"
          height="100%"
          title={bar.title}
          style={{ opacity: bar.muted ? 0.45 : 1 }}
        >
          <Column flexGrow="1" width="100%" justifyContent="flex-end" alignItems="center" gap="1">
            <Text size="1" color="muted" wrap="nowrap">
              {bar.text}
            </Text>
            <Box
              borderRadius="2"
              width="100%"
              style={{
                height: `${bar.max > 0 ? Math.max((bar.value / bar.max) * 100, bar.value > 0 ? 2 : 0) : 0}%`,
                background: bar.muted ? 'var(--base-color-8)' : 'var(--primary-color)',
                minHeight: 1,
              }}
            />
          </Column>
          <Text size="1" color="muted">
            {bar.label}
          </Text>
          {bar.caption && (
            <Text size="1" color="muted" wrap="nowrap" style={{ fontSize: 10 }}>
              {bar.caption}
            </Text>
          )}
        </Column>
      ))}
    </Row>
  );
}

export function TrialDailyActive({ report }: { report: TrialReport }) {
  const { formatMessage, labels, messages } = useMessages();

  return (
    <Section
      title={`${formatMessage(labels.dailyActive)} (${formatMessage(labels.trialDay)} 1–${report.settings.trialLengthDays})`}
    >
      <VerticalBars
        bars={report.dailyActive.map(point => ({
          key: point.day,
          label: String(point.day),
          value: point.pct,
          max: 100,
          text: point.eligible ? formatPct(point.pct) : '—',
          caption: `n=${point.eligible}`,
          muted: point.lowSample,
          title: formatMessage(messages.activeOfEligible, {
            active: point.active,
            eligible: point.eligible,
          }),
        }))}
      />
      <Text color="muted" size="1">
        {formatMessage(messages.lowSampleDays, { x: MIN_DAILY_ACTIVE_USERS })}
      </Text>
    </Section>
  );
}

export function TrialActiveDaysHistogram({ report }: { report: TrialReport }) {
  const { formatMessage, labels, messages } = useMessages();
  const { buckets, noActiveDays } = report.histogram;
  const max = Math.max(...buckets.map(b => b.users), 0);

  return (
    <Section title={formatMessage(labels.activeDays)}>
      <VerticalBars
        bars={buckets.map(bucket => ({
          key: bucket.days,
          label: String(bucket.days),
          value: bucket.users,
          max,
          text: String(bucket.users),
          title: `${bucket.users} ${formatMessage(labels.users).toLowerCase()}`,
        }))}
      />
      {noActiveDays > 0 && (
        <Text color="muted" size="2">
          {formatMessage(messages.usersWithNoActiveDay, { x: noActiveDays })}
        </Text>
      )}
    </Section>
  );
}

export function TrialCohorts({ report }: { report: TrialReport }) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const columns: { key: TrialKpiKey; label: string }[] = [
    { key: 'activated', label: formatMessage(labels.activated) },
    { key: 'active2', label: formatMessage(labels.activeDaysAtLeast, { x: 2 }) },
    { key: 'active3', label: formatMessage(labels.activeDaysAtLeast, { x: 3 }) },
    { key: 'pushOptIn', label: formatMessage(labels.pushOptIn) },
    { key: 'converted', label: formatMessage(labels.convertedToPaid) },
  ];

  return (
    <Section
      title={`${formatMessage(labels.weeklyCohorts)} · ${formatMessage(labels.lastSignupWeeks, { x: COHORT_WEEKS })}`}
    >
      <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
        <Grid
          columns={`minmax(170px, 1.5fr) repeat(${columns.length + 1}, minmax(90px, 1fr))`}
          gap="3"
          alignItems="center"
          style={{ minWidth: 760 }}
        >
          <Text color="muted">{formatMessage(labels.signupWeek)}</Text>
          <Text color="muted" align="right">
            {formatMessage(labels.trialStarts)}
          </Text>
          {columns.map(c => (
            <Text key={c.key} color="muted" align="right">
              {c.label}
            </Text>
          ))}
          {report.cohorts.map(row => (
            <Fragment key={row.weekStart}>
              <Row gap="2" alignItems="center">
                <Text weight="bold">
                  {formatDate(new Date(`${row.weekStart}T00:00:00`), 'PP', locale)}
                </Text>
                {row.inProgress && (
                  <Text size="1" color="muted">
                    {formatMessage(labels.inProgress)}
                  </Text>
                )}
                {row.settling && (
                  <Text size="1" color="muted" title={formatMessage(messages.trialsNotFinished)}>
                    {formatMessage(labels.billingSettling)}
                  </Text>
                )}
              </Row>
              <Text align="right">{row.starts}</Text>
              {columns.map(c => (
                <Text
                  key={c.key}
                  align="right"
                  color={row.starts === 0 ? 'muted' : undefined}
                  title={
                    c.key === 'converted' && row.starts > 0 && !row.conversionFinal
                      ? formatMessage(messages.trialsNotFinished)
                      : undefined
                  }
                >
                  {row.starts === 0 ? (
                    '—'
                  ) : c.key !== 'starts' && row.beforeTracking[c.key] ? (
                    <Column alignItems="flex-end" gap="0">
                      <Text color="muted">—</Text>
                      <Text color="muted" size="1" style={{ fontSize: 10 }}>
                        {formatMessage(labels.beforeTracking)}
                      </Text>
                    </Column>
                  ) : (
                    formatPct(row[c.key])
                  )}
                </Text>
              ))}
            </Fragment>
          ))}
        </Grid>
      </Box>
    </Section>
  );
}
