'use client';
import { Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { InfoTip } from '@/components/common/InfoTip';
import { Panel } from '@/components/common/Panel';
import { useMessages } from '@/components/hooks';
import {
  DEFAULT_TAP_TO_SIGNUP,
  type Economics,
  LAST_30_DAYS,
  type Levers,
  type Lookback,
  leverBreakEven,
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
const pctOf = (r: number) => `${(r * 100).toFixed(1)}%`;
const SPEND_MAX = 3000;
const MUTED_LINE = 'rgba(128,128,128,0.8)';
const LOOKBACK_CHOICES: Lookback[] = [LAST_30_DAYS, 3];

/** Where a value sits on a native range track (the thumb is about 16px wide). */
const trackLeft = (value: number, min: number, max: number) => {
  const p = max > min ? Math.min(Math.max((value - min) / (max - min), 0), 1) : 0;
  return `calc(${p * 100}% + ${(0.5 - p) * 16}px)`;
};
const TODAY_MARK = 'rgba(160,160,160,0.95)';

function Mark({ left, color, label }: { left: string; color: string; label: string }) {
  return (
    <>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left,
          transform: 'translateX(-50%)',
          fontSize: 10,
          lineHeight: '12px',
          color,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {label}
      </span>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 14 + 10,
          left,
          width: 2,
          height: 20,
          background: color,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      />
    </>
  );
}

/**
 * A slider with a grey "today" mark and, for the levers, a green mark where
 * that lever alone would break even (the other levers left where they are).
 */
function Slider({
  label,
  value,
  today,
  min = 0,
  max,
  step,
  color,
  format,
  todayText,
  todayMarker,
  breakEven,
  breakEvenMarker,
  breakEvenText,
  good,
  note,
  onChange,
}: {
  label: string;
  value: number;
  today: number;
  min?: number;
  max: number;
  step: number;
  color: string;
  format: (v: number) => string;
  todayText: (v: string) => ReactNode;
  todayMarker: string;
  breakEven?: number | null;
  breakEvenMarker?: string;
  breakEvenText?: (v: string) => string;
  /** True when this lever is at or past its break-even point. */
  good?: boolean;
  /** A short line under the slider explaining where today's value comes from. */
  note?: string;
  onChange: (v: number) => void;
}) {
  const differs = Math.abs(value - today) > step / 2;
  const showBreakEven =
    breakEven !== undefined && breakEven !== null && breakEven >= min && breakEven <= max;
  const close = showBreakEven && Math.abs(breakEven - today) / (max - min) < 0.08;
  return (
    <Column gap="1">
      <Row alignItems="center" gap="4" wrap="wrap">
        <Text size="3" style={{ minWidth: 180, maxWidth: 220 }}>
          {label}
        </Text>
        <div style={{ position: 'relative', flex: '1 1 240px', paddingTop: 14 }}>
          <Mark
            left={trackLeft(today, min, max)}
            color={TODAY_MARK}
            label={close ? '' : todayMarker}
          />
          {showBreakEven && (
            <Mark
              left={trackLeft(breakEven, min, max)}
              color={ROI_COLORS.positive}
              label={breakEvenMarker ?? ''}
            />
          )}
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            style={{
              position: 'relative',
              display: 'block',
              width: '100%',
              margin: 0,
              accentColor: good ? ROI_COLORS.positive : color,
            }}
          />
        </div>
        <Column alignItems="end" style={{ minWidth: 110 }}>
          <Text size="5" weight="bold" style={good ? { color: ROI_COLORS.positive } : undefined}>
            {format(value)}
          </Text>
          <Text color="muted" size="1" style={{ visibility: differs ? 'visible' : 'hidden' }}>
            {todayText(format(today))}
          </Text>
          {breakEvenText && breakEven !== undefined && (
            <Text size="1" style={{ color: ROI_COLORS.positive }}>
              {breakEven === null ? '—' : breakEvenText(format(breakEven))}
            </Text>
          )}
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

function Step({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Column
      alignItems="center"
      paddingY="3"
      paddingX="2"
      borderRadius="3"
      backgroundColor="2"
      gap="1"
    >
      <Text color="muted" size="1" align="center">
        {label}
      </Text>
      <Text size="5" weight="bold" style={color ? { color } : undefined}>
        {value}
      </Text>
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

  // The four levers: ad visitor → trial, trial → paying, cost per ad visitor,
  // and what a new customer brings in 12 months. They start at today's values.
  const value = e.value[12];
  const real = useMemo<Levers>(() => {
    const paying = e.trialToPaying;
    const trial = paying > 0 && blended.rate !== null ? blended.rate / paying : 0;
    return { trial, paying, costPerVisit: blended.costPerVisit ?? 0, value };
  }, [e, blended, value]);
  const [lv, setLv] = useState<Levers>(real);
  useEffect(() => setLv(real), [real]);
  const ready = real.costPerVisit > 0 && real.trial > 0 && real.paying > 0 && real.value > 0;

  // How much each lever moved, applied to both channels alike.
  const k = ready ? (lv.trial / real.trial) * (lv.paying / real.paying) : 1;
  const costX = ready ? lv.costPerVisit / real.costPerVisit : 1;
  const valueX = ready ? lv.value / real.value : 1;
  const scenValue = value * valueX;
  const channel = (c: typeof meta) => {
    const cost = c.costPerVisit === null ? null : c.costPerVisit * costX;
    const rate = c.rate === null ? null : c.rate * k;
    return {
      per100: returnPer100(cost, rate, scenValue),
      per: rate,
      need: cost !== null && scenValue > 0 ? cost / scenValue : null,
    };
  };
  const ch = { meta: channel(meta), google: channel(google) };

  const per = lv.trial * lv.paying;
  const need = scenValue > 0 ? lv.costPerVisit / lv.value : null;
  const per100 = ready ? returnPer100(lv.costPerVisit, per, lv.value) : null;
  const todayPer100 = ready
    ? returnPer100(real.costPerVisit, real.trial * real.paying, real.value)
    : null;
  const be = leverBreakEven(lv);
  const realBe = leverBreakEven(real);
  const todayText = (v: string) => formatMessage(messages.roiTodayValue, { value: v });
  const breakEvenText = (v: string) => formatMessage(messages.roiBreakEvenValue, { value: v });
  const leversChanged = (Object.keys(real) as (keyof Levers)[]).some(
    key => Math.abs(lv[key] - real[key]) > 1e-9,
  );

  // A cheaper visit buys more visitors per dollar, which reads as more
  // customers per dollar; "today" keeps the real rates so the graph moves.
  const o = outlook(
    base,
    {
      ...inputs,
      metaPaidConversion: meta.rate === null ? null : (meta.rate * k) / costX,
      googlePaidConversion: google.rate === null ? null : (google.rate * k) / costX,
      monthlyPrice: inputs.monthlyPrice * valueX,
      yearlyPrice: inputs.yearlyPrice * valueX,
    },
    retention,
    defaults,
  );
  const last = o.months[o.months.length - 1];
  const changed =
    inputs.metaSpend !== base.metaSpend || inputs.googleSpend !== base.googleSpend || leversChanged;
  const reset = () => {
    setInputs(defaults);
    setLv(real);
  };
  const of100 = (r: number | null) => (r === null ? '—' : (r * 100).toFixed(1));
  const marker = formatMessage(labels.roiTodayMarker);
  const beMarker = formatMessage(labels.roiBreakEvenMarker);
  const visitors = ready ? 100 / lv.costPerVisit : 0;

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

        {per100 === null ? (
          <Text size="5">{formatMessage(messages.roiPayoffNoData)}</Text>
        ) : (
          <Column gap="1">
            <Row alignItems="baseline" gap="3" wrap="wrap">
              {leversChanged && todayPer100 !== null && (
                <Text size="7" weight="bold" color="muted" style={{ lineHeight: 1 }}>
                  {usd(todayPer100)} →
                </Text>
              )}
              <Text
                size="9"
                weight="bold"
                style={{
                  lineHeight: 1,
                  color: per100 >= 100 ? ROI_COLORS.positive : ROI_COLORS.negative,
                }}
              >
                {usd(per100)}
              </Text>
            </Row>
            <Text size="5" weight="bold">
              {formatMessage(messages.roiPayoffAnswer, { amount: usd(per100) })}
            </Text>
            {need !== null && (
              <Text size="3">
                {formatMessage(per100 >= 100 ? messages.roiGapAbove : messages.roiGapBelow, {
                  per: of100(per),
                  need: of100(need),
                  x: per > 0 ? (need / per).toFixed(2) : '—',
                })}
              </Text>
            )}
            <Text color="muted" size="2">
              {formatMessage(messages.roiPayoffPerChannelGap, {
                meta: ch.meta.per100 === null ? '—' : usd(ch.meta.per100),
                metaPer: of100(ch.meta.per),
                metaNeed: of100(ch.meta.need),
                google: ch.google.per100 === null ? '—' : usd(ch.google.per100),
                googlePer: of100(ch.google.per),
                googleNeed: of100(ch.google.need),
              })}
            </Text>
          </Column>
        )}

        {ready && (
          <Grid columns="repeat(5, minmax(0, 1fr))" gap="2">
            <Step label={formatMessage(labels.roiFunnelSpend)} value="$100" />
            <Step
              label={formatMessage(labels.roiFunnelVisitors)}
              value={Math.round(visitors).toLocaleString('en-US')}
            />
            <Step
              label={formatMessage(labels.roiFunnelTrials)}
              value={(visitors * lv.trial).toFixed(1)}
            />
            <Step
              label={formatMessage(labels.roiFunnelPaying)}
              value={(visitors * per).toFixed(1)}
            />
            <Step
              label={formatMessage(labels.roiFunnelEarned)}
              value={usd(visitors * per * lv.value)}
              color={visitors * per * lv.value >= 100 ? ROI_COLORS.positive : ROI_COLORS.negative}
            />
          </Grid>
        )}

        {ready && (
          <Column gap="3">
            <Column gap="1">
              <Text size="4" weight="bold">
                {formatMessage(labels.roiWhatItTakes)}
              </Text>
              <Text color="muted" size="2">
                {formatMessage(messages.roiLeverLegend)}
              </Text>
            </Column>
            <Slider
              label={formatMessage(labels.roiAdVisitorsStartTrial)}
              value={lv.trial}
              today={real.trial}
              max={Math.min(1, Math.max(0.2, real.trial * 2, (realBe.trial ?? 0) * 1.3))}
              step={0.001}
              color={ROI_COLORS.stripe}
              format={pctOf}
              todayText={todayText}
              todayMarker={marker}
              breakEven={be.trial}
              breakEvenMarker={beMarker}
              breakEvenText={breakEvenText}
              good={be.trial !== null && lv.trial >= be.trial - 1e-9}
              note={formatMessage(messages.roiTrialSplit, {
                web: pctOf(blended.estimated.webSignupRate),
                app: pctOf(blended.estimated.tapRate * blended.estimated.tapToSignup),
                taps: pctOf(blended.estimated.tapRate),
                n: Math.round(1 / (blended.estimated.tapToSignup || DEFAULT_TAP_TO_SIGNUP)),
              })}
              onChange={v => setLv(l => ({ ...l, trial: v }))}
            />
            <Slider
              label={formatMessage(labels.roiTrialsThatPay)}
              value={lv.paying}
              today={real.paying}
              max={Math.min(1, Math.max(0.5, real.paying * 2, (realBe.paying ?? 0) * 1.3))}
              step={0.005}
              color={ROI_COLORS.stripe}
              format={pctOf}
              todayText={todayText}
              todayMarker={marker}
              breakEven={be.paying}
              breakEvenMarker={beMarker}
              breakEvenText={breakEvenText}
              good={be.paying !== null && lv.paying >= be.paying - 1e-9}
              note={
                e.trialCohort
                  ? formatMessage(messages.roiPayingSplit, {
                      paid: e.trialCohort.paid,
                      trials: e.trialCohort.trials,
                      days: PAID_WITHIN_DAYS,
                    })
                  : undefined
              }
              onChange={v => setLv(l => ({ ...l, paying: v }))}
            />
            <Slider
              label={formatMessage(labels.roiCostPerAdVisitor)}
              value={lv.costPerVisit}
              today={real.costPerVisit}
              min={0.01}
              max={Math.max(1, real.costPerVisit * 2)}
              step={0.01}
              color={ROI_COLORS.stripe}
              format={v => `$${v.toFixed(2)}`}
              todayText={todayText}
              todayMarker={marker}
              breakEven={be.costPerVisit}
              breakEvenMarker={beMarker}
              breakEvenText={breakEvenText}
              good={be.costPerVisit !== null && lv.costPerVisit <= be.costPerVisit + 1e-9}
              onChange={v => setLv(l => ({ ...l, costPerVisit: v }))}
            />
            <Slider
              label={formatMessage(labels.roiCustomerValue12)}
              value={lv.value}
              today={real.value}
              max={Math.max(100, Math.ceil(real.value * 2), Math.ceil((realBe.value ?? 0) * 1.3))}
              step={1}
              color={ROI_COLORS.stripe}
              format={usd}
              todayText={todayText}
              todayMarker={marker}
              breakEven={be.value}
              breakEvenMarker={beMarker}
              breakEvenText={breakEvenText}
              good={be.value !== null && lv.value >= be.value - 1e-9}
              onChange={v => setLv(l => ({ ...l, value: v }))}
            />
          </Column>
        )}

        <Column gap="3">
          <Column gap="1">
            <Text size="4" weight="bold">
              {formatMessage(labels.roiHowMuchToSpend)}
            </Text>
            <Text color="muted" size="2">
              {formatMessage(messages.roiSpendNote)}
            </Text>
          </Column>
          <Slider
            label={formatMessage(labels.roiMetaPerMonth)}
            value={inputs.metaSpend}
            today={base.metaSpend}
            max={SPEND_MAX}
            step={25}
            color={ROI_COLORS.meta}
            format={usd}
            todayText={todayText}
            todayMarker={marker}
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
            todayMarker={marker}
            onChange={v => setInputs(i => ({ ...i, googleSpend: v }))}
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
