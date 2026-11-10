import { z } from 'zod';
import { uuid } from '@/lib/crypto';
import { parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { savedViewPathParam, savedViewQueryParam } from '@/lib/schema';
import { canUpdateWebsite, canViewWebsite } from '@/permissions';
import { createSavedView, getWebsiteSavedViews } from '@/queries/prisma';

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

  const views = await getWebsiteSavedViews(websiteId);

  return json(views);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    name: z.string().trim().min(1).max(200),
    path: savedViewPathParam,
    query: savedViewQueryParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { name, path, query } = body;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const result = await createSavedView({
    id: uuid(),
    websiteId,
    name,
    path,
    query,
    createdBy: auth.user.id,
  });

  return json(result);
}
