import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { json, notFound, ok, unauthorized } from '@/lib/response';
import { savedViewPathParam, savedViewQueryParam } from '@/lib/schema';
import { canUpdateWebsite, canViewWebsite } from '@/permissions';
import { deleteSavedView, getWebsiteSavedView, updateSavedView } from '@/queries/prisma';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; viewId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, viewId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const view = await getWebsiteSavedView(websiteId, viewId);

  if (!view) {
    return notFound();
  }

  return json(view);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; viewId: string }> },
) {
  const schema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    path: savedViewPathParam.optional(),
    query: savedViewQueryParam.optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId, viewId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const view = await getWebsiteSavedView(websiteId, viewId);

  if (!view) {
    return notFound();
  }

  const { name, path, query } = body;

  const result = await updateSavedView(viewId, { name, path, query });

  return json(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; viewId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId, viewId } = await params;

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const view = await getWebsiteSavedView(websiteId, viewId);

  if (!view) {
    return notFound();
  }

  await deleteSavedView(viewId);

  return ok();
}
