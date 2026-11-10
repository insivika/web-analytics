'use client';
import { Box, Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { Fragment, type ReactNode, useState } from 'react';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { Panel } from '@/components/common/Panel';
import { useLocale, useNavigation, useRoiReportQuery, useUpdateQuery } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import { type MonthRow, periodRows, ROI_PERIODS, type RoiPeriod, sumMonths } from '@/lib/roi';
import { type ChartMonth, FlowsChart, NetChart, ROI_COLORS } from './RoiCharts';

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

const Dot = ({ color, dashed }: { color: string; dashed?: boolean }) => (
  <span
    aria-hidden
    style={{
      display: 'inline-block',
      width: 14,
      height: 0,
      borderTop: `3px ${dashed ? 'dashed' : 'solid'} ${color}`,
      marginRight: 8,
      verticalAlign: 'middle',
    }}
  />
);

/** One term of the equation: Stripe + App stores − Meta − Google = Net income. */
function Term({
  label,
  value,
  color,
  dashed,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  dashed?: boolean;
  sub?: string;
}) {
  return (
    <Column
      paddingX="5"
      paddingY="4"
      borderRadius="3"
      border
      gap="1"
      style={{ flex: '1 1 150px', minWidth: 150, borderTop: `3px solid ${color}` }}
    >
      <Text color="muted" size="2" wrap="nowrap">
        <Dot color={color} dashed={dashed} />
        {label}
      </Text>
      <Text size="7" weight="bold" wrap="nowrap">
        {value}
      </Text>
      {sub && (
        <Text color="muted" size="1">
          {sub}
        </Text>
      )}
    </Column>
  );
}

const Op = ({ children }: { children: ReactNode }) => (
  <Column justifyContent="center" style={{ minWidth: 20 }}>
    <Text size="7" color="muted" align="center">
      {children}
    </Text>
  </Column>
);

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
  const selected = periodRows(months, period);
  const p = sumMonths(selected);
  const currentMonth = months[months.length - 1]?.month;

  // Charts and table start at the first month with any activity.
  const firstActive = Math.max(
    months.findIndex(m => m.moneyIn !== 0 || m.spend !== 0),
    0,
  );
  const shown = months.slice(firstActive);
  const short = (m: string) =>
    `${formatDate(new Date(`${m}-01T12:00:00`), 'MMM', locale)}${m === currentMonth ? '*' : ''}`;
  const long = (m: string) => formatDate(new Date(`${m}-01T12:00:00`), 'MMMM yyyy', locale);
  const chartMonths: ChartMonth[] = shown.map(m => ({
    label: short(m.month),
    stripe: m.moneyStripe,
    appStores: m.moneyAppStores ?? 0,
    meta: m.spendMeta,
    google: m.spendGoogle,
    net: m.netIncome,
  }));
  const firstSel = shown.findIndex(m => m.month === selected[0]?.month);
  const band: [number, number] = [firstSel, firstSel + selected.length - 1];

  const positive = p.netIncome >= 0;
  const adShare = p.moneyIn > 0 ? Math.round((p.spend / p.moneyIn) * 100) : null;
  const periodName = PERIOD_LABELS[period].toLowerCase();

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
            <Column gap="2">
              <Text color="muted">Net income, {periodName}</Text>
              <Text
                size="10"
                weight="bold"
                style={{
                  color: positive ? ROI_COLORS.positive : ROI_COLORS.negative,
                  lineHeight: 1,
                }}
              >
                {usd(p.netIncome)}
              </Text>
              <Text size="4">
                {usd(p.moneyIn)} came in from customers and {usd(p.spend)} went to ads
                {adShare !== null ? `, so ads cost ${adShare}¢ of every dollar that came in.` : '.'}
              </Text>
            </Column>

            <Row gap="2" wrap="wrap" alignItems="stretch">
              <Term
                label="Stripe"
                value={usd(p.moneyStripe)}
                color={ROI_COLORS.stripe}
                sub="Web, after Stripe fees"
              />
              <Op>+</Op>
              <Term
                label="App Store and Google Play"
                value={data.appStoresAvailable ? usd(p.moneyAppStores) : 'unavailable'}
                color={ROI_COLORS.appStores}
                sub="Via RevenueCat, after store cut"
              />
              <Op>−</Op>
              <Term label="Meta ads" value={usd(p.spendMeta)} color={ROI_COLORS.meta} dashed />
              <Op>−</Op>
              <Term
                label="Google ads"
                value={data.googleConnected ? usd(p.spendGoogle) : 'not connected'}
                color={ROI_COLORS.google}
                dashed
              />
              <Op>=</Op>
              <Term
                label="Net income"
                value={usd(p.netIncome)}
                color={positive ? ROI_COLORS.positive : ROI_COLORS.negative}
                sub={`${usd(p.yearly)} of money in from yearly plans`}
              />
            </Row>

            <Panel title="Money in and ad spend, month by month">
              <Column gap="4">
                <Row gap="5" wrap="wrap">
                  <Text size="2">
                    <Dot color={ROI_COLORS.stripe} />
                    Stripe
                  </Text>
                  <Text size="2">
                    <Dot color={ROI_COLORS.appStores} />
                    App Store and Google Play
                  </Text>
                  <Text size="2">
                    <Dot color={ROI_COLORS.meta} dashed />
                    Meta ads
                  </Text>
                  <Text size="2">
                    <Dot color={ROI_COLORS.google} dashed />
                    Google ads
                  </Text>
                </Row>
                <FlowsChart months={chartMonths} band={band} />
                <Text color="muted" size="1">
                  Solid lines are money coming in, dashed lines are money going to ads. The shaded
                  area is {periodName}. * = month so far.
                </Text>
              </Column>
            </Panel>

            <Panel title="Net income, month by month">
              <Column gap="3">
                <NetChart months={chartMonths} band={band} />
                <Text color="muted" size="1">
                  Money in minus ad spend for each month. Brighter bars are {periodName}.
                </Text>
              </Column>
            </Panel>

            <Panel title="From website visitor to paying customer">
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
                    : `${usd(p.costPerCustomer)} of ad spend per new paying customer.`}{' '}
                  Visitors are sessions on {data.hostname}. A new paying customer is someone whose
                  first payment fell in this period.
                </Text>
              </Column>
            </Panel>

            <Panel title="All months">
              <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                <Grid
                  columns="minmax(130px,1.3fr) repeat(8, minmax(80px,1fr))"
                  gap="3"
                  style={{ minWidth: 860 }}
                >
                  {(
                    [
                      ['Month', null],
                      ['Stripe', ROI_COLORS.stripe],
                      ['App stores', ROI_COLORS.appStores],
                      ['Meta', ROI_COLORS.meta],
                      ['Google', ROI_COLORS.google],
                      ['Net income', null],
                      ['Visitors', null],
                      ['Trials', null],
                      ['New paying', null],
                    ] as [string, string | null][]
                  ).map(([h, color], i) => (
                    <Text key={h} color="muted" align={i === 0 ? 'left' : 'right'} wrap="nowrap">
                      {color && <Dot color={color} dashed={h === 'Meta' || h === 'Google'} />}
                      {h}
                    </Text>
                  ))}
                  {shown
                    .slice()
                    .reverse()
                    .map(r => {
                      const inPeriod = selected.some(s => s.month === r.month);
                      return (
                        <Fragment key={r.month}>
                          <Text weight={inPeriod ? 'bold' : undefined}>
                            {long(r.month)}
                            {r.month === currentMonth ? ' (so far)' : ''}
                          </Text>
                          <Text align="right">{usd(r.moneyStripe)}</Text>
                          <Text align="right">{usd(r.moneyAppStores)}</Text>
                          <Text align="right">{usd(r.spendMeta)}</Text>
                          <Text align="right">{usd(r.spendGoogle)}</Text>
                          <Text
                            align="right"
                            weight="bold"
                            style={{
                              color: r.netIncome < 0 ? ROI_COLORS.negative : ROI_COLORS.positive,
                            }}
                          >
                            {usd(r.netIncome)}
                          </Text>
                          <Text align="right">{int(r.visitors)}</Text>
                          <Text align="right">{int(r.trials)}</Text>
                          <Text align="right">{int(r.newCustomers)}</Text>
                        </Fragment>
                      );
                    })}
                </Grid>
              </Box>
            </Panel>

            <Row gap="3" alignItems="center" wrap="wrap">
              <Text color="muted" size="2">
                Money in is everything Stripe, the App Store and Google Play paid out, after fees,
                commission, tax and refunds. Ad spend is Meta and Google as billed.{' '}
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
