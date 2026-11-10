import type { Metadata } from 'next';
import { TrialPage } from './TrialPage';

export default async function ({ params }: { params: Promise<{ websiteId: string }> }) {
  const { websiteId } = await params;

  return <TrialPage websiteId={websiteId} />;
}

export const metadata: Metadata = {
  title: 'Trial',
};
