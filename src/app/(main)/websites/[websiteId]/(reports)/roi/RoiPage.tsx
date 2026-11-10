'use client';
import { Box, Button, Column, Grid, ListItem, Row, Select, Text } from '@umami/react-zen';
import { endOfDay, startOfDay, subDays } from 'date-fns';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { Panel } from '@/components/common/Panel';
import {
  useLocale,
  useMessages,
  useNavigation,
  useRoiReportQuery,
  useUpdateQuery,
} from '@/components/hooks';
import { MetricsBar } from '@/components/metrics/MetricsBar';
import { formatDate } from '@/lib/date';

const PERIODS = ['30day', '90day', '180day', '365day'];
const usd = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined
    ? '—'
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const ratio = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
const int = (n: number) => n.toLocaleString('en-US');

function usePeriod() {
  const { query, router, updateParams } = useNavigation();
  const period = PERIODS.includes(query.period) ? query.period : '90day';
  const days = parseInt(period, 10);
  const today = startOfDay(new Date()).getTime();
  const window = useMemo(
    () => ({ startDate: subDays(startOfDay(new Date()), days - 1), endDate: endOfDay(new Date()) }),
    [days, today],
  );
  const target = Number(query.target) > 0 ? Number(query.target) : undefined;
  return {
    period,
    days,
    window,
    target,
    setPeriod: (p: string) => router.push(updateParams({ period: p })),
  };
}

function Card({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <Column paddingX="6" paddingY="4" borderRadius="3" backgroundColor border gap="1">
      <Text weight="bold">{label}</Text>
      <Text size="8" weight="bold" wrap="nowrap">
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

/** One step of the funnel: count, conversion from the previous step, cost per unit. */
function Step({
  label,
  value,
  rate,
  cost,
}: {
  label: string;
  value: string;
  rate?: string;
  cost?: string;
}) {
  return (
    <Column gap="1" style={{ minWidth: 130, flex: 1 }}>
      <Text color="muted" size="2">
        {label}
      </Text>
      <Text size="6" weight="bold">
        {value}
      </Text>
      {rate && <Text size="1">{rate}</Text>}
      {cost && (
        <Text color="muted" size="1">
          {cost}
        </Text>
      )}
    </Column>
  );
}

export function RoiPage({ websiteId }: { websiteId: string }) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const { period, days, window, target, setPeriod } = usePeriod();
  const { data, error, isLoading } = useRoiReportQuery(websiteId, {
    startAt: +window.startDate,
    endAt: +window.endDate,
    target,
  });
  const sync = useUpdateQuery(`/websites/${websiteId}/roi/sync`);
  const [syncError, setSyncError] = useState<string | null>(null);
  const fmtDate = (d: string | Date | null) => (d ? formatDate(new Date(d), 'PP p', locale) : '—');

  const runMetaSync = async (days: number) => {
    setSyncError(null);
    // Long backfills run as 30-day chunks so each request stays within function limits.
    for (let offset = 0; offset < days; offset += 30) {
      const result = await sync.mutateAsync({
        source: 'meta',
        days: Math.min(30, days - offset),
        offsetDays: offset,
      });
      if (result?.status === 'error') {
        setSyncError(result.message);
        break;
      }
    }
    sync.touch('roi');
  };

  const runRevenueSync = async (stripeDays: number) => {
    setSyncError(null);
    const stripe = await sync.mutateAsync({ source: 'stripe', days: stripeDays });
    if (stripe?.status === 'error') setSyncError(stripe.message);
    // RevenueCat pages through trial starters, one chunk per request.
    let offset: number | null = 0;
    while (offset !== null) {
      const rc = await sync.mutateAsync({ source: 'revenuecat', offset });
      if (rc?.status === 'error') {
        setSyncError(rc.message);
        break;
      }
      offset = rc?.nextOffset ?? null;
    }
    sync.touch('roi');
  };

  const s = data?.summary;
  const running = s ? s.trialStarts - s.completedTrials : 0;

  return (
    <Column gap style={{ minWidth: 0 }}>
      <Row alignItems="center" gap="3" wrap="wrap" justifyContent="space-between">
        <Select
          label={formatMessage(labels.roiPeriod)}
          value={period}
          onChange={value => setPeriod(String(value))}
          style={{ width: 220 }}
        >
          {PERIODS.map(p => (
            <ListItem key={p} id={p}>
              {formatMessage(labels.lastDays, { x: parseInt(p, 10) })}
            </ListItem>
          ))}
        </Select>
      </Row>
      <LoadingPanel
        data={data}
        error={error}
        isLoading={isLoading}
        isEmpty={false}
        minHeight="300px"
      >
        {data && (
          <Column gap>
            <Panel>
              <Column gap="2">
                <Text size="5" weight="bold">
                  {formatMessage(messages.roiFunnelHeadline, {
                    days,
                    spend: usd(s.spendUsd),
                    visitors: int(s.visitors),
                    trials: int(s.trialStarts),
                    customers: int(s.payingCustomers),
                    revenue: usd(s.netRevenue),
                  })}
                </Text>
                {s.roas !== null && (
                  <Text>{formatMessage(messages.roiReturn, { roas: ratio(s.roas) })}</Text>
                )}
                {data.headline.spendNeededUsd !== null && (
                  <Text>
                    {formatMessage(messages.roiSpendNeeded, {
                      target: usd(data.headline.targetRevenueUsd),
                      spend: usd(data.headline.spendNeededUsd),
                    })}
                  </Text>
                )}
                {running > 0 && (
                  <Text color="muted" size="2">
                    {formatMessage(messages.roiStillRunning, { n: running })}
                  </Text>
                )}
              </Column>
            </Panel>

            <Panel title={formatMessage(labels.marketingFunnel)}>
              <Row gap="6" wrap="wrap">
                <Step label={formatMessage(labels.adSpend)} value={usd(s.spendUsd)} />
                <Step
                  label={formatMessage(labels.websiteVisitors)}
                  value={int(s.visitors)}
                  rate={formatMessage(messages.roiSessionsOn, { hostname: data.hostname })}
                  cost={`${usd(s.costPerVisitor, 2)} / ${formatMessage(labels.visitors).toLowerCase()}`}
                />
                <Step
                  label={formatMessage(labels.trialStarts)}
                  value={int(s.trialStarts)}
                  rate={formatMessage(messages.roiOfVisitors, { rate: pct(s.visitorToTrial) })}
                  cost={`${formatMessage(labels.costPerTrial)}: ${usd(s.costPerTrial, 2)}`}
                />
                <Step
                  label={formatMessage(labels.payingCustomers)}
                  value={int(s.payingCustomers)}
                  rate={formatMessage(messages.roiOfCompletedTrials, {
                    rate: pct(s.trialToPaying),
                    n: s.completedTrials,
                  })}
                  cost={`CAC: ${usd(s.cac, 2)}`}
                />
                <Step
                  label={formatMessage(labels.netRevenueToDate)}
                  value={usd(s.netRevenue, 2)}
                  rate={`${formatMessage(labels.revenuePerCustomer)}: ${usd(s.revenuePerCustomer, 2)}`}
                  cost={`ROAS ${ratio(s.roas)} / $1`}
                />
              </Row>
            </Panel>

            <MetricsBar>
              <Card label={formatMessage(labels.grossRevenue)} value={usd(s.grossRevenue, 2)} />
              <Card label={formatMessage(labels.feesAndCommission)} value={usd(s.fees, 2)} />
              <Card
                label={formatMessage(labels.netRevenueToDate)}
                value={usd(s.netRevenue, 2)}
                note={formatMessage(messages.roiRevenueSource)}
              />
              <Card
                label={formatMessage(labels.cashIn)}
                value={usd(data.cashIn.total ?? data.cashIn.stripeNet, 2)}
                note={formatMessage(messages.roiCashInNote, {
                  stripe: usd(data.cashIn.stripeNet, 2),
                  revenuecat: usd(data.cashIn.revenuecatProceeds, 2),
                })}
              />
            </MetricsBar>

            <Panel title={formatMessage(labels.weeklyTrend)}>
              <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                <Grid
                  columns="minmax(150px,1.4fr) repeat(6, minmax(90px,1fr))"
                  gap="3"
                  style={{ minWidth: 780 }}
                >
                  {[
                    formatMessage(labels.signupWeek),
                    formatMessage(labels.adSpend),
                    formatMessage(labels.websiteVisitors),
                    formatMessage(labels.trialStarts),
                    formatMessage(labels.payingCustomers),
                    formatMessage(labels.netRevenueToDate),
                    'ROAS',
                  ].map(h => (
                    <Text key={h} color="muted">
                      {h}
                    </Text>
                  ))}
                  {data.weekly.map((row: any) => (
                    <Fragment key={row.week}>
                      <Row gap="2" alignItems="center">
                        <Text weight="bold">
                          {formatDate(new Date(`${row.week}T00:00:00`), 'PP', locale)}
                        </Text>
                        {row.immature && (
                          <Text color="muted" size="1">
                            {formatMessage(labels.immature)}
                          </Text>
                        )}
                      </Row>
                      <Text>{usd(row.spendUsd)}</Text>
                      <Text>{int(row.visitors)}</Text>
                      <Text>{row.trialStarts}</Text>
                      <Text>{row.payingCustomers}</Text>
                      <Text>{usd(row.netRevenue, 2)}</Text>
                      <Text>{ratio(row.roas)}</Text>
                    </Fragment>
                  ))}
                </Grid>
              </Box>
            </Panel>

            <Panel title={formatMessage(labels.spendByCampaign)}>
              {data.campaigns.length === 0 ? (
                <Text color="muted">{formatMessage(messages.roiNoSpend)}</Text>
              ) : (
                <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                  <Grid
                    columns="90px minmax(200px,2fr) repeat(3, minmax(90px,1fr))"
                    gap="3"
                    style={{ minWidth: 640 }}
                  >
                    {[
                      formatMessage(labels.channel),
                      formatMessage(labels.campaign),
                      formatMessage(labels.adSpend),
                      'Impr.',
                      formatMessage(labels.clicks),
                    ].map(h => (
                      <Text key={h} color="muted">
                        {h}
                      </Text>
                    ))}
                    {data.campaigns.map((c: any) => (
                      <Fragment key={`${c.channel}|${c.campaignId}`}>
                        <Text>{c.channel}</Text>
                        <Text title={c.campaignId}>{c.campaignName || c.campaignId}</Text>
                        <Text>{usd(c.spendUsd, 2)}</Text>
                        <Text>{c.impressions.toLocaleString()}</Text>
                        <Text>{c.clicks.toLocaleString()}</Text>
                      </Fragment>
                    ))}
                  </Grid>
                </Box>
              )}
            </Panel>

            <Panel title={formatMessage(labels.dataHealth)}>
              <Column gap="3">
                {data.health.sync.map((src: any) => (
                  <Row key={src.source} justifyContent="space-between" gap="3" wrap="wrap">
                    <Text weight="bold">{src.source}</Text>
                    <Text color={src.lastStatus === 'error' ? undefined : 'muted'}>
                      {src.lastStatus === 'error'
                        ? formatMessage(messages.roiSyncError, { message: src.lastMessage })
                        : formatMessage(messages.roiLastSync, { date: fmtDate(src.lastSuccessAt) })}
                    </Text>
                  </Row>
                ))}
                <Text color="muted" size="2">
                  {[
                    formatMessage(messages.roiUnmatched, { n: data.health.unmatchedStripeRows }),
                    formatMessage(messages.roiSpendFxGaps, { n: data.health.spendFxGaps }),
                  ].join(' · ')}
                </Text>
                <Row gap="3" wrap="wrap">
                  <Button
                    variant="outline"
                    isDisabled={sync.isPending}
                    onPress={() => runMetaSync(7)}
                  >
                    {formatMessage(labels.syncNow)}
                  </Button>
                  <Button
                    variant="quiet"
                    isDisabled={sync.isPending}
                    onPress={() => runMetaSync(180)}
                  >
                    {formatMessage(labels.backfill180)}
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={sync.isPending}
                    onPress={() => runRevenueSync(14)}
                  >
                    {formatMessage(labels.syncRevenue)}
                  </Button>
                  <Button
                    variant="quiet"
                    isDisabled={sync.isPending}
                    onPress={() => runRevenueSync(730)}
                  >
                    {formatMessage(labels.backfillRevenue)}
                  </Button>
                  {syncError && <Text>{syncError}</Text>}
                </Row>
              </Column>
            </Panel>
          </Column>
        )}
      </LoadingPanel>
    </Column>
  );
}
