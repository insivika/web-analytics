import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, unauthorized } from '@/lib/response';
import { normalizeRoiSettings, ROI_SETTINGS_KEY } from '@/lib/roi';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { canViewWebsite } from '@/permissions';
import { getWebsiteSetting } from '@/queries/prisma';
import { getRoiReport } from '@/queries/sql';

const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
    target: z.coerce.number().positive().max(10_000_000).optional(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  if (query.endAt <= query.startAt || query.endAt - query.startAt > MAX_WINDOW_MS) {
    return badRequest({ message: 'Invalid period.' });
  }

  const [trialSetting, roiSetting] = await Promise.all([
    getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY),
    getWebsiteSetting(websiteId, ROI_SETTINGS_KEY),
  ]);

  const report = await getRoiReport(websiteId, {
    window: { startDate: new Date(query.startAt), endDate: new Date(query.endAt) },
    trialSettings: normalizeTrialSettings(trialSetting?.value as any),
    roiSettings: normalizeRoiSettings(roiSetting?.value as any),
    targetRevenueUsd: query.target,
  });

  return json(report);
}
