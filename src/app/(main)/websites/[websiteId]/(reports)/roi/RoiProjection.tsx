'use client';
import { Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import {
  customerValue,
  defaultInputs,
  type PlanEconomics,
  PROJECTION_WINDOWS,
  type ProjectionInputs,
  type ProjectionMonth,
  type ProjectionWindow,
  project,
  projectionBase,
} from '@/lib/roiProjection';
import { ROI_COLORS } from './RoiCharts';

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
 * "What if" for ad spend, kept simple: ad dollars buy website visits at what a
 * visit cost before, and every visit turns into paying customers at the past
 * overall rate. No attempt to say which customers came from ads.
 */
export function RoiProjection({
  history,
  plans,
}: {
  history: ProjectionMonth[];
  plans: PlanEconomics;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const [lookback, setLookback] = useState<ProjectionWindow>(3);
  const base = useMemo(() => projectionBase(history, lookback), [history, lookback]);
  const defaults = useMemo(() => defaultInputs(base, plans), [base, plans]);
  const [inputs, setInputs] = useState<ProjectionInputs>(defaults);

  // Choosing other months restarts from what actually happened in them.
  useEffect(() => setInputs(defaults), [defaults]);

  if (!history.length) return null;

  const p = project(base, inputs);
  const vsToday = (n: number, f: (n: number) => string) =>
    formatMessage(messages.roiVsToday, { delta: signed(n, f) });
  const monthName = (m: string) => formatDate(new Date(`${m}-01T12:00:00`), 'MMM yyyy', locale);
  const monthsLabel =
    base.months.length > 1
      ? `${monthName(base.months[0])} – ${monthName(base.months[base.months.length - 1])}`
      : monthName(base.months[0]);
  const adMonths = history.slice(-lookback).filter(m => m.metaSpend + m.googleSpend > 0).length;
  const rate = base.visitorToTrial * base.trialToPaying;
  const oneIn = rate > 0 ? Math.round(1 / rate) : null;

  return (
    <Panel title={formatMessage(labels.roiWhatIf)}>
      <Column gap="5">
        <Row gap="2" alignItems="center" wrap="wrap">
          <Text color="muted" size="2">
            {formatMessage(labels.roiBasedOn)}
          </Text>
          {PROJECTION_WINDOWS.map(w => (
            <Button
              key={w}
              size="sm"
              variant={w === lookback ? 'primary' : 'outline'}
              onPress={() => setLookback(w)}
            >
              {formatMessage(messages.roiMonthsN, { n: w })}
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

        <Grid columns="repeat(auto-fit, minmax(160px, 1fr))" gap="3">
          <Result
            label={formatMessage(labels.roiVisitors)}
            value={int(p.projected.visitors)}
            delta={vsToday(p.projected.visitors - p.today.visitors, int)}
          />
          <Result
            label={formatMessage(labels.roiNewPayingCustomers)}
            value={one(p.projected.newCustomers)}
            delta={vsToday(p.projected.newCustomers - p.today.newCustomers, one)}
          />
          <Result
            label={formatMessage(labels.roiMoneyInPerMonth)}
            value={usd(p.moneyIn)}
            delta={vsToday(p.moneyIn - p.todayMoneyIn, usd)}
          />
          <Result
            label={formatMessage(labels.roiNetPerMonth)}
            value={usd(p.netIncome)}
            delta={vsToday(p.netIncome - p.todayNetIncome, usd)}
            tone={p.netIncome >= 0 ? 'good' : 'bad'}
          />
        </Grid>

        <Text size="3">
          {formatMessage(messages.roiProjSimple, {
            spend: usd(p.spend),
            visitors: int(p.projected.visitors),
            n: oneIn ?? '—',
            customers: one(p.projected.newCustomers),
          })}
        </Text>
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
          {formatMessage(messages.roiProjHow, {
            meta: money(base.metaCpc),
            google: money(base.googleCpc),
            months: monthsLabel,
            value: usd(customerValue(inputs).firstMonth),
            monthly: money(plans.sources.stripeMonthly),
            yearlyPrice: money(plans.sources.stripeYearly),
            yearly: Math.round(inputs.yearlyShare * 100),
          })}
        </Text>
      </Column>
    </Panel>
  );
}
