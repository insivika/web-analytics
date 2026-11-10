import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { canViewWebsite } from '@/permissions';
import { getWebsiteSetting } from '@/queries/prisma';
import { getTrialUserEvents } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; userId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId, userId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const setting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
  const { userIdProperty } = normalizeTrialSettings(setting?.value as any);

  // Include a day before the trial start so pre-start events (signup, onboarding) show up.
  const events = await getTrialUserEvents(websiteId, decodeURIComponent(userId), {
    userIdProperty,
    startDate: new Date(query.startAt - 24 * 60 * 60 * 1000),
  });

  return json(events);
}
