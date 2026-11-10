import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { timezoneParam } from '@/lib/schema';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { canViewWebsite } from '@/permissions';
import { getWebsiteSetting } from '@/queries/prisma';
import { getTrialReport } from '@/queries/sql';

const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    platform: z.enum(['all', 'ios', 'android', 'web']).default('all'),
    // Empty means "use the website's default" from the trial settings.
    internal: z.enum(['include', 'exclude', '']).optional(),
    timezone: timezoneParam.optional(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const { startAt, endAt, platform, internal, timezone } = query;

  if (endAt <= startAt || endAt - startAt > MAX_WINDOW_MS) {
    return badRequest({ message: 'Invalid signup window.' });
  }

  const setting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
  const settings = normalizeTrialSettings(setting?.value as any);

  const report = await getTrialReport(websiteId, {
    window: { startDate: new Date(startAt), endDate: new Date(endAt) },
    settings,
    filters: {
      platform,
      excludeInternal: internal ? internal === 'exclude' : settings.excludeInternal,
    },
    timezone,
  });

  return json(report);
}
