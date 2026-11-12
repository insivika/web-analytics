'use client';
import { ROI_COLORS } from './RoiCharts';

const W = 720;
const H = 340;
const L = 52;
const R = 16;
const T = 16;
const B = 46;
const MUTED = 'rgba(128,128,128,0.95)';
const GRID = 'rgba(128,128,128,0.18)';
export const HERE_COLOR = '#378ADD';

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const usd = (n: number) => `$${Math.round(n)}`;

/**
 * Dollars back per $100 of ads against one conversion rate: a straight line
 * through zero, the $100 line it has to cross, the break-even rate where it
 * does, and a bar for where the business is today (a range, since part of the
 * rate is estimated).
 */
export function BreakEvenChart({
  slope,
  breakEven,
  here,
  xMax,
  xLabel,
  spentLabel,
  breakEvenLabel,
  backLabel,
}: {
  /** Dollars back per $100 for a rate of 1 (so y = slope × rate). */
  slope: number;
  breakEven: number | null;
  here: [number, number];
  xMax: number;
  xLabel: string;
  spentLabel: string;
  breakEvenLabel: (rate: string) => string;
  backLabel: (amount: string) => string;
}) {
  const hereY = here[1] * slope;
  const yMax = Math.min(Math.max(250, Math.ceil((hereY * 1.2) / 50) * 50), 500);
  const px = (v: number) => L + ((W - L - R) * Math.min(Math.max(v, 0), xMax)) / xMax;
  const py = (v: number) => T + (H - T - B) * (1 - Math.min(Math.max(v, 0), yMax) / yMax);
  const lineEnd = slope > 0 ? Math.min(xMax, yMax / slope) : xMax;
  const be = breakEven !== null && breakEven <= xMax ? breakEven : null;
  const split = be === null ? W - R : px(be);
  const yTicks = Array.from({ length: yMax / 50 + 1 }, (_, i) => i * 50);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(t => t * xMax);
  const beRight = be !== null && px(be) > W - R - 130;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={xLabel}
      style={{ display: 'block', maxWidth: 900 }}
    >
      <rect
        x={L}
        y={T}
        width={split - L}
        height={H - T - B}
        fill={ROI_COLORS.negative}
        opacity={0.1}
      />
      {be !== null && (
        <rect
          x={split}
          y={T}
          width={W - R - split}
          height={H - T - B}
          fill={ROI_COLORS.positive}
          opacity={0.12}
        />
      )}
      {yTicks.map(y => (
        <g key={y}>
          <line x1={L} x2={W - R} y1={py(y)} y2={py(y)} stroke={GRID} strokeWidth={1} />
          <text x={L - 8} y={py(y) + 4} textAnchor="end" fontSize={12} fill={MUTED}>
            {usd(y)}
          </text>
        </g>
      ))}
      {xTicks.map(x => (
        <text key={x} x={px(x)} y={H - B + 18} textAnchor="middle" fontSize={12} fill={MUTED}>
          {pct(x)}
        </text>
      ))}
      <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" fontSize={12} fill={MUTED}>
        {xLabel}
      </text>
      <line
        x1={L}
        x2={W - R}
        y1={py(100)}
        y2={py(100)}
        stroke={MUTED}
        strokeWidth={1}
        strokeDasharray="5 4"
      />
      <text x={L + 6} y={py(100) - 6} fontSize={12} fill={MUTED}>
        {spentLabel}
      </text>
      <line
        x1={px(0)}
        y1={py(0)}
        x2={px(lineEnd)}
        y2={py(lineEnd * slope)}
        stroke="currentColor"
        strokeWidth={2}
      />
      {be !== null && (
        <>
          <line
            x1={px(be)}
            x2={px(be)}
            y1={T}
            y2={H - B}
            stroke={ROI_COLORS.positive}
            strokeWidth={2}
          />
          <text
            x={px(be) + (beRight ? -6 : 6)}
            y={T + 14}
            textAnchor={beRight ? 'end' : 'start'}
            fontSize={12}
            fontWeight={600}
            fill={ROI_COLORS.positive}
          >
            {breakEvenLabel(pct(be))}
          </text>
        </>
      )}
      <line
        x1={px(here[0])}
        y1={py(here[0] * slope)}
        x2={px(here[1])}
        y2={py(here[1] * slope)}
        stroke={HERE_COLOR}
        strokeWidth={8}
        strokeLinecap="round"
      />
      {here[1] - here[0] > xMax * 0.04 && (
        <text
          x={px(here[0])}
          y={py(here[0] * slope) + 22}
          textAnchor="middle"
          fontSize={12}
          fill={HERE_COLOR}
        >
          {usd(here[0] * slope)}
        </text>
      )}
      <text
        x={px(here[1]) + 10}
        y={py(here[1] * slope) + 16}
        fontSize={12}
        fontWeight={600}
        fill={HERE_COLOR}
      >
        {backLabel(usd(hereY))}
      </text>
    </svg>
  );
}
