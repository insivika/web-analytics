import {
  Accordion,
  AccordionItem,
  Box,
  Button,
  Column,
  DataColumn,
  DataTable,
  Grid,
  Heading,
  Icon,
  Row,
  Text,
} from '@umami/react-zen';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { InfoTip } from '@/components/common/InfoTip';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { Pager } from '@/components/common/Pager';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages, useTrialForecastQuery, useUpdateQuery } from '@/components/hooks';
import { ArrowDown, ArrowUp, Check } from '@/components/icons';
import { DownloadButton } from '@/components/input/DownloadButton';
import { formatDate } from '@/lib/date';
import type {
  ForecastBreakdownRow,
  ForecastRow,
  InsightRow,
  RiskFlag,
  SimulationRange,
  TrialForecastReport,
} from '@/lib/trialForecast';

const PAGE_SIZE = 25;

const pct = (p: number | null) =>
  p === null ? '—' : p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`;
const one = (n: number) => (Math.round(n * 10) / 10).toLocaleString();
const usd = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

type SortKey =
  | 'userId'
  | 'platform'
  | 'plan'
  | 'trialEnd'
  | 'phase'
  | 'activeDays'
  | 'activated'
  | 'p14'
  | 'flags';

const sortValue = (r: ForecastRow, key: SortKey) => {
  if (key === 'flags') return r.flags.length;
  const v = r[key];
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? '';
};

function HeadlineCard({
  label,
  range,
  revenue,
  runs,
}: {
  label: string;
  range: SimulationRange;
  revenue: SimulationRange;
  /** Simulated outcomes behind the range. */
  runs: number;
}) {
  const { formatMessage, messages } = useMessages();
  return (
    <Column paddingX="6" paddingY="4" borderRadius="3" backgroundColor border gap="1">
      <Text weight="bold">{label}</Text>
      <Text size="8" weight="bold" wrap="nowrap">
        {one(range.expected)}
      </Text>
      <Row alignItems="center" gap="1">
        <Text color="muted" size="1">
          {formatMessage(messages.forecastRange, { low: range.low, high: range.high })}
        </Text>
        <InfoTip
          content={formatMessage(messages.forecastRangeTip, { runs: runs.toLocaleString() })}
        />
      </Row>
      <Text size="2">
        {formatMessage(messages.forecastRevenue, {
          amount: usd(revenue.expected),
          low: usd(revenue.low),
          high: usd(revenue.high),
        })}
      </Text>
    </Column>
  );
}

function Breakdown({
  title,
  rows,
  name,
}: {
  title: string;
  rows: ForecastBreakdownRow[];
  name: (key: string) => string;
}) {
  const { formatMessage, labels } = useMessages();
  return (
    <Column gap="2">
      <Text weight="bold">{title}</Text>
      <Grid columns="2fr 1fr 1fr 1fr" gap="2">
        <Text color="muted" size="1" />
        <Text color="muted" size="1" align="right">
          {formatMessage(labels.users)}
        </Text>
        <Text color="muted" size="1" align="right">
          {formatMessage(labels.nextDays, { x: 7 })}
        </Text>
        <Text color="muted" size="1" align="right">
          {formatMessage(labels.nextDays, { x: 14 })}
        </Text>
        {rows.map(r => (
          <Fragment key={r.key}>
            <Text>{name(r.key)}</Text>
            <Text align="right">{r.users}</Text>
            <Text align="right">{one(r.expected7)}</Text>
            <Text align="right">{one(r.expected14)}</Text>
          </Fragment>
        ))}
      </Grid>
    </Column>
  );
}

function Insights({ rows, trials }: { rows: InsightRow[]; trials: number }) {
  const { formatMessage, labels, messages } = useMessages();
  const dimensionLabel: Record<string, string> = {
    activeDays: formatMessage(labels.activeDays),
    earlyActiveDays: formatMessage(labels.activeDaysFirstX, { x: 3 }),
    activated: formatMessage(labels.activated),
    recurringCreated: 'first_recurring_event_created',
    paywallShown: 'paywall_shown',
    pushOptIn: formatMessage(labels.pushOptIn),
    platform: formatMessage(labels.platform),
  };
  const groups = [...new Set(rows.map(r => r.dimension))];
  const max = Math.max(...rows.map(r => r.rate ?? 0), 0.01);

  return (
    <Column gap="3">
      <Row>
        <InfoTip content={formatMessage(messages.forecastInsightNote, { n: trials })}>
          {formatMessage(labels.aboutTheseNumbers)}
        </InfoTip>
      </Row>
      <Grid columns={{ xs: '1fr', md: '1fr 1fr' }} gap="6">
        {groups.map(dimension => (
          <Column key={dimension} gap="1">
            <Text weight="bold">{dimensionLabel[dimension] ?? dimension}</Text>
            {rows
              .filter(r => r.dimension === dimension)
              .map(r => (
                <Row key={r.value} alignItems="center" gap="3">
                  <Text style={{ width: 70 }}>{r.value}</Text>
                  <Box
                    borderRadius="2"
                    style={{
                      height: 10,
                      width: `${Math.max(((r.rate ?? 0) / max) * 60, r.rate ? 2 : 0)}%`,
                      background: r.n < 10 ? 'var(--base-color-8)' : 'var(--primary-color)',
                    }}
                  />
                  <Text wrap="nowrap" color={r.n < 10 ? 'muted' : undefined}>
                    {`${pct(r.rate)} (n = ${r.n})`}
                  </Text>
                </Row>
              ))}
          </Column>
        ))}
      </Grid>
    </Column>
  );
}

export function TrialForecast({
  websiteId,
  platform,
  internal,
}: {
  websiteId: string;
  platform: string;
  internal: string;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const { data, error, isLoading, isFetching } = useTrialForecastQuery(websiteId, {
    platform,
    internal,
  });
  const snapshot = useUpdateQuery(`/websites/${websiteId}/trial/forecast`);
  const [saving, setSaving] = useState(false);
  // Most likely buyers first: the people worth a nudge.
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'p14',
    desc: true,
  });
  const [page, setPage] = useState(1);
  // A filter change can shrink the list below the current page.
  useEffect(() => {
    setPage(1);
  }, [data?.rows]);

  const sorted = useMemo(() => {
    const rows = [...(data?.rows ?? [])].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.desc ? rows.reverse() : rows;
  }, [data?.rows, sort]);

  // "2|activated" → "2 active days in the first 3 · Activated"
  const segmentName = (segment: string) => {
    const [days, activated] = segment.split('|');
    return `${formatMessage(labels.activeDaysFirstX, { x: 3 })}: ${days.replace('-', '–')} · ${formatMessage(
      activated === 'activated' ? labels.activated : labels.notActivated,
    )}`;
  };

  const flagLabel = (flag: RiskFlag) =>
    ({
      expired: formatMessage(labels.trialExpiredNotBought),
      lowEngagement: formatMessage(labels.lowEngagement),
      notActivated: formatMessage(labels.notActivated),
    })[flag];

  const csv = useMemo(
    () =>
      sorted.map(r => ({
        user_id: r.userId,
        platform: r.platform ?? '',
        plan: r.plan ?? '',
        trial_start: r.trialStart,
        trial_end: r.trialEnd,
        phase: r.phase,
        trial_day: r.trialDay ?? '',
        days_since_trial_end: r.daysSinceTrialEnd ?? '',
        active_days: r.activeDays,
        active_days_first_3: r.earlyActiveDays,
        activated: r.activated,
        segment: r.segment,
        p_7: Math.round(r.p7 * 1000) / 1000,
        p_14: Math.round(r.p14 * 1000) / 1000,
        p_total: Math.round(r.pTotal * 1000) / 1000,
        expected_revenue_14_usd: Math.round(r.expectedRevenue14 * 100) / 100,
        risk: r.flags.join('|'),
        is_internal: r.isInternal,
      })),
    [sorted],
  );

  const runSnapshot = async () => {
    setSaving(true);
    try {
      const result = await snapshot.mutateAsync({});
      snapshot.toast(
        formatMessage(result?.saved ? messages.snapshotSaved : messages.snapshotAlreadySaved),
      );
    } catch (e: any) {
      snapshot.toast(
        formatMessage(messages.snapshotFailed, { message: e?.message ?? String(e ?? '') }),
      );
    } finally {
      setSaving(false);
      snapshot.touch('trialForecast');
    }
  };

  const header = (key: SortKey, label: string, tip?: string) => (
    <Row alignItems="center" gap="1">
      <Row
        alignItems="center"
        gap="1"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => {
          setPage(1);
          setSort(s => ({ key, desc: s.key === key ? !s.desc : key === 'p14' }));
        }}
      >
        <Text>{label}</Text>
        {sort.key === key && <Icon size="xs">{sort.desc ? <ArrowDown /> : <ArrowUp />}</Icon>}
      </Row>
      {tip && <InfoTip content={tip} />}
    </Row>
  );

  const title = formatMessage(labels.projectedConversions);
  const scope = formatMessage(messages.forecastScope, {
    days: data?.settings.postTrialDays ?? 16,
  });

  return (
    <Panel style={{ minWidth: 0 }}>
      <Column gap="4">
        <Row alignItems="center" gap="2" wrap="wrap">
          <Heading>{title}</Heading>
          <Text color="muted" size="1">
            {formatMessage(messages.forecastScopeShort)}
          </Text>
          <InfoTip content={scope} />
        </Row>
        <LoadingPanel
          data={data}
          error={error}
          isLoading={isLoading}
          isEmpty={false}
          minHeight="200px"
        >
          {data && !data.available && (
            <Text color="muted">
              {formatMessage(
                data.reason === 'noTracking'
                  ? messages.forecastNoTracking
                  : messages.forecastNoTraining,
              )}
            </Text>
          )}
          {data?.available && (
            <Column gap="6" style={{ opacity: isFetching ? 0.6 : 1, minWidth: 0 }}>
              <ForecastBody data={data} locale={locale} saving={saving} onSnapshot={runSnapshot} />
              <Accordion type="multiple">
                <AccordionItem>
                  {formatMessage(labels.trialsEndingSoonCount, { n: sorted.length })}
                  <Column gap="3" paddingTop="2">
                    <Row justifyContent="flex-end" alignItems="center">
                      <DownloadButton filename="projected-conversions" data={csv} />
                    </Row>
                    <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
                      <DataTable
                        data={sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
                        style={{ minWidth: 1000 }}
                      >
                        <DataColumn
                          id="userId"
                          label={header('userId', formatMessage(labels.userId))}
                          width="130px"
                        >
                          {(r: ForecastRow) => (
                            <Text title={r.userId} style={{ fontFamily: 'monospace' }}>
                              {`${r.userId.slice(0, 8)}…`}
                            </Text>
                          )}
                        </DataColumn>
                        <DataColumn
                          id="platform"
                          label={header('platform', formatMessage(labels.platform))}
                        >
                          {(r: ForecastRow) => r.platform ?? '–'}
                        </DataColumn>
                        <DataColumn id="plan" label={header('plan', formatMessage(labels.plan))}>
                          {(r: ForecastRow) => r.plan ?? '–'}
                        </DataColumn>
                        <DataColumn
                          id="trialEnd"
                          label={header('trialEnd', formatMessage(labels.trialEnd))}
                          width="120px"
                        >
                          {(r: ForecastRow) => formatDate(new Date(r.trialEnd), 'MMM d', locale)}
                        </DataColumn>
                        <DataColumn
                          id="phase"
                          label={header('phase', formatMessage(labels.trialStatus))}
                          width="140px"
                        >
                          {(r: ForecastRow) =>
                            r.phase === 'inTrial'
                              ? formatMessage(messages.trialDayX, { x: r.trialDay })
                              : formatMessage(messages.endedDaysAgo, { x: r.daysSinceTrialEnd })
                          }
                        </DataColumn>
                        <DataColumn
                          id="activeDays"
                          label={header('activeDays', formatMessage(labels.activeDays))}
                        >
                          {(r: ForecastRow) => r.activeDays}
                        </DataColumn>
                        <DataColumn
                          id="activated"
                          label={header('activated', formatMessage(labels.activated))}
                        >
                          {(r: ForecastRow) =>
                            r.activated ? (
                              <Icon size="sm" color="primary">
                                <Check />
                              </Icon>
                            ) : (
                              <Text color="muted">–</Text>
                            )
                          }
                        </DataColumn>
                        <DataColumn
                          id="p14"
                          label={header(
                            'p14',
                            formatMessage(labels.probability14),
                            formatMessage(messages.forecastPTip),
                          )}
                        >
                          {(r: ForecastRow) => (
                            <InfoTip
                              strong
                              content={formatMessage(messages.forecastPDetail, {
                                p7: pct(r.p7),
                                p14: pct(r.p14),
                                total: pct(r.pTotal),
                                segment: segmentName(r.segment),
                              })}
                            >
                              {pct(r.p14)}
                            </InfoTip>
                          )}
                        </DataColumn>
                        <DataColumn
                          id="flags"
                          label={header(
                            'flags',
                            formatMessage(labels.risk),
                            formatMessage(messages.forecastRiskTip),
                          )}
                          width="220px"
                        >
                          {(r: ForecastRow) => (
                            <Text color="muted" size="1">
                              {r.flags.map(flagLabel).join(' · ') || '–'}
                            </Text>
                          )}
                        </DataColumn>
                      </DataTable>
                    </Box>
                    <Pager
                      page={page}
                      pageSize={PAGE_SIZE}
                      count={sorted.length}
                      onPageChange={setPage}
                    />
                  </Column>
                </AccordionItem>
                <AccordionItem>
                  {formatMessage(labels.whatPredictsConversion)}
                  <Box paddingTop="2">
                    <Insights rows={data.insights} trials={data.insightTrials} />
                  </Box>
                </AccordionItem>
              </Accordion>
            </Column>
          )}
        </LoadingPanel>
      </Column>
    </Panel>
  );
}

function ForecastBody({
  data,
  locale,
  saving,
  onSnapshot,
}: {
  data: TrialForecastReport;
  locale: string;
  saving: boolean;
  onSnapshot: () => void;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const { headline, revenue, model, backtest, accuracy } = data;
  const phaseName = (key: string) =>
    key === 'inTrial' ? formatMessage(labels.inTrial) : formatMessage(labels.trialEnded);

  const howCalculated = [
    formatMessage(messages.forecastHow1, { n: headline.users, rate: pct(model.baseRate) }),
    formatMessage(messages.forecastHow2, { days: data.settings.postTrialDays }),
    formatMessage(messages.forecastHow3, { x: one(headline.conversions7.expected) }),
    formatMessage(messages.forecastHow4, { runs: data.settings.simulations.toLocaleString() }),
  ];
  const modelText = formatMessage(messages.forecastModel, {
    rate: pct(model.baseRate),
    n: model.trainingUsers,
    conversions: model.conversions,
    since: data.since ? formatDate(new Date(data.since), 'MMM d', locale) : '—',
    min: 50,
  });
  const revenueText = formatMessage(
    revenue.basis === 'net'
      ? messages.forecastRevenueNet
      : revenue.basis === 'partial'
        ? messages.forecastRevenuePartial
        : messages.forecastRevenueGross,
    {
      app: usd(revenue.byPlatform.ios),
      web: usd(revenue.byPlatform.web),
      monthly: pct(revenue.monthlyShare),
    },
  );
  const backtestText =
    backtest && backtest.users > 0
      ? formatMessage(
          backtest.withinRange ? messages.forecastBacktestIn : messages.forecastBacktestOut,
          {
            n: backtest.users,
            predicted: one(backtest.predicted.expected),
            low: backtest.predicted.low,
            high: backtest.predicted.high,
            actual: backtest.actual,
          },
        )
      : null;
  const accuracyText = [
    accuracy?.weeks.length
      ? formatMessage(messages.forecastAccuracy, {
          weeks: accuracy.weeks.length,
          predicted: one(accuracy.predicted),
          actual: accuracy.actual,
        })
      : formatMessage(messages.forecastAccuracyPending),
    accuracy && accuracy.calibration.length > 0
      ? `${formatMessage(labels.calibration)}: ${accuracy.calibration
          .map(b => `${b.bucket} → ${pct(b.actual)} (n = ${b.n})`)
          .join(', ')}`
      : null,
  ];

  return (
    <Column gap="4">
      <Row alignItems="center" gap="2" wrap="wrap">
        <Text size="4">
          {formatMessage(messages.forecastHeadline, {
            x: one(headline.conversions7.expected),
            y: one(headline.conversions14.expected),
            a: headline.conversions14.low,
            b: headline.conversions14.high,
            revenue: usd(headline.revenue14.expected),
          })}
        </Text>
        <InfoTip content={howCalculated}>{formatMessage(labels.howCalculated)}</InfoTip>
      </Row>
      <Grid columns={{ xs: '1fr', md: 'repeat(3, 1fr)' }} gap="3">
        <HeadlineCard
          label={formatMessage(labels.nextDays, { x: 7 })}
          range={headline.conversions7}
          revenue={headline.revenue7}
          runs={data.settings.simulations}
        />
        <HeadlineCard
          label={formatMessage(labels.nextDays, { x: 14 })}
          range={headline.conversions14}
          revenue={headline.revenue14}
          runs={data.settings.simulations}
        />
        <Column paddingX="6" paddingY="4" borderRadius="3" backgroundColor border gap="1">
          <Text weight="bold">{formatMessage(labels.usersForecast)}</Text>
          <Text size="8" weight="bold">
            {headline.users}
          </Text>
          <Text color="muted" size="1">
            {data.byPhase.map(p => `${phaseName(p.key)}: ${p.users}`).join(' · ')}
          </Text>
        </Column>
      </Grid>

      <Grid columns={{ xs: '1fr', md: '1fr 1fr' }} gap="6">
        <Breakdown
          title={formatMessage(labels.byTrialStatus)}
          rows={data.byPhase}
          name={phaseName}
        />
        <Breakdown title={formatMessage(labels.byPlatform)} rows={data.byPlatform} name={k => k} />
      </Grid>

      <Row gap="1" alignItems="center" wrap="wrap">
        <InfoTip content={modelText}>{formatMessage(labels.howPIsSet)}</InfoTip>
        <InfoTip content={revenueText}>{formatMessage(labels.firstPayment)}</InfoTip>
        {backtestText && (
          <InfoTip content={backtestText}>
            {formatMessage(
              backtest.withinRange ? labels.backtestInRange : labels.backtestOutOfRange,
            )}
          </InfoTip>
        )}
        <InfoTip content={accuracyText}>{formatMessage(labels.forecastAccuracyLabel)}</InfoTip>
        <InfoTip content={formatMessage(messages.forecastBillingNote)}>
          {formatMessage(labels.noBillingData)}
        </InfoTip>
        <Button variant="quiet" size="sm" isDisabled={saving} onPress={onSnapshot}>
          {saving ? formatMessage(labels.saving) : formatMessage(labels.snapshotNow)}
        </Button>
      </Row>
    </Column>
  );
}
