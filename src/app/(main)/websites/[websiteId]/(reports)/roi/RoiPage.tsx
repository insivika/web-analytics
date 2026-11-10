'use client';
import { Box, Button, Column, Grid, ListItem, Row, Select, Text } from '@umami/react-zen';
import { endOfDay, startOfDay, subDays } from 'date-fns';
import { Fragment, type ReactNode, useMemo } from 'react';
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

const PERIODS = ['30day', '90day', '180day'];
const usd = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined
    ? '—'
    : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const ratio = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${n.toFixed(2)}×`;

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
  const fmtDate = (d: string | Date | null) => (d ? formatDate(new Date(d), 'PP p', locale) : '—');

  const runSync = (days: number) =>
    sync.mutateAsync({ source: 'meta', days }, { onSuccess: () => sync.touch('roi') });

  const s = data?.summary;
  const w = data?.roiWindow ?? 90;
  const immatureNote = (window: number) =>
    s && s.matureUsers?.[window] < s.trialStarts
      ? formatMessage(messages.roiImmature, {
          mature: s.matureUsers[window],
          n: s.trialStarts,
          days: window,
        })
      : s
        ? formatMessage(messages.rateN, { n: s.trialStarts })
        : undefined;

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
                  {s.roas === null
                    ? formatMessage(messages.roiHeadlineNoSpend, { days })
                    : formatMessage(messages.roiHeadline, {
                        days,
                        roas: usd(s.roas, 2),
                        window: w,
                      })}
                </Text>
                {data.headline.spendNeededUsd !== null && (
                  <Text>
                    {formatMessage(messages.roiSpendNeeded, {
                      target: usd(data.headline.targetRevenueUsd),
                      spend: usd(data.headline.spendNeededUsd),
                    })}
                  </Text>
                )}
                {data.headline.immature && (
                  <Text color="muted" size="2">
                    {formatMessage(messages.roiHeadlineImmature, { days: w })}
                  </Text>
                )}
              </Column>
            </Panel>

            <MetricsBar>
              <Card label={formatMessage(labels.adSpend)} value={usd(s.spendUsd)} />
              <Card
                label={formatMessage(labels.trialStartsAll)}
                value={s.trialStarts}
                note={formatMessage(messages.roiBlendedNote)}
              />
              <Card label={formatMessage(labels.payingCustomers)} value={s.payingCustomers} />
              <Card
                label={formatMessage(labels.netRevenueWindow, { days: w })}
                value={usd(s.revenue[w])}
                note={immatureNote(w)}
              />
              <Card label="ROAS" value={ratio(s.roas)} note={immatureNote(w)} />
              <Card
                label="CAC"
                value={usd(s.cac)}
                note={formatMessage(messages.rateN, { n: s.payingCustomers })}
              />
              <Card label={formatMessage(labels.costPerTrial)} value={usd(s.costPerTrial, 2)} />
              <Card
                label={formatMessage(labels.paybackDays)}
                value={s.paybackDays === null ? formatMessage(labels.notYet) : `${s.paybackDays} d`}
              />
            </MetricsBar>

            <Panel title={formatMessage(labels.blended)}>
              <Column gap="2">
                {data.settings.revenueWindows.map((win: number) => (
                  <Row key={win} justifyContent="space-between">
                    <Text>{formatMessage(labels.netRevenueWindow, { days: win })}</Text>
                    <Text weight="bold">
                      {usd(s.revenue[win])}{' '}
                      <Text color="muted" size="1">
                        {immatureNote(win)}
                      </Text>
                    </Text>
                  </Row>
                ))}
                <Row justifyContent="space-between">
                  <Text>{formatMessage(labels.projectedLtv)}</Text>
                  <Text weight="bold">
                    {usd(data.ltv.projectedLtv)}{' '}
                    <Text color="muted" size="1">
                      {formatMessage(messages.roiLtvNote, {
                        arpu: usd(data.ltv.arpuMonthly, 2),
                        churn:
                          data.ltv.monthlyChurn === null
                            ? '—'
                            : `${(data.ltv.monthlyChurn * 100).toFixed(1)}%`,
                        n: data.ltv.payingUsers,
                      })}
                    </Text>
                  </Text>
                </Row>
                <Text color="muted" size="1">
                  {formatMessage(messages.roiAttributionPending)}
                </Text>
              </Column>
            </Panel>

            <Panel title={formatMessage(labels.weeklyTrend)}>
              <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                <Grid
                  columns="minmax(150px,1.4fr) repeat(5, minmax(90px,1fr))"
                  gap="3"
                  style={{ minWidth: 700 }}
                >
                  {[
                    formatMessage(labels.signupWeek),
                    formatMessage(labels.adSpend),
                    formatMessage(labels.trialStarts),
                    formatMessage(labels.payingCustomers),
                    formatMessage(labels.netRevenueWindow, { days: w }),
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
                      <Text>{row.trialStarts}</Text>
                      <Text>{row.payingCustomers}</Text>
                      <Text>{usd(row.revenue[w])}</Text>
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
                    data.health.revenueTrackingStart &&
                      formatMessage(messages.roiRevenueSince, {
                        date: formatDate(new Date(data.health.revenueTrackingStart), 'PP', locale),
                      }),
                    formatMessage(messages.roiFxGaps, {
                      revenue: data.health.revenueFxGaps,
                      spend: data.health.spendFxGaps,
                    }),
                    formatMessage(messages.roiAttributionPending),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <Row gap="3">
                  <Button variant="outline" isDisabled={sync.isPending} onPress={() => runSync(7)}>
                    {formatMessage(labels.syncNow)}
                  </Button>
                  <Button variant="quiet" isDisabled={sync.isPending} onPress={() => runSync(180)}>
                    {formatMessage(labels.backfill180)}
                  </Button>
                  {sync.data?.status === 'error' && <Text>{sync.data.message}</Text>}
                </Row>
              </Column>
            </Panel>
          </Column>
        )}
      </LoadingPanel>
    </Column>
  );
}
