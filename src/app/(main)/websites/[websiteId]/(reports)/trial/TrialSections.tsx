import { Box, Column, Grid, ProgressBar, Row, Text } from '@umami/react-zen';
import { Fragment, type ReactNode } from 'react';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages } from '@/components/hooks';
import { ChangeLabel } from '@/components/metrics/ChangeLabel';
import { MetricsBar } from '@/components/metrics/MetricsBar';
import { formatDate } from '@/lib/date';
import { formatLongNumber } from '@/lib/format';
import type { TrialKpis as Kpis, TrialNote, TrialReport } from '@/lib/trial';

const formatPct = (n: number) => `${Math.round(n)}%`;

/** Short "No data yet for X" notes for the given events. */
function useNoteText() {
  const { formatMessage, messages } = useMessages();

  return (note: TrialNote) =>
    note.platform
      ? formatMessage(messages.noDataForEventOnPlatform, {
          event: note.event,
          platform: note.platform,
        })
      : formatMessage(messages.noDataForEvent, { event: note.event });
}

export function SectionNotes({ report, events }: { report: TrialReport; events: string[] }) {
  const noteText = useNoteText();
  const notes = report.notes.filter(n => events.includes(n.event));

  if (!notes.length) return null;

  return (
    <Column gap="1">
      {notes.map(note => (
        <Text key={`${note.event}:${note.platform ?? ''}`} color="muted" size="2">
          {noteText(note)}
        </Text>
      ))}
    </Column>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel title={title} style={{ minWidth: 0 }}>
      <Column gap="4">{children}</Column>
    </Panel>
  );
}

export function TrialNotes({ report }: { report: TrialReport }) {
  const { formatMessage, messages } = useMessages();
  const noteText = useNoteText();
  const startNote = report.notes.find(n => n.event === report.settings.trialStartEvent);

  if (!startNote && !report.internalUsers) return null;

  return (
    <Column gap="1">
      {startNote && <Text weight="bold">{noteText(startNote)}</Text>}
      {report.internalUsers > 0 && report.users.every(u => !u.isInternal) && (
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
}: {
  label: string;
  value: number;
  previous: number;
  isPercent?: boolean;
}) {
  const diff = value - previous;
  // Rates change in percentage points; counts change relative to the previous window.
  const change = isPercent ? diff : previous > 0 ? (diff / previous) * 100 : 0;
  const changeText = isPercent
    ? `${diff >= 0 ? '+' : ''}${Math.round(diff)} pts`
    : previous > 0
      ? `${Math.abs(Math.round(change))}%`
      : '–';

  return (
    <Column
      justifyContent="center"
      paddingX="6"
      paddingY="4"
      borderRadius="3"
      backgroundColor
      border
      gap="1"
    >
      <Text weight="bold" wrap="nowrap">
        {label}
      </Text>
      <Text size="8" weight="bold" wrap="nowrap">
        {isPercent ? formatPct(value) : formatLongNumber(value)}
      </Text>
      <Row>
        <ChangeLabel value={Math.round(change)} title={changeText}>
          {changeText}
        </ChangeLabel>
      </Row>
    </Column>
  );
}

export function TrialKpis({ report }: { report: TrialReport }) {
  const { formatMessage, labels, messages } = useMessages();
  const { kpis, previousKpis, settings } = report;
  const windowDays = Math.round(
    (+new Date(report.window.endDate) - +new Date(report.window.startDate)) / 864e5,
  );

  const cards: { key: keyof Kpis; label: string; isPercent?: boolean }[] = [
    { key: 'starts', label: formatMessage(labels.trialStarts) },
    { key: 'activated', label: formatMessage(labels.activated), isPercent: true },
    { key: 'active2', label: formatMessage(labels.activeDaysAtLeast, { x: 2 }), isPercent: true },
    { key: 'active3', label: formatMessage(labels.activeDaysAtLeast, { x: 3 }), isPercent: true },
    { key: 'pushOptIn', label: formatMessage(labels.pushOptIn), isPercent: true },
    { key: 'converted', label: formatMessage(labels.convertedToPaid), isPercent: true },
  ];

  return (
    <Column gap="2">
      <MetricsBar>
        {cards.map(({ key, label, isPercent }) => (
          <KpiCard
            key={key}
            label={label}
            value={kpis[key]}
            previous={previousKpis[key]}
            isPercent={isPercent}
          />
        ))}
      </MetricsBar>
      <Text color="muted" size="1">
        {formatMessage(messages.changeVsPrevious, { x: windowDays })}
      </Text>
      <SectionNotes
        report={report}
        events={[
          settings.activationEvent,
          settings.activeDayEvent,
          settings.pushEvent,
          ...settings.conversionEvents,
        ]}
      />
    </Column>
  );
}

export function TrialFunnel({ report }: { report: TrialReport }) {
  const { formatMessage, labels } = useMessages();

  return (
    <Section title={formatMessage(labels.trialJourney)}>
      <Grid columns="minmax(180px, 2fr) 3fr auto auto" gap="3" alignItems="center">
        <Text color="muted">{formatMessage(labels.milestone)}</Text>
        <Text color="muted">{formatMessage(labels.reachedInOrder)}</Text>
        <Text color="muted" align="right">
          {formatMessage(labels.reached)}
        </Text>
        <Text color="muted" align="right">
          {formatMessage(labels.medianTrialDay)}
        </Text>
        {report.funnel.map((step, index) => (
          <Fragment key={step.events.join('|')}>
            <Text weight="bold">{`${index + 1}. ${step.events.join(' / ')}`}</Text>
            <Row alignItems="center" gap="3">
              <ProgressBar
                value={step.pctInOrder}
                minValue={0}
                maxValue={100}
                style={{ width: '100%' }}
              />
              <Text weight="bold" wrap="nowrap" title={String(step.reachedInOrder)}>
                {formatPct(step.pctInOrder)}
              </Text>
            </Row>
            <Text align="right" wrap="nowrap">{`${formatPct(step.pct)} (${step.reached})`}</Text>
            <Text align="right">{step.medianDay ?? '–'}</Text>
          </Fragment>
        ))}
      </Grid>
      <SectionNotes report={report} events={report.settings.milestones.flat()} />
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
  }[];
}) {
  return (
    <Row alignItems="flex-end" gap="2" height="220px" paddingTop="6">
      {bars.map(bar => (
        <Column key={bar.key} flexGrow="1" alignItems="center" gap="1" height="100%">
          <Column flexGrow="1" width="100%" justifyContent="flex-end" alignItems="center" gap="1">
            <Text size="1" color="muted" wrap="nowrap">
              {bar.text}
            </Text>
            <Box
              title={bar.title}
              borderRadius="2"
              width="100%"
              style={{
                height: `${bar.max > 0 ? Math.max((bar.value / bar.max) * 100, bar.value > 0 ? 2 : 0) : 0}%`,
                background: 'var(--primary-color)',
                minHeight: 1,
              }}
            />
          </Column>
          <Text size="1" color="muted">
            {bar.label}
          </Text>
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
          text: point.eligible ? formatPct(point.pct) : '–',
          title: formatMessage(messages.activeOfEligible, {
            active: point.active,
            eligible: point.eligible,
          }),
        }))}
      />
      <SectionNotes report={report} events={[report.settings.activeDayEvent]} />
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
  const { formatMessage, labels } = useMessages();
  const { locale } = useLocale();
  const columns: { key: keyof Kpis; label: string }[] = [
    { key: 'activated', label: formatMessage(labels.activated) },
    { key: 'active2', label: formatMessage(labels.activeDaysAtLeast, { x: 2 }) },
    { key: 'active3', label: formatMessage(labels.activeDaysAtLeast, { x: 3 }) },
    { key: 'pushOptIn', label: formatMessage(labels.pushOptIn) },
    { key: 'converted', label: formatMessage(labels.convertedToPaid) },
  ];

  return (
    <Section title={formatMessage(labels.weeklyCohorts)}>
      <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
        <Grid
          columns={`minmax(160px, 1.5fr) repeat(${columns.length + 1}, minmax(90px, 1fr))`}
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
              </Row>
              <Text align="right">{row.starts}</Text>
              {columns.map(c => (
                <Text key={c.key} align="right">
                  {formatPct(row[c.key])}
                </Text>
              ))}
            </Fragment>
          ))}
        </Grid>
      </Box>
    </Section>
  );
}
