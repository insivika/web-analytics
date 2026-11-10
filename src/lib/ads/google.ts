// Google Ads spend arrives from a Google Ads Script (no Ads API developer token).
// The script posts ad-level rows plus a per-campaign remainder for campaign types
// without ad-level reporting (e.g. Performance Max) so totals match the Google UI.

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AdSpendRow } from './meta';

export const googleSpendSchema = z.object({
  customerId: z.string().trim().min(1).max(20),
  currency: z.string().trim().length(3),
  rangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mode: z.enum(['daily', 'backfill']).optional(),
  rows: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        campaignId: z.coerce.string(),
        campaignName: z.string().nullish(),
        adGroupId: z.coerce.string().nullish(),
        adGroupName: z.string().nullish(),
        adId: z.coerce.string(),
        adName: z.string().nullish(),
        costMicros: z.coerce.number().min(0),
        impressions: z.coerce.number().int().min(0),
        clicks: z.coerce.number().int().min(0),
      }),
    )
    .max(100_000),
});

export type GoogleSpendPayload = z.infer<typeof googleSpendSchema>;

/** Customer ids come as 123-456-7890 from the UI; store digits only. */
export const normalizeCustomerId = (id: string) => id.replace(/\D/g, '');

export function mapGoogleRows(payload: GoogleSpendPayload): AdSpendRow[] {
  const accountId = normalizeCustomerId(payload.customerId);
  const currency = payload.currency.toUpperCase();

  return payload.rows.map(row => ({
    date: row.date,
    channel: 'google',
    accountId,
    campaignId: row.campaignId,
    campaignName: row.campaignName ?? null,
    adsetId: row.adGroupId ?? null,
    adsetName: row.adGroupName ?? null,
    adId: row.adId,
    adName: row.adName ?? null,
    spend: Math.round(row.costMicros / 100) / 10_000, // micros → 4 decimals
    currency,
    impressions: row.impressions,
    clicks: row.clicks,
  }));
}

/** Constant-time comparison of the shared secret header. */
export function isValidScriptSecret(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
