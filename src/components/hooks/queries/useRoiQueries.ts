import { useApi } from '../useApi';
import { useModified } from '../useModified';

export function useRoiReportQuery(websiteId: string) {
  const { get, useQuery } = useApi();
  const { modified } = useModified('roi');

  return useQuery<any>({
    queryKey: ['website:roi', { websiteId, modified }],
    queryFn: () => get(`/websites/${websiteId}/roi`),
    enabled: !!websiteId,
  });
}
