'use client';
import { Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import {
  type Economics,
  LAST_30_DAYS,
  LOOKBACKS,
  type Lookback,
  lookbackMonths,
  returnPer100,
} from '@/lib/roiBreakEven';
import {
  defaultInputs,
  outlook,
  type PlanEconomics,
  type ProjectionInputs,
  type ProjectionMonth,
  project,
  projectionBase,
  type Retention,
  withPaidVisits,
} from '@/lib/roiProjection';
import { OutlookChart, ROI_COLORS } from './RoiCharts';

const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const int = (n: number) => Math.round(n).toLocaleString('en-US');
const one = (n: number) => n.toFixed(1);
const signed = (n: number, f: (n: number) => string) => `${n >= 0 ? '+' : '−'}${f(Math.abs(n))}`;
const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
const SPEND_MAX = 3000;

function SpendSlider({
  label,
  value,
  color,
  onChange,
}: {
  label: string;
  value: number;
  color: string;
  onChange: (v: number) => void;
}) {
  return (
    <Row alignItems="center" gap="4" wrap="wrap">
      <Text size="3" style={{ minWidth: 200 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 14,
            borderTop: `3px dashed ${color}`,
            marginRight: 8,
            verticalAlign: 'middle',
          }}
        />
        {label}
      </Text>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={SPEND_MAX}
        step={25}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: '1 1 240px', accentColor: color }}
      />
      <Text size="5" weight="bold" align="right" style={{ minWidth: 80 }}>
        {usd(value)}
      </Text>
    </Row>
  );
}

function Result({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: string;
  delta: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <Column paddingX="5" paddingY="4" borderRadius="3" border gap="1">
      <Text color="muted" size="2">
        {label}
      </Text>
      <Text
        size="7"
        weight="bold"
        style={{
          color:
            tone === 'good'
              ? ROI_COLORS.positive
              : tone === 'bad'
                ? ROI_COLORS.negative
                : undefined,
        }}
      >
        {value}
      </Text>
      <Text color="muted" size="1">
        {delta}
      </Text>
    </Column>
  );
}

/**
 * "What if" for ad spend: ad dollars buy paid website visits at what a paid
 * visit cost in the chosen months, and those visits become paying customers at
 * their own channel's rate (from the break-even model: measured once enough
 * customers are traced to a paid click, estimated until then), not the overall
 * visitor rate. The 12-month outlook keeps today's money in flat and lets each
 * month's extra customers keep paying along the real drop-off curve.
 */
export function RoiProjection({
  history,
  plans,
  retention,
  economics,
  lookback,
  onLookback,
}: {
  history: ProjectionMonth[];
  plans: PlanEconomics;
  retention: Retention;
  economics: Economics | null;
  lookback: Lookback;
  onLookback: (w: Lookback) => void;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const meta = economics?.channels.meta;
  const google = economics?.channels.google;
  const months = lookbackMonths(lookback);
  const base = useMemo(
    () =>
      economics
        ? withPaidVisits(economics.base, {
            meta: economics.channels.meta.costPerVisit,
            google: economics.channels.google.costPerVisit,
          })
        : projectionBase(history, months),
    [history, months, economics],
  );
  const defaults = useMemo<ProjectionInputs>(
    () => ({
      ...defaultInputs(base, plans),
      metaPaidConversion: meta?.rate ?? null,
      googlePaidConversion: google?.rate ?? null,
      otherCostPerCustomerMonth: economics?.settings.otherCostPerCustomerMonth ?? 0,
      fixedMonthlyCosts: economics?.settings.fixedMonthlyCosts ?? 0,
    }),
    [base, plans, meta, google, economics],
  );
  const [inputs, setInputs] = useState<ProjectionInputs>(defaults);

  // Choosing other months restarts from what actually happened in them.
  useEffect(() => setInputs(defaults), [defaults]);

  if (!history.length) return null;

  const p = project(base, inputs);
  const o = outlook(base, inputs, retention);
  const first = o.months[0];
  const last = o.months[o.months.length - 1];
  const vsToday = (n: number, f: (n: number) => string) =>
    formatMessage(messages.roiVsToday, { delta: signed(n, f) });
  const monthName = (m: string) => formatDate(new Date(`${m}-01T12:00:00`), 'MMM yyyy', locale);
  const monthsLabel =
    lookback === LAST_30_DAYS
      ? formatMessage(messages.roiTheLast30Days)
      : base.months.length > 1
        ? `${monthName(base.months[0])} – ${monthName(base.months[base.months.length - 1])}`
        : monthName(base.months[0]);
  const adMonths = history.slice(-months).filter(m => m.metaSpend + m.googleSpend > 0).length;
  const rate = base.visitorToTrial * base.trialToPaying;
  const oneIn = rate > 0 ? Math.round(1 / rate) : null;
  const paidOneIn = (r: number | null | undefined) => (r && r > 0 ? Math.round(1 / r) : '—');
  const v12 = economics?.value[12] ?? 0;
  const per100 = {
    meta: returnPer100(meta?.costPerVisit ?? null, meta?.rate ?? null, v12),
    google: returnPer100(google?.costPerVisit ?? null, google?.rate ?? null, v12),
  };
  const perCustomerCost = inputs.otherCostPerCustomerMonth ?? 0;
  const fixedCost = inputs.fixedMonthlyCosts ?? 0;

  return (
    <Panel title={formatMessage(labels.roiWhatIf)}>
      <Column gap="5">
        <Row gap="2" alignItems="center" wrap="wrap">
          <Text color="muted" size="2">
            {formatMessage(labels.roiBasedOn)}
          </Text>
          {LOOKBACKS.map(w => (
            <Button
              key={w}
              size="sm"
              variant={w === lookback ? 'primary' : 'outline'}
              onPress={() => onLookback(w)}
            >
              {w === LAST_30_DAYS
                ? formatMessage(labels.roiLast30Days)
                : formatMessage(messages.roiMonthsN, { n: w })}
            </Button>
          ))}
          <Button size="sm" variant="quiet" onPress={() => setInputs(defaults)}>
            {formatMessage(labels.roiReset)}
          </Button>
        </Row>

        <Column gap="3">
          <SpendSlider
            label={formatMessage(labels.roiMetaPerMonth)}
            value={inputs.metaSpend}
            color={ROI_COLORS.meta}
            onChange={v => setInputs(i => ({ ...i, metaSpend: v }))}
          />
          <SpendSlider
            label={formatMessage(labels.roiGooglePerMonth)}
            value={inputs.googleSpend}
            color={ROI_COLORS.google}
            onChange={v => setInputs(i => ({ ...i, googleSpend: v }))}
          />
        </Column>

        <Grid columns="repeat(auto-fit, minmax(170px, 1fr))" gap="3">
          <Result
            label={formatMessage(labels.roiNetNextMonth)}
            value={usd(first.projected)}
            delta={vsToday(first.projected - first.today, usd)}
            tone={first.projected >= 0 ? 'good' : 'bad'}
          />
          <Result
            label={formatMessage(labels.roiNetMonth12)}
            value={usd(last.projected)}
            delta={vsToday(last.projected - last.today, usd)}
            tone={last.projected >= 0 ? 'good' : 'bad'}
          />
          <Result
            label={formatMessage(labels.roiExtra12)}
            value={signed(o.extraNetIncome, usd)}
            delta={
              o.paybackMonth
                ? formatMessage(messages.roiPaybackIn, { n: o.paybackMonth })
                : p.spend > base.metaSpend + base.googleSpend
                  ? formatMessage(messages.roiPaybackNone)
                  : formatMessage(messages.roiVsTodaySpend)
            }
            tone={o.extraNetIncome >= 0 ? 'good' : 'bad'}
          />
          <Result
            label={formatMessage(labels.roiExtraPaying12)}
            value={signed(last.extraPaying, one)}
            delta={formatMessage(messages.roiPerMonthNew, {
              n: signed(o.extraCustomersPerMonth, one),
            })}
          />
        </Grid>

        <OutlookChart
          labels={o.months.map(m => formatMessage(messages.roiMonthN, { n: m.month }))}
          today={o.months.map(m => Math.round(m.today))}
          projected={o.months.map(m => Math.round(m.projected))}
          todayLabel={formatMessage(labels.roiAtTodaySpend)}
          projectedLabel={formatMessage(messages.roiAtSpend, { spend: usd(p.spend) })}
        />

        <Text size="3">
          {economics
            ? formatMessage(messages.roiProjPaid, {
                spend: usd(p.spend),
                paid: int(p.projected.paidVisitors),
                visitors: int(p.projected.visitors),
                meta: paidOneIn(meta?.rate),
                google: paidOneIn(google?.rate),
                source: formatMessage(
                  meta?.rateSource === 'measured' && google?.rateSource === 'measured'
                    ? labels.roiMeasured
                    : labels.roiEstimated,
                ).toLowerCase(),
                all: oneIn ?? '—',
                customers: one(p.projected.newCustomers),
              })
            : formatMessage(messages.roiProjSimple, {
                spend: usd(p.spend),
                visitors: int(p.projected.visitors),
                n: oneIn ?? '—',
                customers: one(p.projected.newCustomers),
              })}
        </Text>
        {economics && (per100.meta !== null || per100.google !== null) && (
          <Text size="3" weight="bold">
            {formatMessage(messages.roiPer100, {
              meta: per100.meta === null ? '—' : usd(per100.meta),
              google: per100.google === null ? '—' : usd(per100.google),
            })}
          </Text>
        )}
        {economics && (perCustomerCost > 0 || fixedCost > 0) && (
          <Text color="muted" size="2">
            {formatMessage(messages.roiProjCosts, {
              perCustomer: `$${perCustomerCost.toFixed(2)}`,
              fixed: usd(fixedCost),
            })}
          </Text>
        )}
        {(p.beyondHistory || adMonths < 3) && (
          <Text size="2" style={{ color: ROI_COLORS.google }}>
            {[
              p.beyondHistory && formatMessage(messages.roiProjBeyond),
              adMonths < 3 && formatMessage(messages.roiProjThin, { n: adMonths }),
            ]
              .filter(Boolean)
              .join(' ')}
          </Text>
        )}
        <Text color="muted" size="1">
          {formatMessage(economics ? messages.roiOutlookHowPaid : messages.roiOutlookHow, {
            meta: money(base.metaCpc),
            google: money(base.googleCpc),
            months: monthsLabel,
            monthly: money(inputs.monthlyPrice),
            yearlyPrice: money(inputs.yearlyPrice),
            yearly: Math.round(inputs.yearlyShare * 100),
            m6: Math.round((retention.monthly[5] ?? 0) * 100),
            m12: Math.round((retention.monthly[11] ?? 0) * 100),
            renewal:
              retention.yearlyRenewal === null ? '—' : Math.round(retention.yearlyRenewal * 100),
            renewalN: retention.yearlyRenewalSample,
          })}
        </Text>
      </Column>
    </Panel>
  );
}
