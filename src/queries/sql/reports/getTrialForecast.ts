import { normalizeTrialSettings, TRIAL_SETTINGS_KEY, type TrialSettings } from '@/lib/trial';
import {
  buildForecastUsers,
  computeForecastAccuracy,
  computeTrialForecast,
  DEFAULT_FORECAST_SETTINGS,
  getForecastSince,
  type TrialForecastReport,
} from '@/lib/trialForecast';
import { getWebsiteSetting } from '@/queries/prisma';
import {
  getForecastSnapshots,
  getLatestBacktest,
  resolveForecastOutcomes,
  saveForecastSnapshot,
} from '@/queries/prisma/forecast';
import { getRevenueTxns } from '@/queries/prisma/revenue';
import { getTrialForecastData } from './getTrial';

export type { TrialForecastReport };

async function loadSettings(websiteId: string): Promise<TrialSettings> {
  const setting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
  return normalizeTrialSettings(setting?.value as any);
}

async function buildForecast(
  websiteId: string,
  filters: { platform?: string; excludeInternal?: boolean },
  runBacktest: boolean,
) {
  const settings = await loadSettings(websiteId);
  const [data, revenueTxns] = await Promise.all([
    getTrialForecastData(websiteId, settings),
    // Revenue is optional (ROI sync); without it the value is gross list price.
    getRevenueTxns(websiteId).catch(() => []),
  ]);
  const forecastSettings = DEFAULT_FORECAST_SETTINGS;
  const users = buildForecastUsers(
    data.users,
    data.activity,
    data.plans,
    settings,
    forecastSettings.earlyDays,
    data.now,
  );
  const forecast = computeTrialForecast({
    users,
    activity: data.activity,
    trialSettings: settings,
    settings: forecastSettings,
    since: getForecastSince(data.trackingSince),
    now: data.now,
    revenueTxns,
    filters,
    runBacktest,
  });
  return { forecast, users, settings, now: data.now };
}

/** The forecast shown on the Trial page, with accuracy from stored snapshots. */
export async function getTrialForecast(
  websiteId: string,
  filters: { platform?: string; excludeInternal?: boolean },
): Promise<TrialForecastReport> {
  // The back-test doesn't depend on the filters and is costly (one refit per
  // cutoff day), so it is computed with the nightly snapshot and read back here.
  // Until the first snapshot exists it is computed live.
  const stored = await getLatestBacktest(websiteId).catch(() => null);
  const { forecast, settings, now } = await buildForecast(websiteId, filters, !stored);
  const accuracy = await getForecastSnapshots(websiteId, now)
    .then(rows =>
      computeForecastAccuracy(rows, now, settings.trialLengthDays, filters.platform ?? 'all'),
    )
    .catch(() => null); // Table missing until the migration runs.
  return { ...forecast, backtest: forecast.backtest ?? stored, accuracy };
}

/**
 * Nightly: stores today's forecast (default filters: all platforms, internal
 * excluded) and records outcomes for earlier snapshots.
 */
export async function snapshotTrialForecast(websiteId: string) {
  const { forecast, users, settings, now } = await buildForecast(
    websiteId,
    { platform: 'all', excludeInternal: true },
    true,
  );
  const window = {
    trialLengthDays: settings.trialLengthDays,
    postTrialDays: forecast.settings.postTrialDays,
  };
  const resolved = await resolveForecastOutcomes(
    websiteId,
    new Map(users.map(u => [u.userId, u.convertedAt])),
    now,
    window,
    new Set(users.filter(u => u.undatedConversion).map(u => u.userId)),
  );
  const saved = forecast.available
    ? await saveForecastSnapshot(websiteId, forecast, now)
    : { saved: false, users: 0 };
  return {
    available: forecast.available,
    saved: saved.saved,
    users: saved.users,
    resolved,
    expected7: forecast.headline.conversions7.expected,
    expected14: forecast.headline.conversions14.expected,
  };
}
