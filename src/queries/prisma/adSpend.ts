import type { FxRateRow } from '@/lib/ads/fx';
import type { AdSpendRow } from '@/lib/ads/meta';
import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * Replaces one account's spend rows for [rangeStart, rangeEnd] in a transaction.
 * Platforms omit ads with no delivery, so a plain upsert would keep stale rows
 * when spend is adjusted to zero; delete-then-insert keeps the range exact.
 */
export async function replaceAdSpend(
  websiteId: string,
  channel: string,
  accountId: string,
  rangeStart: string,
  rangeEnd: string,
  rows: (AdSpendRow & { spendUsd: number | null })[],
) {
  const syncedAt = new Date();
  const { client } = prisma;

  await client.$transaction([
    client.adSpend.deleteMany({
      where: {
        websiteId,
        channel,
        accountId,
        date: { gte: toDate(rangeStart), lte: toDate(rangeEnd) },
      },
    }),
    client.adSpend.createMany({
      data: rows.map(row => ({
        id: uuid(),
        websiteId,
        date: toDate(row.date),
        channel,
        accountId,
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        adsetId: row.adsetId,
        adsetName: row.adsetName,
        adId: row.adId,
        adName: row.adName,
        spend: row.spend,
        currency: row.currency,
        spendUsd: row.spendUsd,
        impressions: row.impressions,
        clicks: row.clicks,
        syncedAt,
      })),
      skipDuplicates: true,
    }),
  ]);

  return rows.length;
}

export async function getFxRates(currencies: string[], start: string, end: string) {
  const rows = await prisma.client.fxRate.findMany({
    where: {
      currency: { in: currencies.map(c => c.toUpperCase()) },
      date: { gte: toDate(start), lte: toDate(end) },
    },
  });

  return rows.map(r => ({
    date: r.date.toISOString().slice(0, 10),
    currency: r.currency,
    usdRate: Number(r.usdRate),
    source: r.source,
  }));
}

export async function saveFxRates(rows: FxRateRow[]) {
  if (!rows.length) return 0;
  const fetchedAt = new Date();
  const result = await prisma.client.fxRate.createMany({
    data: rows.map(r => ({
      date: toDate(r.date),
      currency: r.currency.toUpperCase(),
      usdRate: r.usdRate,
      source: r.source,
      fetchedAt,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function startSyncRun(
  websiteId: string,
  source: string,
  rangeStart?: string,
  rangeEnd?: string,
) {
  return prisma.client.adSyncRun.create({
    data: {
      id: uuid(),
      websiteId,
      source,
      status: 'running',
      rangeStart: rangeStart ? toDate(rangeStart) : null,
      rangeEnd: rangeEnd ? toDate(rangeEnd) : null,
      startedAt: new Date(),
    },
  });
}

export async function finishSyncRun(
  id: string,
  result: { status: 'success' | 'error'; rows?: number; message?: string },
) {
  return prisma.client.adSyncRun.update({
    where: { id },
    data: {
      status: result.status,
      rows: result.rows ?? 0,
      message: result.message?.slice(0, 2000) ?? null,
      finishedAt: new Date(),
    },
  });
}

/** Latest run and latest successful run per source, for the data-health panel. */
export async function getSyncStatus(websiteId: string) {
  const sources = ['meta', 'google', 'stripe', 'revenuecat', 'fx'];

  return Promise.all(
    sources.map(async source => {
      const [last, lastSuccess] = await Promise.all([
        prisma.client.adSyncRun.findFirst({
          where: { websiteId, source },
          orderBy: { startedAt: 'desc' },
        }),
        prisma.client.adSyncRun.findFirst({
          where: { websiteId, source, status: 'success' },
          orderBy: { startedAt: 'desc' },
        }),
      ]);
      return { source, last, lastSuccess };
    }),
  );
}
