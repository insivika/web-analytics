import { addDays } from '@/lib/ads/fx';
import {
  googleSpendSchema,
  isValidScriptSecret,
  mapGoogleRows,
  normalizeCustomerId,
} from '@/lib/ads/google';
import { getAdsWebsiteId, MAX_BACKFILL_DAYS, saveGoogleSpend } from '@/lib/ads/sync';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';

// Receives daily ad-level cost from the Google Ads Script (scripts/google-ads/).
// Auth: `x-ads-secret: $GOOGLE_ADS_SCRIPT_SECRET`. No user session involved.
export const maxDuration = 60;

export async function POST(request: Request) {
  if (
    !isValidScriptSecret(request.headers.get('x-ads-secret'), process.env.GOOGLE_ADS_SCRIPT_SECRET)
  ) {
    return unauthorized();
  }

  const { body, error } = await parseRequest(request, googleSpendSchema, { skipAuth: true });

  if (error) {
    return error();
  }

  const { rangeStart, rangeEnd } = body;

  if (rangeEnd < rangeStart || addDays(rangeStart, MAX_BACKFILL_DAYS + 7) < rangeEnd) {
    return badRequest({ message: 'Invalid range.' });
  }

  if (body.rows.some(r => r.date < rangeStart || r.date > rangeEnd)) {
    return badRequest({ message: 'Rows must fall inside rangeStart..rangeEnd.' });
  }

  const result = await saveGoogleSpend(
    getAdsWebsiteId(),
    normalizeCustomerId(body.customerId),
    rangeStart,
    rangeEnd,
    mapGoogleRows(body),
  );

  const spend = body.rows.reduce((sum, r) => sum + r.costMicros, 0) / 1e6;

  return json({ ...result, spend: Math.round(spend * 100) / 100, currency: body.currency });
}
