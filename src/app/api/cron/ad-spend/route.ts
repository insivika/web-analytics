import { isValidScriptSecret } from '@/lib/ads/google';
import {
  getAdsWebsiteId,
  META_DAILY_LOOKBACK_DAYS,
  syncFxRates,
  syncMetaSpend,
} from '@/lib/ads/sync';
import { json, unauthorized } from '@/lib/response';

// Nightly Vercel Cron: Meta spend for the last 7 days (picks up late adjustments)
// and FX rates for revenue currencies. Vercel sends `Authorization: Bearer $CRON_SECRET`.
export const maxDuration = 60;

const REVENUE_CURRENCIES = ['AUD', 'CAD', 'GBP', 'EUR', 'NZD'];

export async function GET(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!isValidScriptSecret(token, process.env.CRON_SECRET)) {
    return unauthorized();
  }

  const websiteId = getAdsWebsiteId();
  const [meta, fx] = await Promise.all([
    syncMetaSpend(websiteId, META_DAILY_LOOKBACK_DAYS),
    syncFxRates(websiteId, REVENUE_CURRENCIES, 7),
  ]);

  return json({ meta, fx });
}
