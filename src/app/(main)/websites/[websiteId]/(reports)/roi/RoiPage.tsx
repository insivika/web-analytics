'use client';
import { Box, Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { Fragment, type ReactNode, useState } from 'react';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { Panel } from '@/components/common/Panel';
import {
  useLocale,
  useMessages,
  useNavigation,
  useRoiReportQuery,
  useUpdateQuery,
} from '@/components/hooks';
import { formatDate } from '@/lib/date';
import {
  type MonthRow,
  periodBand,
  periodRows,
  ROI_PERIODS,
  type RoiPeriod,
  sumMonths,
} from '@/lib/roi';
import { type ChartMonth, FlowsChart, NetChart, ROI_COLORS } from './RoiCharts';
import { RoiProjection } from './RoiProjection';

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
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const { query, router, updateParams } = useNavigation();
  const period: RoiPeriod = (ROI_PERIODS as readonly string[]).includes(query.period)
    ? (query.period as RoiPeriod)
    : '3-months';
  const { data, error, isLoading } = useRoiReportQuery(websiteId);
  const sync = useUpdateQuery(`/websites/${websiteId}/roi/sync`);
  const [syncing, setSyncing] = useState(false);

  const periodLabels: Record<RoiPeriod, string> = {
    'this-month': formatMessage(labels.roiThisMonth),
    'last-month': formatMessage(labels.roiLastMonth),
    '3-months': formatMessage(labels.roiLast3Months),
    '12-months': formatMessage(labels.roiLast12Months),
  };
  const sourceNames: Record<string, string> = {
    meta: formatMessage(labels.roiMeta),
    google: formatMessage(labels.roiGoogle),
    stripe: formatMessage(labels.roiStripe),
    fx: 'FX',
  };

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
  const band = periodBand(
    months.map(m => m.month),
    firstActive,
    selected.map(m => m.month),
  );
  const monthDate = (m: string) => new Date(`${m}-01T12:00:00`);
  const short = (m: string) =>
    `${formatDate(monthDate(m), 'MMM', locale)}${m === currentMonth ? '*' : ''}`;
  const long = (m: string) => {
    const name = formatDate(monthDate(m), 'MMMM yyyy', locale);
    return m === currentMonth ? formatMessage(messages.roiSoFar, { month: name }) : name;
  };
  const chartMonths: ChartMonth[] = shown.map(m => ({
    label: short(m.month),
    stripe: m.moneyStripe,
    appStores: m.moneyAppStores ?? 0,
    meta: m.spendMeta,
    google: m.spendGoogle,
    net: m.netIncome,
  }));

  const positive = p.netIncome >= 0;
  const adShare = p.moneyIn > 0 ? Math.round((p.spend / p.moneyIn) * 100) : null;
  const periodName = periodLabels[period].toLowerCase();
  const fmtDateTime = (d: string | Date) => formatDate(new Date(d), 'PP p', locale);

  return (
    <Column gap="6" style={{ minWidth: 0 }}>
      <Row gap="2" wrap="wrap">
        {ROI_PERIODS.map(id => (
          <Button
            key={id}
            variant={id === period ? 'primary' : 'outline'}
            onPress={() => router.push(updateParams({ period: id }))}
          >
            {periodLabels[id]}
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
            {(data.stale?.length > 0 || data.spendFxGaps > 0 || data.syncErrors?.length > 0) && (
              <Column
                gap="1"
                paddingX="5"
                paddingY="3"
                borderRadius="3"
                border
                style={{ borderColor: ROI_COLORS.google }}
              >
                {data.stale?.map((s: any) => (
                  <Text key={s.source} size="2">
                    {formatMessage(messages.roiStale, {
                      source: sourceNames[s.source] ?? s.source,
                      date: fmtDateTime(s.lastSuccessAt),
                    })}
                  </Text>
                ))}
                {data.spendFxGaps > 0 && (
                  <Text size="2">
                    {formatMessage(messages.roiFxGapsWarning, { n: data.spendFxGaps })}
                  </Text>
                )}
                {data.syncErrors?.map((e: any) => (
                  <Text key={e.source} size="2">
                    {formatMessage(messages.roiSyncFailed, {
                      source: sourceNames[e.source] ?? e.source,
                      message: e.message,
                    })}
                  </Text>
                ))}
              </Column>
            )}

            <Column gap="2">
              <Text color="muted">
                {formatMessage(messages.roiNetIncomeFor, { period: periodName })}
              </Text>
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
                {adShare !== null
                  ? formatMessage(messages.roiSummaryShare, {
                      moneyIn: usd(p.moneyIn),
                      spend: usd(p.spend),
                      share: adShare,
                    })
                  : formatMessage(messages.roiSummary, {
                      moneyIn: usd(p.moneyIn),
                      spend: usd(p.spend),
                    })}
              </Text>
            </Column>

            <Row gap="2" wrap="wrap" alignItems="stretch">
              <Term
                label={formatMessage(labels.roiStripe)}
                value={usd(p.moneyStripe)}
                color={ROI_COLORS.stripe}
                sub={formatMessage(messages.roiStripeSub)}
              />
              <Op>+</Op>
              <Term
                label={formatMessage(labels.roiAppStores)}
                value={
                  data.appStoresAvailable
                    ? usd(p.moneyAppStores)
                    : formatMessage(labels.roiUnavailable)
                }
                color={ROI_COLORS.appStores}
                sub={formatMessage(messages.roiAppStoresSub)}
              />
              <Op>−</Op>
              <Term
                label={formatMessage(labels.roiMetaAds)}
                value={usd(p.spendMeta)}
                color={ROI_COLORS.meta}
                dashed
              />
              <Op>−</Op>
              <Term
                label={formatMessage(labels.roiGoogleAds)}
                value={
                  data.googleConnected ? usd(p.spendGoogle) : formatMessage(labels.roiNotConnected)
                }
                color={ROI_COLORS.google}
                dashed
              />
              <Op>=</Op>
              <Term
                label={formatMessage(labels.roiNetIncome)}
                value={usd(p.netIncome)}
                color={positive ? ROI_COLORS.positive : ROI_COLORS.negative}
                sub={formatMessage(messages.roiYearlySub, { amount: usd(p.yearly) })}
              />
            </Row>

            <Panel title={formatMessage(labels.roiFlowsTitle)}>
              <Column gap="4">
                <Row gap="5" wrap="wrap">
                  <Text size="2">
                    <Dot color={ROI_COLORS.stripe} />
                    {formatMessage(labels.roiStripe)}
                  </Text>
                  <Text size="2">
                    <Dot color={ROI_COLORS.appStores} />
                    {formatMessage(labels.roiAppStores)}
                  </Text>
                  <Text size="2">
                    <Dot color={ROI_COLORS.meta} dashed />
                    {formatMessage(labels.roiMetaAds)}
                  </Text>
                  <Text size="2">
                    <Dot color={ROI_COLORS.google} dashed />
                    {formatMessage(labels.roiGoogleAds)}
                  </Text>
                </Row>
                <FlowsChart
                  months={chartMonths}
                  band={band}
                  labels={{
                    stripe: formatMessage(labels.roiStripe),
                    appStores: formatMessage(labels.roiAppStores),
                    meta: formatMessage(labels.roiMetaAds),
                    google: formatMessage(labels.roiGoogleAds),
                  }}
                />
                <Text color="muted" size="1">
                  {formatMessage(messages.roiFlowsNote, { period: periodName })}
                </Text>
              </Column>
            </Panel>

            <Panel title={formatMessage(labels.roiNetTitle)}>
              <Column gap="3">
                <NetChart
                  months={chartMonths}
                  band={band}
                  label={formatMessage(labels.roiNetIncome)}
                />
                <Text color="muted" size="1">
                  {formatMessage(messages.roiNetNote, { period: periodName })}
                </Text>
              </Column>
            </Panel>

            {data.projection && (
              <RoiProjection
                history={data.projection.history}
                customerValue={data.projection.customerValue}
              />
            )}

            <Panel title={formatMessage(labels.roiFunnelTitle)}>
              <Column gap="3">
                <Row gap="2" alignItems="stretch" wrap="wrap">
                  <Step label={formatMessage(labels.roiVisitedSite)} value={int(p.visitors)} />
                  <Arrow rate={pct(p.trials, p.visitors)} />
                  <Step label={formatMessage(labels.roiStartedTrial)} value={int(p.trials)} />
                  <Arrow rate={pct(p.newCustomers, p.trials)} />
                  <Step
                    label={formatMessage(labels.roiNewPayingCustomers)}
                    value={int(p.newCustomers)}
                  />
                </Row>
                <Text color="muted" size="2">
                  {p.costPerCustomer === null
                    ? formatMessage(messages.roiNoSpendPeriod)
                    : formatMessage(messages.roiCostPerCustomer, {
                        amount: usd(p.costPerCustomer),
                      })}{' '}
                  {formatMessage(messages.roiFunnelNote, { hostname: data.hostname })}
                </Text>
              </Column>
            </Panel>

            <Panel title={formatMessage(labels.roiAllMonths)}>
              <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                <Grid
                  columns="minmax(150px,1.3fr) repeat(8, minmax(80px,1fr))"
                  gap="3"
                  style={{ minWidth: 880 }}
                >
                  {(
                    [
                      [labels.roiMonth, null, false],
                      [labels.roiStripe, ROI_COLORS.stripe, false],
                      [labels.roiAppStoresShort, ROI_COLORS.appStores, false],
                      [labels.roiMeta, ROI_COLORS.meta, true],
                      [labels.roiGoogle, ROI_COLORS.google, true],
                      [labels.roiNetIncome, null, false],
                      [labels.roiVisitors, null, false],
                      [labels.roiTrials, null, false],
                      [labels.roiNewPaying, null, false],
                    ] as [any, string | null, boolean][]
                  ).map(([label, color, dashed], i) => (
                    <Text
                      key={label.id}
                      color="muted"
                      align={i === 0 ? 'left' : 'right'}
                      wrap="nowrap"
                    >
                      {color && <Dot color={color} dashed={dashed} />}
                      {formatMessage(label)}
                    </Text>
                  ))}
                  {shown
                    .slice()
                    .reverse()
                    .map(r => {
                      const inPeriod = selected.some(s => s.month === r.month);
                      return (
                        <Fragment key={r.month}>
                          <Text weight={inPeriod ? 'bold' : undefined}>{long(r.month)}</Text>
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
                {formatMessage(messages.roiFooter)}{' '}
                {data.updatedAt &&
                  formatMessage(messages.roiUpdated, { date: fmtDateTime(data.updatedAt) })}
              </Text>
              <Button variant="quiet" isDisabled={syncing} onPress={runSync}>
                {formatMessage(syncing ? labels.roiSyncing : labels.roiSyncNow)}
              </Button>
            </Row>
          </Column>
        )}
      </LoadingPanel>
    </Column>
  );
}
