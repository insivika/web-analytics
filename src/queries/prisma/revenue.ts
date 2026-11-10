import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import type { RevenueRow } from '@/lib/revenue/stripe';

export type StoredRevenueRow = RevenueRow & { userId: string | null };

/** Inserts or refreshes provider transactions (keyed by website, source, external id). */
export async function saveRevenueTxns(websiteId: string, rows: StoredRevenueRow[]) {
  if (!rows.length) return 0;
  const { client } = prisma;
  const syncedAt = new Date();
  const bySource = new Map<string, string[]>();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r.externalId);
  }

  await client.$transaction([
    ...[...bySource].map(([source, ids]) =>
      client.revenueTxn.deleteMany({ where: { websiteId, source, externalId: { in: ids } } }),
    ),
    client.revenueTxn.createMany({
      data: rows.map(r => ({
        id: uuid(),
        websiteId,
        source: r.source,
        externalId: r.externalId,
        kind: r.kind,
        userId: r.userId,
        customerRef: r.customerRef,
        occurredAt: r.occurredAt,
        currency: r.currency,
        amount: r.amount,
        grossUsd: r.grossUsd,
        feeUsd: r.feeUsd,
        netUsd: r.netUsd,
        product: r.product?.slice(0, 200) ?? null,
        refunded: r.refunded,
        syncedAt,
      })),
      skipDuplicates: true,
    }),
  ]);

  return rows.length;
}

export interface RevenueTxn {
  source: string;
  kind: string;
  userId: string | null;
  customerRef: string | null;
  occurredAt: Date;
  grossUsd: number | null;
  feeUsd: number | null;
  netUsd: number | null;
}

export async function getRevenueTxns(websiteId: string): Promise<RevenueTxn[]> {
  const rows = await prisma.client.revenueTxn.findMany({
    where: { websiteId },
    select: {
      source: true,
      kind: true,
      userId: true,
      customerRef: true,
      occurredAt: true,
      grossUsd: true,
      feeUsd: true,
      netUsd: true,
    },
  });
  const num = (v: any) => (v === null || v === undefined ? null : Number(v));
  return rows.map(r => ({
    ...r,
    grossUsd: num(r.grossUsd),
    feeUsd: num(r.feeUsd),
    netUsd: num(r.netUsd),
  }));
}
