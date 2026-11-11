'use client';
import { Box, Button, Column, Grid, Row, Text } from '@umami/react-zen';
import { Fragment } from 'react';
import { InfoTip } from '@/components/common/InfoTip';
import { Panel } from '@/components/common/Panel';
import { useMessages } from '@/components/hooks';
import {
  type BreakEvenSettings,
  breakEvenAtCost,
  type ChannelData,
  type ChannelEconomics,
  type ChannelKey,
  type Economics,
  MATURE_DAYS,
  MIN_AD_RETENTION_CUSTOMERS,
  MIN_MEASURED_PAYERS,
  PAYBACK_WINDOWS,
  type PaybackWindow,
  type Status,
  sensitivity,
  TRIAL_TO_PAYING_MONTHS,
  valueWithYearlyShare,
} from '@/lib/roiBreakEven';
import { PROJECTION_WINDOWS, type ProjectionWindow, type Retention } from '@/lib/roiProjection';
import { ROI_COLORS, SensitivityChart } from './RoiCharts';

const pct = (r: number | null | undefined, d = 1) =>
  r === null || r === undefined ? '—' : `${(r * 100).toFixed(d)}%`;
const oneIn = (r: number | null) => (r && r > 0 ? Math.round(1 / r).toLocaleString('en-US') : '—');
const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
const usd = (n: number | null) =>
  n === null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const roas = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}×`);

const STATUS_COLOR: Record<Status, string | undefined> = {
  profitable: ROI_COLORS.positive,
  notYet: ROI_COLORS.negative,
  notEnoughData: undefined,
};

function NumberSetting({
  label,
  value,
  placeholder,
  suffix,
  onChange,
  tip,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  suffix?: string;
  onChange: (v: number | null) => void;
  tip?: string;
}) {
  return (
    <Row alignItems="center" gap="2">
      <Text size="2" color="muted">
        {label}
      </Text>
      {tip && <InfoTip content={tip} />}
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        aria-label={label}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
        style={{
          width: 80,
          padding: '4px 8px',
          borderRadius: 6,
          border: '1px solid var(--border-color, rgba(128,128,128,0.4))',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
        }}
      />
      {suffix && (
        <Text size="2" color="muted">
          {suffix}
        </Text>
      )}
    </Row>
  );
}

/**
 * Break-even for ad spend: the share of ad visitors who must become paying
 * customers for the ads to pay for themselves, per channel and blended, and
 * where each channel stands today (measured once enough paying customers are
 * traced to a paid click, estimated from the paid funnel until then).
 */
export function RoiBreakEven({
  economics: e,
  channels,
  retention,
  lookback,
  onLookback,
  payback,
  onPayback,
  settings,
  onSettings,
}: {
  economics: Economics;
  channels: ChannelData;
  retention: Retention;
  lookback: ProjectionWindow;
  onLookback: (w: ProjectionWindow) => void;
  payback: PaybackWindow;
  onPayback: (w: PaybackWindow) => void;
  settings: BreakEvenSettings;
  onSettings: (s: BreakEvenSettings) => void;
}) {
  const { formatMessage, labels, messages } = useMessages();
  const names: Record<ChannelKey, string> = {
    meta: formatMessage(labels.roiMeta),
    google: formatMessage(labels.roiGoogle),
    blended: formatMessage(labels.roiBlended),
  };
  const statusName: Record<Status, string> = {
    profitable: formatMessage(labels.roiProfitable),
    notYet: formatMessage(labels.roiNotYet),
    notEnoughData: formatMessage(labels.roiNotEnoughData),
  };
  const windowName = formatMessage(messages.roiMonthsN, { n: payback });
  const blended = e.channels.blended;
  const sourceName = (c: ChannelEconomics) =>
    formatMessage(c.rateSource === 'measured' ? labels.roiMeasured : labels.roiEstimated);
  const costsNote =
    settings.otherCostPerCustomerMonth > 0
      ? formatMessage(messages.roiBeCostsIncluded, {
          amount: money(settings.otherCostPerCustomerMonth),
        })
      : formatMessage(messages.roiBeCostsExcluded);

  const estimateTip = (c: ChannelEconomics) => [
    formatMessage(messages.roiBeEstimateHow),
    formatMessage(messages.roiBeEstimateWeb, { rate: pct(c.estimated.webSignupRate) }),
    formatMessage(messages.roiBeEstimateTaps, {
      rate: pct(c.estimated.tapRate),
      tapToSignup: pct(c.estimated.tapToSignup, 0),
      assumed: e.tapToSignup.assumed ? 'yes' : 'no',
      ceiling: pct(e.tapToSignup.observedCeiling, 0),
    }),
    formatMessage(messages.roiBeEstimatePaying, {
      rate: pct(c.estimated.trialToPaying),
      months: Math.max(lookback, TRIAL_TO_PAYING_MONTHS),
    }),
  ];
  const measuredTip = (c: ChannelEconomics) =>
    formatMessage(messages.roiBeMeasuredHow, {
      payers: c.measured.payers,
      visits: c.measured.matureVisits.toLocaleString('en-US'),
      days: MATURE_DAYS,
      min: MIN_MEASURED_PAYERS,
    });

  const v12 = e.value[12];
  const chartPoints = sensitivity(blended.costPerVisit, v12);

  // What would move the bar, for the chosen payback window.
  const notes: string[] = [];
  for (const key of ['meta', 'google'] as const) {
    const c = e.channels[key];
    if (c.costPerVisit === null) continue;
    const cheaper = Math.round(c.costPerVisit * 0.75 * 100) / 100;
    notes.push(
      formatMessage(messages.roiBeMoveCost, {
        channel: names[key],
        cost: money(cheaper),
        rate: pct(breakEvenAtCost(cheaper, e.value[payback])),
        now: pct(c.breakEven[payback]),
      }),
    );
  }
  if (blended.costPerVisit !== null) {
    const share = e.model.yearlyShare;
    const target = share < 0.4 ? 0.4 : Math.min(share + 0.1, 1);
    const v = valueWithYearlyShare(e.model, target, payback);
    notes.push(
      formatMessage(messages.roiBeMoveYearly, {
        from: Math.round(share * 100),
        to: Math.round(target * 100),
        rate: pct(breakEvenAtCost(blended.costPerVisit, v)),
        now: pct(blended.breakEven[payback]),
      }),
    );
  }

  const adRetention: Retention | null = channels.adRetention;

  return (
    <Panel title={formatMessage(labels.roiBreakEvenTitle)}>
      <Column gap="5">
        <Row gap="2" alignItems="center" wrap="wrap">
          <Text color="muted" size="2">
            {formatMessage(labels.roiPaybackWithin)}
          </Text>
          {PAYBACK_WINDOWS.map(w => (
            <Button
              key={w}
              size="sm"
              variant={w === payback ? 'primary' : 'outline'}
              onPress={() => onPayback(w)}
            >
              {formatMessage(messages.roiMonthsN, { n: w })}
            </Button>
          ))}
          <Text color="muted" size="2" style={{ marginLeft: 12 }}>
            {formatMessage(labels.roiBasedOn)}
          </Text>
          {PROJECTION_WINDOWS.map(w => (
            <Button
              key={w}
              size="sm"
              variant={w === lookback ? 'primary' : 'outline'}
              onPress={() => onLookback(w)}
            >
              {formatMessage(messages.roiMonthsN, { n: w })}
            </Button>
          ))}
        </Row>

        <Text size="5" weight="bold">
          {blended.breakEven[payback] === null
            ? formatMessage(messages.roiBeNoSpend)
            : formatMessage(messages.roiBeHeadline, {
                window: windowName,
                need: pct(blended.breakEven[payback]),
                have: pct(blended.rate),
                source: sourceName(blended).toLowerCase(),
              })}
        </Text>

        <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
          <Grid
            columns="minmax(90px,0.8fr) repeat(8, minmax(96px,1fr))"
            gap="3"
            alignItems="start"
            style={{ minWidth: 960 }}
          >
            {[
              labels.roiBeChannel,
              labels.roiBeCostPerVisit,
              labels.roiBeNeeded1,
              labels.roiBeNeeded12,
              labels.roiBeCurrent,
              labels.roiBeMaxCac,
              labels.roiBeActualCac,
              labels.roiBeRoas12,
              labels.roiBeStatus,
            ].map((l, i) => (
              <Text key={l.id} color="muted" size="2" align={i === 0 ? 'left' : 'right'}>
                {formatMessage(l)}
              </Text>
            ))}
            {(['meta', 'google', 'blended'] as const).map(key => {
              const c = e.channels[key];
              const greyEstimate = c.rateSource === 'measured';
              const need = c.breakEven[payback];
              return (
                <Fragment key={key}>
                  <Text weight="bold">{names[key]}</Text>
                  <Column alignItems="end" gap="1">
                    <Text>{money(c.costPerVisit)}</Text>
                    <Text size="1" color="muted">
                      {formatMessage(messages.roiBeVisits, {
                        n: c.visits.toLocaleString('en-US'),
                      })}
                    </Text>
                  </Column>
                  <Column alignItems="end" gap="1">
                    <Text>{pct(c.breakEven[1])}</Text>
                    <Text size="1" color="muted">
                      {formatMessage(messages.roiOneIn, { n: oneIn(c.breakEven[1]) })}
                    </Text>
                  </Column>
                  <Column alignItems="end" gap="1">
                    <Text>{pct(c.breakEven[12])}</Text>
                    <Text size="1" color="muted">
                      {formatMessage(messages.roiOneIn, { n: oneIn(c.breakEven[12]) })}
                    </Text>
                  </Column>
                  <Column alignItems="end" gap="1">
                    <Row gap="1" alignItems="center">
                      <Text weight={c.rateSource === 'measured' ? 'bold' : undefined}>
                        {pct(c.measured.rate)}
                      </Text>
                      <InfoTip content={measuredTip(c)}>
                        {formatMessage(messages.roiBeMeasuredN, { n: c.measured.payers })}
                      </InfoTip>
                    </Row>
                    <Row gap="1" alignItems="center" style={{ opacity: greyEstimate ? 0.45 : 1 }}>
                      <Text weight={c.rateSource === 'estimated' ? 'bold' : undefined}>
                        {pct(c.estimated.rate)}
                      </Text>
                      <InfoTip content={estimateTip(c)}>
                        {formatMessage(labels.roiEstimatedShort)}
                      </InfoTip>
                    </Row>
                    {c.measured.immature && (
                      <Text size="1" color="muted">
                        {formatMessage(messages.roiBeImmature, { days: MATURE_DAYS })}
                      </Text>
                    )}
                  </Column>
                  <Text align="right">{usd(c.maxCac[12])}</Text>
                  <Text align="right">
                    {c.actualCac === null
                      ? formatMessage(labels.roiNoneTracedYet)
                      : usd(c.actualCac)}
                  </Text>
                  <Text align="right">{roas(c.roas[12])}</Text>
                  <Column alignItems="end" gap="1">
                    <Text weight="bold" style={{ color: STATUS_COLOR[c.status[payback]] }}>
                      {statusName[c.status[payback]]}
                    </Text>
                    {c.status[payback] !== 'notEnoughData' && (
                      <Text size="1" color="muted" align="right">
                        {formatMessage(messages.roiBeMargin, {
                          need: pct(need),
                          have: pct(c.rate),
                        })}
                      </Text>
                    )}
                  </Column>
                </Fragment>
              );
            })}
          </Grid>
        </Box>

        <Column gap="2">
          <Text size="3" weight="bold">
            {formatMessage(labels.roiBeChartTitle)}
          </Text>
          <SensitivityChart
            points={chartPoints}
            breakEven={blended.breakEven[12]}
            current={blended.rate}
            breakEvenLabel={formatMessage(labels.roiBreakEven)}
            currentLabel={formatMessage(labels.roiYouAreHere)}
            seriesLabel={formatMessage(labels.roiBeChartSeries)}
          />
          <Text color="muted" size="1">
            {formatMessage(messages.roiBeChartNote, { value: usd(v12) })}
          </Text>
        </Column>

        {notes.length > 0 && (
          <Column gap="1">
            <Text size="3" weight="bold">
              {formatMessage(labels.roiBeMoveTitle)}
            </Text>
            {notes.map(n => (
              <Text key={n} size="2">
                • {n}
              </Text>
            ))}
          </Column>
        )}

        <Row gap="5" wrap="wrap" alignItems="center">
          <NumberSetting
            label={formatMessage(labels.roiOtherCostsPerCustomer)}
            value={settings.otherCostPerCustomerMonth || null}
            placeholder="0"
            suffix={formatMessage(labels.roiPerMonthShort)}
            tip={formatMessage(messages.roiOtherCostsTip)}
            onChange={v => onSettings({ ...settings, otherCostPerCustomerMonth: v ?? 0 })}
          />
          <NumberSetting
            label={formatMessage(labels.roiFixedCosts)}
            value={settings.fixedMonthlyCosts || null}
            placeholder="0"
            suffix={formatMessage(labels.roiPerMonthShort)}
            tip={formatMessage(messages.roiFixedCostsTip)}
            onChange={v => onSettings({ ...settings, fixedMonthlyCosts: v ?? 0 })}
          />
          <NumberSetting
            label={formatMessage(labels.roiTapToSignup)}
            value={settings.tapToSignup === null ? null : Math.round(settings.tapToSignup * 100)}
            placeholder={String(Math.round(e.tapToSignup.value * 100))}
            suffix="%"
            tip={formatMessage(messages.roiTapToSignupTip, {
              ceiling: pct(e.tapToSignup.observedCeiling, 0),
            })}
            onChange={v =>
              onSettings({ ...settings, tapToSignup: v === null ? null : Math.min(v, 100) / 100 })
            }
          />
        </Row>

        <Column gap="1">
          {e.adMonths < 3 && (
            <Text size="2" style={{ color: ROI_COLORS.google }}>
              {formatMessage(messages.roiBeFewMonths, { n: e.adMonths })}
            </Text>
          )}
          <Text color="muted" size="1">
            {formatMessage(messages.roiBeValueHow, {
              v1: usd(e.value[1]),
              v12: usd(v12),
              yearly: Math.round(e.model.yearlyShare * 100),
              yearlyNet: money(e.model.yearlyNet),
              monthlyNet: money(e.model.monthlyNet),
              m6: Math.round((retention.monthly[5] ?? 0) * 100),
              m12: Math.round((retention.monthly[11] ?? 0) * 100),
              n: retention.monthlySample ?? 0,
              renewal:
                retention.yearlyRenewal === null ? '—' : Math.round(retention.yearlyRenewal * 100),
            })}{' '}
            {adRetention
              ? formatMessage(messages.roiBeAdRetention, {
                  n: channels.adCustomersThreeMonths,
                  m6: Math.round((adRetention.monthly[5] ?? 0) * 100),
                  m12: Math.round((adRetention.monthly[11] ?? 0) * 100),
                })
              : formatMessage(messages.roiBeAdRetentionPending, {
                  n: channels.adCustomers,
                  three: channels.adCustomersThreeMonths,
                  min: MIN_AD_RETENTION_CUSTOMERS,
                })}{' '}
            {costsNote}
          </Text>
          <Text color="muted" size="1">
            {formatMessage(messages.roiBePaidVisitsHow)}
          </Text>
        </Column>
      </Column>
    </Panel>
  );
}
