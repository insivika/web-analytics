import type { ReactQueryOptions } from '@/lib/types';
import { useApi } from '../useApi';
import { useModified } from '../useModified';

export interface SavedView {
  id: string;
  websiteId: string;
  name: string;
  path: string;
  query: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function useWebsiteSavedViewsQuery(websiteId: string, options?: ReactQueryOptions) {
  const { get, useQuery } = useApi();
  const { modified } = useModified('savedViews');

  return useQuery<SavedView[]>({
    queryKey: ['website:saved-views', { websiteId, modified }],
    queryFn: () => get(`/websites/${websiteId}/views`),
    enabled: !!websiteId,
    ...options,
  });
}
