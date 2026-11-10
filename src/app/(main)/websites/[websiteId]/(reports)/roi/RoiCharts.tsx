'use client';
import ChartJS, { type ChartConfiguration, type Plugin } from 'chart.js/auto';
import { useEffect, useRef } from 'react';

/** One color per money source, used by every card, line and table cell on the page. */
export const ROI_COLORS = {
  stripe: '#7F77DD',
  appStores: '#1D9E75',
  meta: '#378ADD',
  google: '#EF9F27',
  positive: '#2E9B5F',
  negative: '#D6453D',
};

const GRID = 'rgba(128,128,128,0.16)';
const TICK = 'rgba(128,128,128,0.9)';

const compactUsd = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1000 ? `$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `$${Math.round(a)}`;
  return v < 0 ? `−${s}` : s;
};
const fullUsd = (v: number) =>
  `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Shades the months of the selected period behind the chart. */
const periodBand = (first: number, last: number): Plugin => ({
  id: 'periodBand',
  beforeDatasetsDraw(chart) {
    const x = chart.scales.x;
    const { top, bottom } = chart.chartArea;
    if (!x || first < 0) return;
    const step = chart.data.labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 40;
    const left = Math.max(x.getPixelForValue(first) - step / 2, chart.chartArea.left);
    const right = Math.min(x.getPixelForValue(last) + step / 2, chart.chartArea.right);
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(128,128,128,0.10)';
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.restore();
  },
});

function useChart(config: () => ChartConfiguration, deps: unknown[]) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const chart = new ChartJS(canvas.current, config());
    return () => chart.destroy();
  }, deps);
  return canvas;
}

const baseOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: {
      padding: 10,
      boxPadding: 4,
      callbacks: {
        label: (c: any) => ` ${c.dataset.label}: ${fullUsd(c.parsed.y)}`,
      },
    },
  },
  scales: {
    x: { grid: { display: false }, ticks: { color: TICK } },
    y: {
      grid: { color: GRID },
      border: { display: false },
      ticks: { color: TICK, callback: (v: any) => compactUsd(Number(v)), maxTicksLimit: 6 },
    },
  },
};

export interface ChartMonth {
  label: string;
  stripe: number;
  appStores: number;
  meta: number;
  google: number;
  net: number;
}

/** Money in (solid) and ad spend (dashed), one line per source. */
export interface FlowsLabels {
  stripe: string;
  appStores: string;
  meta: string;
  google: string;
}

export function FlowsChart({
  months,
  band,
  labels,
}: {
  months: ChartMonth[];
  band: [number, number];
  labels: FlowsLabels;
}) {
  const canvas = useChart(
    () => ({
      type: 'line',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          line(
            labels.stripe,
            months.map(m => m.stripe),
            ROI_COLORS.stripe,
            false,
          ),
          line(
            labels.appStores,
            months.map(m => m.appStores),
            ROI_COLORS.appStores,
            false,
          ),
          line(
            labels.meta,
            months.map(m => m.meta),
            ROI_COLORS.meta,
            true,
          ),
          line(
            labels.google,
            months.map(m => m.google),
            ROI_COLORS.google,
            true,
          ),
        ],
      },
      options: baseOptions as any,
      plugins: [periodBand(band[0], band[1])],
    }),
    [JSON.stringify(months), band[0], band[1], JSON.stringify(labels)],
  );
  return (
    <div style={{ position: 'relative', height: 300 }}>
      <canvas ref={canvas} />
    </div>
  );
}

function line(label: string, data: number[], color: string, dashed: boolean) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: dashed ? 2 : 3,
    borderDash: dashed ? [6, 4] : [],
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.3,
  };
}

/** Net income per month: green above zero, red below. */
export function NetChart({
  months,
  band,
  label,
}: {
  months: ChartMonth[];
  band: [number, number];
  label: string;
}) {
  const canvas = useChart(
    () => ({
      type: 'bar',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          {
            label,
            data: months.map(m => m.net),
            backgroundColor: months.map((m, i) => {
              const inBand = i >= band[0] && i <= band[1];
              const base = m.net >= 0 ? ROI_COLORS.positive : ROI_COLORS.negative;
              return inBand ? base : `${base}66`;
            }),
            borderRadius: 4,
            maxBarThickness: 36,
          },
        ],
      },
      options: baseOptions as any,
    }),
    [JSON.stringify(months), band[0], band[1], label],
  );
  return (
    <div style={{ position: 'relative', height: 220 }}>
      <canvas ref={canvas} />
    </div>
  );
}

/** Next 12 months of net income: today's ad spend vs the slider spend. */
export function OutlookChart({
  labels,
  today,
  projected,
  todayLabel,
  projectedLabel,
}: {
  labels: string[];
  today: number[];
  projected: number[];
  todayLabel: string;
  projectedLabel: string;
}) {
  const better = projected[projected.length - 1] >= today[today.length - 1];
  const color = better ? ROI_COLORS.positive : ROI_COLORS.negative;
  const canvas = useChart(
    () => ({
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: projectedLabel,
            data: projected,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 3,
            pointRadius: 2,
            tension: 0.25,
          },
          {
            label: todayLabel,
            data: today,
            borderColor: 'rgba(128,128,128,0.8)',
            backgroundColor: 'rgba(128,128,128,0.8)',
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 0,
          },
        ],
      },
      options: {
        ...(baseOptions as any),
        animation: { duration: 0 },
        scales: {
          ...(baseOptions as any).scales,
          y: {
            ...(baseOptions as any).scales.y,
            suggestedMin: Math.min(0, ...projected, ...today),
          },
        },
      },
    }),
    [labels.join(), projected.join(), today.join(), todayLabel, projectedLabel],
  );
  return (
    <div style={{ position: 'relative', height: 240 }}>
      <canvas ref={canvas} />
    </div>
  );
}
