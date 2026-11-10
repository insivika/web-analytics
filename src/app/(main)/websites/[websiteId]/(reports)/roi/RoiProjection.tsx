'use client';
import { Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages } from '@/components/hooks';
import { formatDate } from '@/lib/date';
import {
  type CustomerValue,
  defaultInputs,
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
const SPEND_MAX = 3000;

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  color,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  color?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Row alignItems="center" gap="4" wrap="wrap">
      <Text color="muted" size="2" style={{ minWidth: 220 }}>
        {color && (
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
        )}
        {label}
      </Text>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: '1 1 200px', accentColor: color ?? ROI_COLORS.positive }}
      />
      <Text weight="bold" align="right" style={{ minWidth: 72 }}>
        {format(value)}
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

export function RoiProjection({
  history,
  customerValue,
}: {
  history: ProjectionMonth[];
  customerValue: CustomerValue;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const [lookback, setLookback] = useState<ProjectionWindow>(3);
  const base = useMemo(() => projectionBase(history, lookback), [history, lookback]);
  const defaults = useMemo(() => defaultInputs(base, customerValue), [base, customerValue]);
  const [inputs, setInputs] = useState<ProjectionInputs>(defaults);

  // Choosing other months restarts from what actually happened in them.
  useEffect(() => setInputs(defaults), [defaults]);

  if (!history.length) return null;

  const set = (k: keyof ProjectionInputs) => (v: number) => setInputs(i => ({ ...i, [k]: v }));
  const p = project(base, inputs);
  const vsToday = (n: number, f: (n: number) => string) =>
    formatMessage(messages.roiVsToday, { delta: signed(n, f) });
  const monthName = (m: string) => formatDate(new Date(`${m}-01T12:00:00`), 'MMM yyyy', locale);
  const monthsLabel =
    base.months.length > 1
      ? `${monthName(base.months[0])} – ${monthName(base.months[base.months.length - 1])}`
      : monthName(base.months[0]);
  const adMonths = history.slice(-lookback).filter(m => m.metaSpend + m.googleSpend > 0).length;
  const pctFmt = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

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
          <Slider
            label={formatMessage(labels.roiMetaPerMonth)}
            value={inputs.metaSpend}
            min={0}
            max={SPEND_MAX}
            step={25}
            format={usd}
            color={ROI_COLORS.meta}
            onChange={set('metaSpend')}
          />
          <Slider
            label={formatMessage(labels.roiGooglePerMonth)}
            value={inputs.googleSpend}
            min={0}
            max={SPEND_MAX}
            step={25}
            format={usd}
            color={ROI_COLORS.google}
            onChange={set('googleSpend')}
          />
        </Column>

        <Grid columns="repeat(auto-fit, minmax(160px, 1fr))" gap="3">
          <Result
            label={formatMessage(labels.roiVisitors)}
            value={int(p.projected.visitors)}
            delta={vsToday(p.projected.visitors - p.today.visitors, int)}
          />
          <Result
            label={formatMessage(labels.roiTrials)}
            value={int(p.projected.trials)}
            delta={vsToday(p.projected.trials - p.today.trials, int)}
          />
          <Result
            label={formatMessage(labels.roiNewPayingCustomers)}
            value={one(p.projected.newCustomers)}
            delta={vsToday(p.projected.newCustomers - p.today.newCustomers, one)}
          />
          <Result
            label={formatMessage(labels.roiNetPerMonth)}
            value={usd(p.netIncome)}
            delta={vsToday(p.netIncome - p.todayNetIncome, usd)}
            tone={p.netIncome >= 0 ? 'good' : 'bad'}
          />
        </Grid>

        <Text size="3">
          {p.spend <= 0
            ? formatMessage(messages.roiProjNoAds, {
                visitors: int(p.withoutAds.visitors),
                customers: one(p.withoutAds.newCustomers),
              })
            : [
                formatMessage(messages.roiProjStory, {
                  spend: usd(p.spend),
                  visitors: int(p.projected.visitors - p.withoutAds.visitors),
                  customers: one(p.customersFromAds),
                  cpa: p.costPerCustomerFromAds === null ? '—' : usd(p.costPerCustomerFromAds),
                }),
                formatMessage(
                  p.firstYearReturn >= 0 ? messages.roiProjYearGain : messages.roiProjYearLoss,
                  {
                    revenue: usd(p.customersFromAds * inputs.firstYearValue),
                    amount: usd(Math.abs(p.firstYearReturn)),
                  },
                ),
              ].join(' ')}
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

        <Column
          gap="3"
          paddingTop="4"
          style={{ borderTop: '1px solid var(--border-color, rgba(128,128,128,0.25))' }}
        >
          <Text weight="bold">{formatMessage(labels.roiAssumptions)}</Text>
          <Slider
            label={formatMessage(labels.roiVisitorToTrial)}
            value={inputs.visitorToTrial}
            min={0.002}
            max={0.08}
            step={0.001}
            format={pctFmt}
            onChange={set('visitorToTrial')}
          />
          <Slider
            label={formatMessage(labels.roiTrialToPaying)}
            value={inputs.trialToPaying}
            min={0.02}
            max={0.8}
            step={0.01}
            format={pctFmt}
            onChange={set('trialToPaying')}
          />
          <Slider
            label={formatMessage(labels.roiAdVisitorQuality)}
            value={inputs.adVisitorQuality}
            min={0.1}
            max={1.5}
            step={0.05}
            format={v => formatMessage(messages.roiOfNormal, { pct: Math.round(v * 100) })}
            onChange={set('adVisitorQuality')}
          />
          <Slider
            label={formatMessage(labels.roiFirstMonthValue)}
            value={inputs.firstMonthValue}
            min={0}
            max={150}
            step={1}
            format={usd}
            onChange={set('firstMonthValue')}
          />
          <Slider
            label={formatMessage(labels.roiFirstYearValue)}
            value={inputs.firstYearValue}
            min={0}
            max={300}
            step={1}
            format={usd}
            onChange={set('firstYearValue')}
          />
          <Slider
            label={formatMessage(labels.roiPricier)}
            value={inputs.pricier}
            min={0}
            max={0.5}
            step={0.05}
            format={v => `${Math.round(v * 100)}%`}
            onChange={set('pricier')}
          />
          <Text color="muted" size="1">
            {formatMessage(messages.roiProjNote, {
              months: monthsLabel,
              meta: base.metaCpc === null ? '—' : `$${base.metaCpc.toFixed(2)}`,
              google: base.googleCpc === null ? '—' : `$${base.googleCpc.toFixed(2)}`,
            })}
          </Text>
        </Column>
      </Column>
    </Panel>
  );
}
