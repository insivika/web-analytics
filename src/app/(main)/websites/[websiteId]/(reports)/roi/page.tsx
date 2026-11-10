import type { Metadata } from 'next';
import { RoiPage } from './RoiPage';

export default async function ({ params }: { params: Promise<{ websiteId: string }> }) {
  const { websiteId } = await params;

  return <RoiPage websiteId={websiteId} />;
}

export const metadata: Metadata = {
  title: 'ROI',
};
