'use client';
import { Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { InfoTip } from '@/components/common/InfoTip';
import { Panel } from '@/components/common/Panel';
import { useMessages } from '@/components/hooks';
import {
  DEFAULT_TAP_TO_SIGNUP,
  type Economics,
  LAST_30_DAYS,
  type Lookback,
  returnPer100,
} from '@/lib/roiBreakEven';
import {
  defaultInputs,
  outlook,
  type PlanEconomics,
  type ProjectionInputs,
  type Retention,
  withPaidVisits,
} from '@/lib/roiProjection';
import { OutlookChart, ROI_COLORS } from './RoiCharts';

const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const signedUsd = (n: number) => `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`;
const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
const oneIn = (r: number | null) => (r && r > 0 ? Math.round(1 / r).toLocaleString('en-US') : '—');
const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const SPEND_MAX = 3000;
const LOOKBACK_CHOICES: Lookback[] = [LAST_30_DAYS, 3];

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
      <Text size="3" style={{ minWidth: 180 }}>
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

/** A percentage slider (values are shares, 0..1). */
function RateSlider({
  label,
  value,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <Row alignItems="center" gap="4" wrap="wrap">
      <Text size="3" style={{ minWidth: 180 }}>
        {label}
      </Text>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={max * 100}
        step={step * 100}
        value={value * 100}
        onChange={e => onChange(Number(e.target.value) / 100)}
        style={{ flex: '1 1 240px', accentColor: ROI_COLORS.stripe }}
      />
      <Text size="5" weight="bold" align="right" style={{ minWidth: 80 }}>
        {`${(value * 100).toFixed(1)}%`}
      </Text>
    </Row>
  );
}

function Card({
  label,
  value,
  sub,
  good,
}: {
  label: string;
  value: string;
  sub: string;
  good: boolean;
}) {
  return (
    <Column paddingX="5" paddingY="4" borderRadius="3" border gap="1">
      <Text color="muted" size="2">
        {label}
      </Text>
      <Text
        size="7"
        weight="bold"
        style={{ color: good ? ROI_COLORS.positive : ROI_COLORS.negative }}
      >
        {value}
      </Text>
      <Text color="muted" size="1">
        {sub}
      </Text>
    </Column>
  );
}

/**
 * Do ads pay off? One answer (what $100 of ads brings back within a year),
 * two spend sliders and what they do to the next 12 months, and what it would
 * take to break even. The detail lives in one "How this is calculated" tip.
 */
export function RoiPayoff({
  economics: e,
  plans,
  retention,
  lookback,
  onLookback,
}: {
  economics: Economics;
  plans: PlanEconomics;
  retention: Retention;
  lookback: Lookback;
  onLookback: (l: Lookback) => void;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const { meta, google, blended } = e.channels;
  const base = useMemo(
    () => withPaidVisits(e.base, { meta: meta.costPerVisit, google: google.costPerVisit }),
    [e, meta, google],
  );
  const defaults = useMemo<ProjectionInputs>(
    () => ({
      ...defaultInputs(base, plans),
      metaPaidConversion: meta.rate,
      googlePaidConversion: google.rate,
    }),
    [base, plans, meta, google],
  );
  const [inputs, setInputs] = useState<ProjectionInputs>(defaults);
  useEffect(() => setInputs(defaults), [defaults]);

  // Ad visitor → paying = (ad visitors who start a trial) × (trials that pay).
  // The two sliders start at today's values and scale every channel's rate.
  const realConv = useMemo(() => {
    const paying = e.trialToPaying;
    const trial = paying > 0 && blended.rate !== null ? blended.rate / paying : 0;
    return { trial, paying };
  }, [e, blended]);
  const [conv, setConv] = useState(realConv);
  useEffect(() => setConv(realConv), [realConv]);
  const k =
    realConv.trial > 0 && realConv.paying > 0
      ? (conv.trial / realConv.trial) * (conv.paying / realConv.paying)
      : 1;
  const rateOf = (r: number | null) => (r === null ? null : r * k);
  const rates = {
    meta: rateOf(meta.rate),
    google: rateOf(google.rate),
    blended: rateOf(blended.rate),
  };

  const value = e.value[12];
  const per100 = {
    all: returnPer100(blended.costPerVisit, rates.blended, value),
    meta: returnPer100(meta.costPerVisit, rates.meta, value),
    google: returnPer100(google.costPerVisit, rates.google, value),
  };
  // "Today" keeps the real rates, so changing a rate moves the projection.
  const o = outlook(
    base,
    { ...inputs, metaPaidConversion: rates.meta, googlePaidConversion: rates.google },
    retention,
    defaults,
  );
  const last = o.months[o.months.length - 1];
  const changed =
    inputs.metaSpend !== base.metaSpend ||
    inputs.googleSpend !== base.googleSpend ||
    conv.trial !== realConv.trial ||
    conv.paying !== realConv.paying;
  const reset = () => {
    setInputs(defaults);
    setConv(realConv);
  };

  const how = [
    formatMessage(messages.roiPayoffHowVisits, {
      period:
        lookback === LAST_30_DAYS
          ? formatMessage(messages.roiTheLast30Days)
          : formatMessage(messages.roiTheLastNMonths, { n: lookback }),
      meta: money(meta.costPerVisit),
      google: money(google.costPerVisit),
    }),
    formatMessage(messages.roiPayoffHowConvert, {
      meta: oneIn(meta.rate),
      google: oneIn(google.rate),
      taps: Math.round(1 / (e.tapToSignup.value || DEFAULT_TAP_TO_SIGNUP)),
      paying: Math.round(e.trialToPaying * 100),
    }),
    formatMessage(messages.roiPayoffHowValue, {
      value: usd(value),
      yearly: Math.round(e.model.yearlyShare * 100),
      m12: Math.round((retention.monthly[11] ?? 0) * 100),
    }),
    formatMessage(messages.roiPayoffHowToday, { n: e.adMonths }),
  ];

  return (
    <Panel title={formatMessage(labels.roiPayoffTitle)}>
      <Column gap="5">
        <Row gap="2" alignItems="center" wrap="wrap">
          {LOOKBACK_CHOICES.map(l => (
            <Button
              key={l}
              size="sm"
              variant={l === lookback ? 'primary' : 'outline'}
              onPress={() => onLookback(l)}
            >
              {l === LAST_30_DAYS
                ? formatMessage(labels.roiLast30Days)
                : formatMessage(labels.roiLast3Months)}
            </Button>
          ))}
          <InfoTip content={how}>{formatMessage(labels.howCalculated)}</InfoTip>
        </Row>

        {per100.all === null ? (
          <Text size="5">{formatMessage(messages.roiPayoffNoData)}</Text>
        ) : (
          <Column gap="1">
            <Text
              size="9"
              weight="bold"
              style={{
                lineHeight: 1,
                color: per100.all >= 100 ? ROI_COLORS.positive : ROI_COLORS.negative,
              }}
            >
              {usd(per100.all)}
            </Text>
            <Text size="5" weight="bold">
              {formatMessage(messages.roiPayoffAnswer, { amount: usd(per100.all) })}
            </Text>
            <Text color="muted" size="3">
              {formatMessage(messages.roiPayoffPerChannel, {
                meta: per100.meta === null ? '—' : usd(per100.meta),
                google: per100.google === null ? '—' : usd(per100.google),
              })}
            </Text>
          </Column>
        )}

        {blended.breakEven[12] !== null && (
          <Grid
            columns="minmax(80px,1fr) minmax(120px,1.2fr) minmax(120px,1.2fr) minmax(90px,1fr)"
            gap="3"
            alignItems="center"
          >
            <Text color="muted" size="2" />
            <Text color="muted" size="2" align="right">
              {formatMessage(labels.roiAdVisitorsWhoPay)}
            </Text>
            <Text color="muted" size="2" align="right">
              {formatMessage(labels.roiNeededToBreakEven)}
            </Text>
            <Text color="muted" size="2" align="right" />
            {(
              [
                ['meta', labels.roiMeta],
                ['google', labels.roiGoogle],
                ['blended', labels.roiAllAds],
              ] as const
            ).map(([key, label]) => {
              const c = e.channels[key];
              const rate = rates[key];
              const need = c.breakEven[12];
              const above = rate !== null && need !== null && rate >= need;
              return (
                <Fragment key={key}>
                  <Text weight="bold">{formatMessage(label)}</Text>
                  <Column alignItems="end">
                    <Text size="4" weight="bold">
                      {pct(rate)}
                    </Text>
                    <Text color="muted" size="1">
                      {formatMessage(messages.roiOneIn, { n: oneIn(rate) })}
                    </Text>
                  </Column>
                  <Column alignItems="end">
                    <Text size="4">{pct(need)}</Text>
                    <Text color="muted" size="1">
                      {formatMessage(messages.roiOneIn, { n: oneIn(need) })}
                    </Text>
                  </Column>
                  <Text
                    align="right"
                    weight="bold"
                    style={{
                      color:
                        rate === null || need === null
                          ? undefined
                          : above
                            ? ROI_COLORS.positive
                            : ROI_COLORS.negative,
                    }}
                  >
                    {rate === null || need === null
                      ? '—'
                      : formatMessage(above ? labels.roiAbove : labels.roiBelow)}
                  </Text>
                </Fragment>
              );
            })}
          </Grid>
        )}

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
          <RateSlider
            label={formatMessage(labels.roiAdVisitorsStartTrial)}
            value={conv.trial}
            max={Math.max(0.3, realConv.trial * 2)}
            step={0.005}
            onChange={v => setConv(c => ({ ...c, trial: v }))}
          />
          <RateSlider
            label={formatMessage(labels.roiTrialsThatPay)}
            value={conv.paying}
            max={Math.max(0.6, realConv.paying * 2)}
            step={0.01}
            onChange={v => setConv(c => ({ ...c, paying: v }))}
          />
          {changed && (
            <Row>
              <Button size="sm" variant="quiet" onPress={reset}>
                {formatMessage(labels.roiReset)}
              </Button>
            </Row>
          )}
        </Column>

        <Grid columns="repeat(auto-fit, minmax(220px, 1fr))" gap="3">
          <Card
            label={formatMessage(labels.roiNetMonth12)}
            value={usd(last.projected)}
            sub={formatMessage(messages.roiVsToday, {
              delta: signedUsd(last.projected - last.today),
            })}
            good={last.projected >= 0}
          />
          <Card
            label={formatMessage(labels.roiExtraOverYear)}
            value={signedUsd(o.extraNetIncome)}
            sub={formatMessage(messages.roiVsTodaySpend)}
            good={o.extraNetIncome >= 0}
          />
        </Grid>

        <OutlookChart
          labels={o.months.map(m => formatMessage(messages.roiMonthN, { n: m.month }))}
          today={o.months.map(m => Math.round(m.today))}
          projected={o.months.map(m => Math.round(m.projected))}
          todayLabel={formatMessage(labels.roiAtTodaySpend)}
          projectedLabel={formatMessage(messages.roiAtSpend, {
            spend: usd(inputs.metaSpend + inputs.googleSpend),
          })}
        />
      </Column>
    </Panel>
  );
}
