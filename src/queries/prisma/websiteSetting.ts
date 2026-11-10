import { uuid } from '@/lib/crypto';
import prisma from '@/lib/prisma';

export async function getWebsiteSetting(websiteId: string, key: string) {
  return prisma.client.websiteSetting.findUnique({
    where: { websiteId_key: { websiteId, key } },
  });
}

export async function setWebsiteSetting(websiteId: string, key: string, value: any) {
  return prisma.client.websiteSetting.upsert({
    where: { websiteId_key: { websiteId, key } },
    create: { id: uuid(), websiteId, key, value },
    update: { value },
  });
}
