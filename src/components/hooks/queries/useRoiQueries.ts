import { keepPreviousData } from '@tanstack/react-query';
import { useApi } from '../useApi';
import { useModified } from '../useModified';

export function useRoiReportQuery(
  websiteId: string,
  params: { startAt: number; endAt: number; target?: number },
) {
  const { get, useQuery } = useApi();
  const { modified } = useModified('roi');

  return useQuery<any>({
    queryKey: ['website:roi', { websiteId, modified, ...params }],
    queryFn: () => get(`/websites/${websiteId}/roi`, params),
    enabled: !!websiteId,
    placeholderData: keepPreviousData,
  });
}
