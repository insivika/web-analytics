'use client';
import { Box, Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { Fragment, useState } from 'react';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { Panel } from '@/components/common/Panel';
import { useLocale, useNavigation, useRoiReportQuery, useUpdateQuery } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import { type MonthRow, periodRows, ROI_PERIODS, type RoiPeriod, sumMonths } from '@/lib/roi';

const PERIOD_LABELS: Record<RoiPeriod, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  '3-months': 'Last 3 months',
  '12-months': 'Last 12 months',
};

const usd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const int = (n: number) => n.toLocaleString('en-US');
const pct = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '—';

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <Column paddingX="6" paddingY="5" borderRadius="3" backgroundColor border gap="1">
      <Text color="muted">{label}</Text>
      <Text
        size="9"
        weight="bold"
        wrap="nowrap"
        style={{
          color:
            tone === 'good'
              ? 'var(--success-color, #2e9b5f)'
              : tone === 'bad'
                ? 'var(--danger-color, #d6453d)'
                : undefined,
        }}
      >
        {value}
      </Text>
      {note && (
        <Text color="muted" size="1">
          {note}
        </Text>
      )}
    </Column>
  );
}

function Step({ label, value }: { label: string; value: string }) {
  return (
    <Column
      paddingX="5"
      paddingY="4"
      borderRadius="3"
      border
      gap="1"
      style={{ flex: 1, minWidth: 140 }}
    >
      <Text color="muted" size="2">
        {label}
      </Text>
      <Text size="7" weight="bold">
        {value}
      </Text>
    </Column>
  );
}

function Arrow({ rate }: { rate: string }) {
  return (
    <Column alignItems="center" justifyContent="center" style={{ minWidth: 48 }}>
      <Text color="muted">→</Text>
      <Text color="muted" size="1">
        {rate}
      </Text>
    </Column>
  );
}

export function RoiPage({ websiteId }: { websiteId: string }) {
  const { locale } = useLocale();
  const { query, router, updateParams } = useNavigation();
  const period: RoiPeriod = (ROI_PERIODS as readonly string[]).includes(query.period)
    ? (query.period as RoiPeriod)
    : '3-months';
  const { data, error, isLoading } = useRoiReportQuery(websiteId);
  const sync = useUpdateQuery(`/websites/${websiteId}/roi/sync`);
  const [syncing, setSyncing] = useState(false);

  const runSync = async () => {
    setSyncing(true);
    try {
      await sync.mutateAsync({ source: 'meta', days: 7 });
      await sync.mutateAsync({ source: 'stripe', days: 14 });
    } finally {
      setSyncing(false);
      sync.touch('roi');
    }
  };

  const months: MonthRow[] = data?.months ?? [];
  const p = sumMonths(periodRows(months, period));
  const monthName = (m: string) => formatDate(new Date(`${m}-01T12:00:00`), 'MMM yyyy', locale);
  const currentMonth = months[months.length - 1]?.month;
  // Table: newest first, starting from the first month with any data.
  const firstActive = months.findIndex(m => m.moneyIn !== 0 || m.spend !== 0 || m.visitors !== 0);
  const tableRows = (firstActive < 0 ? [] : months.slice(firstActive)).slice().reverse();

  const spendNote = [
    `Meta ${usd(p.spendMeta)}`,
    data?.googleConnected ? `Google ${usd(p.spendGoogle)}` : 'Google not connected yet',
  ].join(' · ');
  const moneyNote = [
    `Stripe ${usd(p.moneyStripe)}`,
    `App Store and Google Play ${data?.appStoresAvailable ? usd(p.moneyAppStores) : 'unavailable'}`,
  ].join(' · ');

  return (
    <Column gap="6" style={{ minWidth: 0 }}>
      <Row gap="2" wrap="wrap">
        {ROI_PERIODS.map(id => (
          <Button
            key={id}
            variant={id === period ? 'primary' : 'outline'}
            onPress={() => router.push(updateParams({ period: id }))}
          >
            {PERIOD_LABELS[id]}
          </Button>
        ))}
      </Row>

      <LoadingPanel
        data={data}
        error={error}
        isLoading={isLoading}
        isEmpty={false}
        minHeight="300px"
      >
        {data && (
          <Column gap="6">
            <Text size="6" weight="bold">
              {PERIOD_LABELS[period]}: {usd(p.moneyIn)} came in, {usd(p.spend)} went to ads.{' '}
              {p.netIncome >= 0 ? 'You kept' : 'You lost'} {usd(Math.abs(p.netIncome))}.
            </Text>

            <Grid columns="repeat(auto-fit, minmax(220px, 1fr))" gap="3">
              <Stat
                label="Net income"
                value={usd(p.netIncome)}
                note="Money in minus ad spend"
                tone={p.netIncome >= 0 ? 'good' : 'bad'}
              />
              <Stat
                label="Money in"
                value={usd(p.moneyIn)}
                note={`${moneyNote} · ${usd(p.yearly)} from yearly plans`}
              />
              <Stat label="Spent on ads" value={usd(p.spend)} note={spendNote} />
            </Grid>

            <Panel title="From visitor to paying customer">
              <Column gap="3">
                <Row gap="2" alignItems="stretch" wrap="wrap">
                  <Step label="Visited the website" value={int(p.visitors)} />
                  <Arrow rate={pct(p.trials, p.visitors)} />
                  <Step label="Started a trial" value={int(p.trials)} />
                  <Arrow rate={pct(p.newCustomers, p.trials)} />
                  <Step label="New paying customers" value={int(p.newCustomers)} />
                </Row>
                <Text color="muted" size="2">
                  {p.costPerCustomer === null
                    ? 'No ad spend in this period.'
                    : `Ad spend per new paying customer: ${usd(p.costPerCustomer)}.`}{' '}
                  Visitors are sessions on {data.hostname}. New paying customers are people whose
                  first payment fell in this period.
                </Text>
              </Column>
            </Panel>

            <Panel title="Month by month">
              <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                <Grid
                  columns="minmax(110px,1.2fr) repeat(7, minmax(84px,1fr))"
                  gap="3"
                  style={{ minWidth: 780 }}
                >
                  {[
                    'Month',
                    'Ad spend',
                    'Visitors',
                    'Trials',
                    'New paying',
                    'Money in',
                    'Yearly plans',
                    'Net income',
                  ].map((h, i) => (
                    <Text key={h} color="muted" align={i === 0 ? 'left' : 'right'}>
                      {h}
                    </Text>
                  ))}
                  {tableRows.map(r => (
                    <Fragment key={r.month}>
                      <Text weight="bold">
                        {monthName(r.month)}
                        {r.month === currentMonth ? ' (so far)' : ''}
                      </Text>
                      <Text align="right">{usd(r.spend)}</Text>
                      <Text align="right">{int(r.visitors)}</Text>
                      <Text align="right">{int(r.trials)}</Text>
                      <Text align="right">{int(r.newCustomers)}</Text>
                      <Text align="right">{usd(r.moneyIn)}</Text>
                      <Text align="right">{usd(r.yearly)}</Text>
                      <Text
                        align="right"
                        weight="bold"
                        style={{
                          color: r.netIncome < 0 ? 'var(--danger-color, #d6453d)' : undefined,
                        }}
                      >
                        {usd(r.netIncome)}
                      </Text>
                    </Fragment>
                  ))}
                </Grid>
              </Box>
            </Panel>

            <Row gap="3" alignItems="center" wrap="wrap">
              <Text color="muted" size="2">
                Money in is Stripe plus App Store and Google Play, after fees, store commission, tax
                and refunds.{' '}
                {data.updatedAt &&
                  `Updated ${formatDate(new Date(data.updatedAt), 'PP p', locale)}.`}
              </Text>
              <Button variant="quiet" isDisabled={syncing} onPress={runSync}>
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            </Row>
            {data.syncErrors?.length > 0 && (
              <Text size="2" color="muted">
                {data.syncErrors.map((e: any) => `${e.source}: ${e.message}`).join(' · ')}
              </Text>
            )}
          </Column>
        )}
      </LoadingPanel>
    </Column>
  );
}
