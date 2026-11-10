import { isValidScriptSecret } from '@/lib/ads/google';
import {
  getAdsWebsiteId,
  META_DAILY_LOOKBACK_DAYS,
  syncFxRates,
  syncMetaSpend,
} from '@/lib/ads/sync';
import { json, unauthorized } from '@/lib/response';
import { RC_CHUNK_SIZE, syncRevenueCatRevenue, syncStripeRevenue } from '@/lib/revenue/sync';
import { loadUserMap } from '@/lib/revenue/userMap';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { getWebsiteSetting } from '@/queries/prisma';
import { getTrialStarterIds } from '@/queries/sql/reports/getRoi';

// Nightly Vercel Cron: Meta spend for the last 7 days (picks up late adjustments),
// FX rates, Stripe money movements for the last 14 days, and RevenueCat revenue
// for the newest trial starters. Vercel sends `Authorization: Bearer $CRON_SECRET`.
export const maxDuration = 60;

const FX_CURRENCIES = ['AUD', 'CAD', 'GBP', 'EUR', 'NZD'];

async function syncRevenue(websiteId: string) {
  try {
    const map = await loadUserMap();
    const setting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
    const userIds = await getTrialStarterIds(
      websiteId,
      normalizeTrialSettings(setting?.value as any),
    );
    // Newest trial starters first (that's where conversions and renewals happen);
    // older ones rotate through one chunk per night.
    const day = Math.floor(Date.now() / 86_400_000);
    const olderChunks = Math.max(Math.ceil((userIds.length - RC_CHUNK_SIZE) / RC_CHUNK_SIZE), 0);
    const olderOffset = olderChunks ? RC_CHUNK_SIZE * (1 + (day % olderChunks)) : null;

    const [stripe, revenuecat] = await Promise.all([
      syncStripeRevenue(websiteId, undefined, map),
      syncRevenueCatRevenue(websiteId, userIds, 0, map),
    ]);
    const older =
      olderOffset === null
        ? null
        : await syncRevenueCatRevenue(websiteId, userIds, olderOffset, map);
    return { stripe, revenuecat, older };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

export async function GET(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!isValidScriptSecret(token, process.env.CRON_SECRET)) {
    return unauthorized();
  }

  const websiteId = getAdsWebsiteId();
  const [meta, fx, revenue] = await Promise.all([
    syncMetaSpend(websiteId, META_DAILY_LOOKBACK_DAYS),
    syncFxRates(websiteId, FX_CURRENCIES, 7),
    syncRevenue(websiteId),
  ]);

  return json({ meta, fx, revenue });
}
