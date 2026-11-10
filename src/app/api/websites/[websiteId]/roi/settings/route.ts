import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { normalizeRoiSettings, ROI_SETTINGS_KEY } from '@/lib/roi';
import { canUpdateWebsite, canViewWebsite } from '@/permissions';
import { getWebsiteSetting, setWebsiteSetting } from '@/queries/prisma';

const schema = z
  .object({
    revenueWindows: z.array(z.coerce.number().int().min(1).max(730)).min(1).max(5),
    storeFeeRate: z.coerce.number().min(0).max(0.5),
    stripeFeeRate: z.coerce.number().min(0).max(0.2),
    stripeFeeFixedUsd: z.coerce.number().min(0).max(5),
    targetRevenueUsd: z.coerce.number().min(1).max(10_000_000),
  })
  .partial();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);
  if (error) return error();

  const { websiteId } = await params;
  if (!(await canViewWebsite(auth, websiteId))) return unauthorized();

  const setting = await getWebsiteSetting(websiteId, ROI_SETTINGS_KEY);
  return json(normalizeRoiSettings(setting?.value as any));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, schema);
  if (error) return error();

  const { websiteId } = await params;
  if (!(await canUpdateWebsite(auth, websiteId))) return unauthorized();

  const existing = await getWebsiteSetting(websiteId, ROI_SETTINGS_KEY);
  const settings = normalizeRoiSettings({ ...((existing?.value as any) ?? {}), ...body });
  await setWebsiteSetting(websiteId, ROI_SETTINGS_KEY, settings);

  return json(settings);
}
