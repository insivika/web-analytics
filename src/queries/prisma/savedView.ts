import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';

export async function getWebsiteSavedViews(websiteId: string) {
  return prisma.client.savedView.findMany({
    where: { websiteId },
    orderBy: { name: 'asc' },
  });
}

export async function getWebsiteSavedView(websiteId: string, savedViewId: string) {
  return prisma.client.savedView.findFirst({
    where: { id: savedViewId, websiteId },
  });
}

export async function createSavedView(data: Prisma.SavedViewUncheckedCreateInput) {
  return prisma.client.savedView.create({ data });
}

export async function updateSavedView(savedViewId: string, data: Prisma.SavedViewUpdateInput) {
  return prisma.client.savedView.update({ where: { id: savedViewId }, data });
}

export async function deleteSavedView(savedViewId: string) {
  return prisma.client.savedView.delete({ where: { id: savedViewId } });
}
