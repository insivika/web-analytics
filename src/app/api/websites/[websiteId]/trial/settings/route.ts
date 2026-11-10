import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { normalizeTrialSettings, TRIAL_SETTINGS_KEY } from '@/lib/trial';
import { canUpdateWebsite, canViewWebsite } from '@/permissions';
import { getWebsiteSetting, setWebsiteSetting } from '@/queries/prisma';

const eventName = z.string().trim().min(1).max(50);
const propertyName = z.string().trim().min(1).max(500);
const list = z.array(eventName).max(50);

const trialSettingsSchema = z.object({
  trialStartEvent: eventName,
  trialLengthDays: z.coerce.number().int().min(1).max(90),
  activeDayEvent: eventName,
  activationEvent: eventName,
  milestones: z.array(z.array(eventName).min(1).max(10)).max(20),
  engagementEvents: list,
  pushEvent: eventName,
  pushAnswerProperty: propertyName,
  pushAnswerValue: z.string().trim().min(1).max(500),
  pushGrantedProperty: propertyName,
  conversionEvents: list,
  statusProperty: propertyName,
  paidStatuses: z.array(z.string().trim().min(1).max(500)).max(20),
  conversionProperty: z.string().trim().max(500),
  conversionPropertyValue: z.string().trim().max(500),
  conversionWindowDays: z.coerce.number().int().min(0).max(365),
  conversionSettleDays: z.coerce.number().int().min(0).max(60),
  excludeInternal: z.boolean(),
  internalProperty: propertyName,
  userIdProperty: propertyName,
  platformProperty: propertyName,
});

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

  const setting = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);

  return json(normalizeTrialSettings(setting?.value as any));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, trialSettingsSchema.partial());

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const existing = await getWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY);
  const settings = normalizeTrialSettings({ ...((existing?.value as any) ?? {}), ...body });

  await setWebsiteSetting(websiteId, TRIAL_SETTINGS_KEY, settings);

  return json(settings);
}
