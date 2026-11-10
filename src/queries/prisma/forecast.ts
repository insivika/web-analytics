import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type {
  BacktestResult,
  ForecastWindow,
  TrialForecast,
  UserSnapshotLike,
} from '@/lib/trialForecast';
import { resolveOutcome } from '@/lib/trialForecast';

const dateOnly = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
const num = (v: any) => Number(v ?? 0);

/**
 * Stores today's snapshot (headline + one row per forecast user) unless one
 * exists already. The first snapshot of the day is kept: re-saving later would
 * drop users who converted in between and undercount actual conversions.
 */
export async function saveForecastSnapshot(
  websiteId: string,
  forecast: TrialForecast,
  now: Date,
): Promise<{ saved: boolean; users: number }> {
  const { client } = prisma;
  const snapshotDate = dateOnly(now);
  const { headline } = forecast;
  const clamp = (p: number) => Math.min(Math.max(p, 0), 1);

  const existing = await client.conversionForecastSnapshot.findUnique({
    where: { websiteId_snapshotDate: { websiteId, snapshotDate } },
    select: { id: true },
  });
  if (existing) return { saved: false, users: 0 };

  try {
    await client.$transaction([
      client.conversionForecastSnapshot.create({
        data: {
          id: uuid(),
          websiteId,
          snapshotDate,
          model: forecast.model.id,
          users: headline.users,
          expected7: headline.conversions7.expected,
          low7: headline.conversions7.low,
          high7: headline.conversions7.high,
          expected14: headline.conversions14.expected,
          low14: headline.conversions14.low,
          high14: headline.conversions14.high,
          revenue7: headline.revenue7.expected,
          revenue14: headline.revenue14.expected,
          backtest: (forecast.backtest ?? undefined) as any,
          createdAt: now,
        },
      }),
      client.conversionForecastUserSnapshot.createMany({
        data: forecast.rows.map(r => ({
          id: uuid(),
          websiteId,
          snapshotDate,
          userId: r.userId,
          platform: r.platform,
          trialStart: new Date(r.trialStart),
          elapsedDays: (+now - +new Date(r.trialStart)) / 86_400_000,
          segment: r.segment,
          pTotal: clamp(r.pTotal),
          p7: clamp(r.p7),
          p14: clamp(r.p14),
        })),
        skipDuplicates: true,
      }),
    ]);
  } catch (e: any) {
    // Saved concurrently (cron and "Save snapshot now" at the same time).
    if (e?.code === 'P2002') return { saved: false, users: 0 };
    throw e;
  }

  return { saved: true, users: forecast.rows.length };
}

/**
 * Records outcomes on unresolved user snapshots: converted (within the
 * window) or window closed. `conversions` maps user_id → first conversion.
 */
export async function resolveForecastOutcomes(
  websiteId: string,
  conversions: Map<string, string | null>,
  now: Date,
  window: ForecastWindow,
  /** Users converted through a paid status without a dated conversion event. */
  undated: Set<string> = new Set(),
) {
  const { client } = prisma;
  const open = await client.conversionForecastUserSnapshot.findMany({
    where: { websiteId, outcome: null },
    select: { id: true, userId: true, trialStart: true },
  });

  const updates = open
    .map(s => ({
      id: s.id,
      ...(undated.has(s.userId)
        ? { outcome: true, convertedAt: null }
        : resolveOutcome(
            s.trialStart.toISOString(),
            conversions.get(s.userId) ?? null,
            now,
            window,
          )),
    }))
    .filter(u => u.outcome !== null);

  // Group identical updates (same outcome + converted_at) into one statement.
  const groups = new Map<string, { outcome: boolean; convertedAt: string | null; ids: string[] }>();
  for (const u of updates) {
    const key = `${u.outcome}|${u.convertedAt ?? ''}`;
    const g = groups.get(key) ?? { outcome: u.outcome, convertedAt: u.convertedAt, ids: [] };
    g.ids.push(u.id);
    groups.set(key, g);
  }
  await client.$transaction(
    [...groups.values()].map(g =>
      client.conversionForecastUserSnapshot.updateMany({
        where: { id: { in: g.ids } },
        data: {
          outcome: g.outcome,
          convertedAt: g.convertedAt ? new Date(g.convertedAt) : null,
          resolvedAt: now,
        },
      }),
    ),
  );

  return updates.length;
}

/** Per-user snapshots from the last `days` days, for the accuracy line. */
export async function getForecastSnapshots(
  websiteId: string,
  now: Date,
  days = 120,
): Promise<UserSnapshotLike[]> {
  const since = dateOnly(new Date(+now - days * 86_400_000));
  const users = await prisma.client.conversionForecastUserSnapshot.findMany({
    where: { websiteId, snapshotDate: { gte: since } },
    select: {
      snapshotDate: true,
      userId: true,
      platform: true,
      trialStart: true,
      elapsedDays: true,
      pTotal: true,
      p7: true,
      outcome: true,
      convertedAt: true,
    },
  });

  return users.map(u => ({
    snapshotDate: u.snapshotDate.toISOString().slice(0, 10),
    userId: u.userId,
    platform: u.platform,
    trialStart: u.trialStart.toISOString(),
    elapsedDays: num(u.elapsedDays),
    pTotal: num(u.pTotal),
    p7: num(u.p7),
    outcome: u.outcome,
    convertedAt: u.convertedAt?.toISOString() ?? null,
  }));
}

/** The back-test stored with the most recent snapshot (computed nightly). */
export async function getLatestBacktest(websiteId: string): Promise<BacktestResult | null> {
  const row = await prisma.client.conversionForecastSnapshot.findFirst({
    where: { websiteId, NOT: { backtest: { equals: null as any } } },
    orderBy: { snapshotDate: 'desc' },
    select: { backtest: true },
  });
  return (row?.backtest as unknown as BacktestResult) ?? null;
}
