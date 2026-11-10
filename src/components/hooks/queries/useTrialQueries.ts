import { keepPreviousData } from '@tanstack/react-query';
import type { TrialReport, TrialSettings } from '@/lib/trial';
import { useApi } from '../useApi';
import { useModified } from '../useModified';

export function useTrialReportQuery(
  websiteId: string,
  params: { startAt: number; endAt: number; platform: string; internal: string; timezone?: string },
) {
  const { get, useQuery } = useApi();
  const { modified } = useModified('trialSettings');

  return useQuery<TrialReport>({
    queryKey: ['website:trial', { websiteId, modified, ...params }],
    queryFn: () =>
      get(`/websites/${websiteId}/trial`, { ...params, internal: params.internal || undefined }),
    enabled: !!websiteId,
    placeholderData: keepPreviousData,
  });
}

export function useTrialSettingsQuery(websiteId: string) {
  const { get, useQuery } = useApi();
  const { modified } = useModified('trialSettings');

  return useQuery<TrialSettings>({
    queryKey: ['website:trial-settings', { websiteId, modified }],
    queryFn: () => get(`/websites/${websiteId}/trial/settings`),
    enabled: !!websiteId,
  });
}

export interface TrialUserEvent {
  eventId: string;
  createdAt: string;
  eventName: string | null;
  hostname: string | null;
  urlPath: string | null;
  properties: Record<string, string> | null;
}

export function useTrialUserEventsQuery(websiteId: string, userId: string, startAt: number) {
  const { get, useQuery } = useApi();

  return useQuery<TrialUserEvent[]>({
    queryKey: ['website:trial-user-events', { websiteId, userId, startAt }],
    queryFn: () =>
      get(`/websites/${websiteId}/trial/users/${encodeURIComponent(userId)}`, { startAt }),
    enabled: !!websiteId && !!userId,
  });
}
