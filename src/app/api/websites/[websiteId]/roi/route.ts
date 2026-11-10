import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { canViewWebsite } from '@/permissions';
import { getWebsiteSetting } from '@/queries/prisma';
import { getRoiReport } from '@/queries/sql';

// Last 12 calendar months of spend, visitors, trials, new customers, money in
// and net income. The page picks its period by summing months.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const trialSetting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
  const report = await getRoiReport(websiteId, {
    trialSettings: normalizeTrialSettings(trialSetting?.value as any),
  });

  return json(report);
}
