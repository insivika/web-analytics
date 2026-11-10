import { isValidScriptSecret } from '@/lib/ads/google';
import {
  getAdsWebsiteId,
  META_DAILY_LOOKBACK_DAYS,
  syncFxRates,
  syncMetaSpend,
} from '@/lib/ads/sync';
import { json, unauthorized } from '@/lib/response';
import { syncStripeRevenue } from '@/lib/revenue/sync';

// Nightly Vercel Cron: Meta spend for the last 7 days (picks up late adjustments),
// FX rates, and Stripe money movements for the last 14 days (disputes longer).
// Google spend is pushed by the Google Ads Script; App Store and Google Play money
// is read live from RevenueCat's charts. Vercel sends `Authorization: Bearer $CRON_SECRET`.
export const maxDuration = 60;

const FX_CURRENCIES = ['AUD', 'CAD', 'GBP', 'EUR', 'NZD'];

export async function GET(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!isValidScriptSecret(token, process.env.CRON_SECRET)) {
    return unauthorized();
  }

  const websiteId = getAdsWebsiteId();
  const [meta, fx, stripe] = await Promise.all([
    syncMetaSpend(websiteId, META_DAILY_LOOKBACK_DAYS),
    syncFxRates(websiteId, FX_CURRENCIES, 7),
    syncStripeRevenue(websiteId),
  ]);

  return json({ meta, fx, stripe });
}
