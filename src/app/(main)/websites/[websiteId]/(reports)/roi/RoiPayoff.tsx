'use client';
import { Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { InfoTip } from '@/components/common/InfoTip';
import { Panel } from '@/components/common/Panel';
import { useMessages } from '@/components/hooks';
import {
  DEFAULT_TAP_TO_SIGNUP,
  type Economics,
  LAST_30_DAYS,
  type Lookback,
  PAID_WITHIN_DAYS,
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
const pctOf = (r: number) => `${(r * 100).toFixed(1)}%`;
const SPEND_MAX = 3000;
const MUTED_LINE = 'rgba(128,128,128,0.8)';
const LOOKBACK_CHOICES: Lookback[] = [LAST_30_DAYS, 3];

/** Where a value sits on a native range track (the thumb is about 16px wide). */
const trackLeft = (value: number, max: number) => {
  const p = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  return `calc(${p * 100}% + ${(0.5 - p) * 16}px)`;
};

/**
 * A slider with a grey "today" marker on the track, so dragging shows the gap
 * to today's value; today's value also shows under the number once they differ.
 */
function Slider({
  label,
  value,
  today,
  max,
  step,
  color,
  format,
  todayText,
  todayMarker,
  note,
  onChange,
}: {
  label: string;
  value: number;
  today: number;
  max: number;
  step: number;
  color: string;
  format: (v: number) => string;
  todayText: (v: string) => ReactNode;
  todayMarker: string;
  /** A short line under the slider explaining where today's value comes from. */
  note?: string;
  onChange: (v: number) => void;
}) {
  const differs = Math.abs(value - today) > step / 2;
  const left = trackLeft(today, max);
  return (
    <Column gap="1">
      <Row alignItems="center" gap="4" wrap="wrap">
        <Text size="3" style={{ minWidth: 180 }}>
          {label}
        </Text>
        <div style={{ position: 'relative', flex: '1 1 240px', paddingTop: 14 }}>
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              left,
              transform: 'translateX(-50%)',
              fontSize: 10,
              lineHeight: '12px',
              color: 'rgba(160,160,160,0.95)',
              whiteSpace: 'nowrap',
            }}
          >
            {todayMarker}
          </span>
          <div style={{ position: 'relative' }}>
            <input
              type="range"
              aria-label={label}
              min={0}
              max={max}
              step={step}
              value={value}
              onChange={e => onChange(Number(e.target.value))}
              style={{ display: 'block', width: '100%', margin: 0, accentColor: color }}
            />
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: '50%',
                left,
                width: 2,
                height: 20,
                borderRadius: 1,
                background: 'rgba(160,160,160,0.95)',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>
        <Column alignItems="end" style={{ minWidth: 96 }}>
          <Text size="5" weight="bold">
            {format(value)}
          </Text>
          <Text color="muted" size="1" style={{ visibility: differs ? 'visible' : 'hidden' }}>
            {todayText(format(today))}
          </Text>
        </Column>
      </Row>
      {note && (
        <Text color="muted" size="1" style={{ paddingLeft: 196 }}>
          {note}
        </Text>
      )}
    </Column>
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
  const todayPer100 = returnPer100(blended.costPerVisit, blended.rate, value);
  const todayText = (v: string) => formatMessage(messages.roiTodayValue, { value: v });
  const ratesChanged = Math.abs(k - 1) > 1e-9;
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
            <Row alignItems="baseline" gap="3" wrap="wrap">
              {ratesChanged && todayPer100 !== null && (
                <Text size="7" weight="bold" color="muted" style={{ lineHeight: 1 }}>
                  {usd(todayPer100)} →
                </Text>
              )}
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
            </Row>
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
            columns={
              ratesChanged
                ? 'minmax(80px,1fr) repeat(3, minmax(110px,1fr)) minmax(80px,0.8fr)'
                : 'minmax(80px,1fr) repeat(2, minmax(110px,1fr)) minmax(80px,0.8fr)'
            }
            gap="3"
            alignItems="center"
          >
            <Text color="muted" size="2">
              {formatMessage(labels.roiAdVisitorsWhoPay)}
            </Text>
            <Text color="muted" size="2" align="right">
              {formatMessage(labels.roiToday)}
            </Text>
            {ratesChanged && (
              <Text color="muted" size="2" align="right">
                {formatMessage(labels.roiYourScenario)}
              </Text>
            )}
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
              const cell = (r: number | null, strong: boolean, muted: boolean) => (
                <Column alignItems="end">
                  <Text
                    size="4"
                    weight={strong ? 'bold' : undefined}
                    color={muted ? 'muted' : undefined}
                  >
                    {pct(r)}
                  </Text>
                  <Text color="muted" size="1">
                    {formatMessage(messages.roiOneIn, { n: oneIn(r) })}
                  </Text>
                </Column>
              );
              return (
                <Fragment key={key}>
                  <Text weight="bold">{formatMessage(label)}</Text>
                  {cell(c.rate, !ratesChanged, ratesChanged)}
                  {ratesChanged && cell(rate, true, false)}
                  {cell(need, false, false)}
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
          <Slider
            label={formatMessage(labels.roiMetaPerMonth)}
            value={inputs.metaSpend}
            today={base.metaSpend}
            max={SPEND_MAX}
            step={25}
            color={ROI_COLORS.meta}
            format={usd}
            todayText={todayText}
            todayMarker={formatMessage(labels.roiTodayMarker)}
            onChange={v => setInputs(i => ({ ...i, metaSpend: v }))}
          />
          <Slider
            label={formatMessage(labels.roiGooglePerMonth)}
            value={inputs.googleSpend}
            today={base.googleSpend}
            max={SPEND_MAX}
            step={25}
            color={ROI_COLORS.google}
            format={usd}
            todayText={todayText}
            todayMarker={formatMessage(labels.roiTodayMarker)}
            onChange={v => setInputs(i => ({ ...i, googleSpend: v }))}
          />
          <Slider
            label={formatMessage(labels.roiAdVisitorsStartTrial)}
            value={conv.trial}
            today={realConv.trial}
            max={Math.max(0.3, realConv.trial * 2)}
            step={0.005}
            color={ROI_COLORS.stripe}
            format={pctOf}
            todayText={todayText}
            todayMarker={formatMessage(labels.roiTodayMarker)}
            note={formatMessage(messages.roiTrialSplit, {
              web: pctOf(blended.estimated.webSignupRate),
              app: pctOf(blended.estimated.tapRate * blended.estimated.tapToSignup),
              taps: pctOf(blended.estimated.tapRate),
              n: Math.round(1 / (blended.estimated.tapToSignup || DEFAULT_TAP_TO_SIGNUP)),
            })}
            onChange={v => setConv(c => ({ ...c, trial: v }))}
          />
          <Slider
            label={formatMessage(labels.roiTrialsThatPay)}
            value={conv.paying}
            today={realConv.paying}
            max={Math.max(0.6, realConv.paying * 2)}
            step={0.01}
            color={ROI_COLORS.stripe}
            format={pctOf}
            todayText={todayText}
            todayMarker={formatMessage(labels.roiTodayMarker)}
            note={
              e.trialCohort
                ? formatMessage(messages.roiPayingSplit, {
                    paid: e.trialCohort.paid,
                    trials: e.trialCohort.trials,
                    days: PAID_WITHIN_DAYS,
                  })
                : undefined
            }
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

        <Column gap="2">
          <Row gap="5" wrap="wrap">
            <Text size="2" color="muted">
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 16,
                  borderTop: `2px dashed ${MUTED_LINE}`,
                  marginRight: 8,
                  verticalAlign: 'middle',
                }}
              />
              {formatMessage(labels.roiTodayLine)}
            </Text>
            <Text size="2">
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 16,
                  borderTop: `3px solid ${
                    last.projected >= last.today ? ROI_COLORS.positive : ROI_COLORS.negative
                  }`,
                  marginRight: 8,
                  verticalAlign: 'middle',
                }}
              />
              {formatMessage(changed ? labels.roiYourScenario : labels.roiSameAsToday)}
            </Text>
          </Row>
          <OutlookChart
            labels={o.months.map(m => formatMessage(messages.roiMonthN, { n: m.month }))}
            today={o.months.map(m => Math.round(m.today))}
            projected={o.months.map(m => Math.round(m.projected))}
            todayLabel={formatMessage(labels.roiTodayLine)}
            projectedLabel={formatMessage(changed ? labels.roiYourScenario : labels.roiSameAsToday)}
          />
        </Column>
      </Column>
    </Panel>
  );
}
