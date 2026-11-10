import { z } from 'zod';
import { getAdsWebsiteId, MAX_BACKFILL_DAYS, syncFxRates, syncMetaSpend } from '@/lib/ads/sync';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { MAX_REVENUE_BACKFILL_DAYS, syncStripeRevenue } from '@/lib/revenue/sync';
import { canUpdateWebsite } from '@/permissions';

// "Sync now" / backfill from the ROI page. 60s keeps each request within Vercel
// Hobby limits; Meta backfills run as 30-day chunks.
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    source: z.enum(['meta', 'fx', 'stripe']).default('meta'),
    days: z.coerce.number().int().min(1).max(MAX_REVENUE_BACKFILL_DAYS).default(7),
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

  switch (body.source) {
    case 'meta':
      return json(
        await syncMetaSpend(websiteId, Math.min(body.days, MAX_BACKFILL_DAYS), body.offsetDays),
      );
    case 'fx':
      return json(
        await syncFxRates(
          websiteId,
          ['AUD', 'CAD', 'GBP', 'EUR', 'NZD'],
          Math.min(body.days, MAX_BACKFILL_DAYS),
        ),
      );
    case 'stripe':
      return json(await syncStripeRevenue(websiteId, body.days));
  }
}
