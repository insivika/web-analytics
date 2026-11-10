'use client';
import { Column } from '@umami/react-zen';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useTimezone, useTrialReportQuery } from '@/components/hooks';
import { TrialFilters } from './TrialFilters';
import { TrialForecast } from './TrialForecast';
import {
  TrialActiveDaysHistogram,
  TrialCohorts,
  TrialDailyActive,
  TrialFunnel,
  TrialKpis,
  TrialNotes,
} from './TrialSections';
import { TrialUsersTable } from './TrialUsersTable';
import { useTrialFilters } from './useTrialFilters';

export function TrialPage({ websiteId }: { websiteId: string }) {
  const { platform, internal, window } = useTrialFilters();
  const { timezone, canonicalizeTimezone } = useTimezone();
  const { data, error, isLoading, isFetching } = useTrialReportQuery(websiteId, {
    startAt: +window.startDate,
    endAt: +window.endDate,
    platform,
    internal,
    timezone: canonicalizeTimezone(timezone),
  });

  return (
    <Column gap style={{ minWidth: 0 }}>
      <TrialFilters
        websiteId={websiteId}
        excludeInternalDefault={data?.settings?.excludeInternal}
      />
      <LoadingPanel
        data={data}
        error={error}
        isLoading={isLoading}
        isEmpty={false}
        minHeight="400px"
      >
        {data && (
          <Column gap style={{ minWidth: 0, opacity: isFetching ? 0.6 : 1 }}>
            <TrialNotes report={data} />
            <TrialKpis report={data} />
            <TrialForecast websiteId={websiteId} platform={platform} internal={internal} />
            <TrialFunnel report={data} />
            <TrialDailyActive report={data} />
            <TrialActiveDaysHistogram report={data} />
            <TrialCohorts report={data} />
            <TrialUsersTable websiteId={websiteId} report={data} />
          </Column>
        )}
      </LoadingPanel>
    </Column>
  );
}
