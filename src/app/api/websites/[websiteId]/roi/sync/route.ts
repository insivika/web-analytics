import { z } from 'zod';
import { getAdsWebsiteId, MAX_BACKFILL_DAYS, syncFxRates, syncMetaSpend } from '@/lib/ads/sync';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { canUpdateWebsite } from '@/permissions';

// "Sync now" / backfill from the ROI page. days=7 for a refresh, up to 180 for a backfill.
// 60s keeps this within Vercel Hobby limits; long backfills run as 30-day chunks.
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    source: z.enum(['meta', 'fx']).default('meta'),
    days: z.coerce.number().int().min(1).max(MAX_BACKFILL_DAYS).default(7),
    offsetDays: z.coerce.number().int().min(0).max(MAX_BACKFILL_DAYS).default(0),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  if (websiteId !== getAdsWebsiteId()) {
    return badRequest({
      message: 'Ad spend sync is only configured for the ADS_WEBSITE_ID website.',
    });
  }

  const result =
    body.source === 'meta'
      ? await syncMetaSpend(websiteId, body.days, body.offsetDays)
      : await syncFxRates(websiteId, ['AUD', 'CAD', 'GBP', 'EUR', 'NZD'], body.days);

  return json(result);
}
