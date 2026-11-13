import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { loadUserEmails } from '@/lib/revenue/userMap';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { canUpdateWebsite, canViewWebsite } from '@/permissions';
import { getWebsiteSetting } from '@/queries/prisma';
import { getTrialForecast, snapshotTrialForecast } from '@/queries/sql/reports/getTrialForecast';

// Projected conversions for users currently in (or just past) their trial. The
// signup-window filter doesn't apply; platform and internal filters do.
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    platform: z.enum(['all', 'ios', 'android', 'web']).default('all'),
    internal: z.enum(['include', 'exclude', '']).optional(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const setting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
  const settings = normalizeTrialSettings(setting?.value as any);

  const forecast = await getTrialForecast(websiteId, {
    platform: query.platform,
    excludeInternal: query.internal ? query.internal === 'exclude' : settings.excludeInternal,
  });

  // Emails for the trials table, so people can be recognised and contacted.
  if (forecast.available && forecast.rows.length) {
    const emails = await loadUserEmails(forecast.rows.map(r => r.userId));
    for (const row of forecast.rows) row.email = emails.get(row.userId) ?? null;
  }

  return json(forecast);
}

/** "Snapshot now": stores today's forecast and resolves outcomes (same as the cron). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  return json(await snapshotTrialForecast(websiteId));
}
