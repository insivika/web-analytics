import {
  Box,
  Button,
  Column,
  DataColumn,
  DataTable,
  Dialog,
  Icon,
  Loading,
  Modal,
  Row,
  Text,
} from '@umami/react-zen';
import { useMemo, useState } from 'react';
import { Pager } from '@/components/common/Pager';
import { Panel } from '@/components/common/Panel';
import { useLocale, useMessages, useTrialUserEventsQuery } from '@/components/hooks';
import { ArrowDown, ArrowUp, Check } from '@/components/icons';
import { DownloadButton } from '@/components/input/DownloadButton';
import { formatDate } from '@/lib/date';
import type { TrialReport, TrialUser } from '@/lib/trial';

const PAGE_SIZE = 25;

type SortKey =
  | 'userId'
  | 'trialStart'
  | 'platform'
  | 'currentTrialDay'
  | 'activeDays'
  | 'engagementCount'
  | 'pushOptIn'
  | 'converted'
  | 'subscriptionStatus';

const sortValue = (user: TrialUser, key: SortKey) => {
  const value = user[key];
  // Ended trials sort after every in-progress day.
  if (key === 'currentTrialDay') return value ?? Number.MAX_SAFE_INTEGER;
  // Push: opted in > saw prompt > didn't see it > not eligible.
  if (key === 'pushOptIn') {
    return !user.pushEligible ? -1 : user.pushOptIn ? 2 : user.pushPromptShown ? 1 : 0;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value ?? '';
};

export function TrialUsersTable({ websiteId, report }: { websiteId: string; report: TrialReport }) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'trialStart',
    desc: true,
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<TrialUser | null>(null);
  const { milestones } = report.settings;

  const sorted = useMemo(() => {
    const rows = [...report.users].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.desc ? rows.reverse() : rows;
  }, [report.users, sort]);

  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const csv = useMemo(
    () =>
      sorted.map(u => ({
        user_id: u.userId,
        trial_start: u.trialStart,
        start_source: u.startSource,
        observed_during_trial: u.observedDuringTrial,
        platform: u.platform ?? '',
        trial_day: u.currentTrialDay ?? 'ended',
        active_days: u.activeDays,
        engagement_events: u.engagementCount,
        ...Object.fromEntries(milestones.map((step, i) => [step.join('|'), u.milestones[i]])),
        push_eligible: u.pushEligible,
        push_prompt_shown: u.pushPromptShown,
        push_opt_in: u.pushOptIn,
        converted: u.converted,
        converted_at: u.convertedAt ?? '',
        trial_completed: u.trialCompleted,
        subscription_status: u.subscriptionStatus ?? '',
        is_internal: u.isInternal,
      })),
    [sorted, milestones],
  );

  const header = (key: SortKey, label: string) => (
    <Row
      alignItems="center"
      gap="1"
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => {
        setPage(1);
        setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'userId' }));
      }}
    >
      <Text>{label}</Text>
      {sort.key === key && <Icon size="xs">{sort.desc ? <ArrowDown /> : <ArrowUp />}</Icon>}
    </Row>
  );

  const check = (value: boolean) =>
    value ? (
      <Icon size="sm" color="primary">
        <Check />
      </Icon>
    ) : (
      <Text color="muted">–</Text>
    );

  return (
    <Panel title={formatMessage(labels.trialUsers)} style={{ minWidth: 0 }}>
      <Column gap="3">
        <Row justifyContent="flex-end">
          <DownloadButton filename="trial-users" data={csv} />
        </Row>
        <Box overflowX="auto" style={{ width: 0, minWidth: '100%' }}>
          <DataTable data={rows} style={{ minWidth: 1100 }}>
            <DataColumn
              id="userId"
              label={header('userId', formatMessage(labels.userId))}
              width="130px"
            >
              {(row: TrialUser) => (
                <Button variant="quiet" size="sm" onPress={() => setSelected(row)}>
                  <Text title={row.userId} style={{ fontFamily: 'monospace' }}>
                    {`${row.userId.slice(0, 8)}…`}
                  </Text>
                </Button>
              )}
            </DataColumn>
            <DataColumn
              id="trialStart"
              label={header('trialStart', formatMessage(labels.trialStart))}
              width="150px"
            >
              {(row: TrialUser) => formatDate(new Date(row.trialStart), 'MMM d, p', locale)}
            </DataColumn>
            <DataColumn id="platform" label={header('platform', formatMessage(labels.platform))}>
              {(row: TrialUser) => row.platform ?? '–'}
            </DataColumn>
            <DataColumn
              id="currentTrialDay"
              label={header('currentTrialDay', formatMessage(labels.trialDay))}
            >
              {(row: TrialUser) => row.currentTrialDay ?? formatMessage(labels.ended)}
            </DataColumn>
            <DataColumn
              id="activeDays"
              label={header('activeDays', formatMessage(labels.activeDays))}
            >
              {(row: TrialUser) => row.activeDays}
            </DataColumn>
            <DataColumn
              id="engagementCount"
              label={header('engagementCount', formatMessage(labels.engagement))}
            >
              {(row: TrialUser) => row.engagementCount}
            </DataColumn>
            {milestones.map((step, index) => (
              <DataColumn
                key={step.join('|')}
                id={`milestone${index}`}
                label={<Text title={step.join(' / ')}>{`M${index + 1}`}</Text>}
                width="50px"
              >
                {(row: TrialUser) => check(row.milestones[index])}
              </DataColumn>
            ))}
            <DataColumn id="pushOptIn" label={header('pushOptIn', formatMessage(labels.pushOptIn))}>
              {(row: TrialUser) =>
                !row.pushEligible ? (
                  <Text color="muted" title={formatMessage(messages.pushNotEligible)}>
                    n/a
                  </Text>
                ) : row.pushOptIn ? (
                  check(true)
                ) : row.pushPromptShown ? (
                  <Text color="muted">{formatMessage(labels.promptShown)}</Text>
                ) : (
                  check(false)
                )
              }
            </DataColumn>
            <DataColumn
              id="converted"
              label={header('converted', formatMessage(labels.convertedToPaid))}
            >
              {(row: TrialUser) => check(row.converted)}
            </DataColumn>
            <DataColumn
              id="subscriptionStatus"
              label={header('subscriptionStatus', formatMessage(labels.subscription))}
            >
              {(row: TrialUser) => row.subscriptionStatus ?? '–'}
            </DataColumn>
          </DataTable>
        </Box>
        <Text color="muted" size="1">
          {milestones.map((step, i) => `M${i + 1} = ${step.join(' / ')}`).join(' · ')}
        </Text>
        <Pager page={page} pageSize={PAGE_SIZE} count={sorted.length} onPageChange={setPage} />
      </Column>
      {selected && (
        <Modal isOpen={true} isDismissable onOpenChange={open => !open && setSelected(null)}>
          <Dialog title={selected.userId} style={{ width: 900, maxWidth: '100vw', padding: 32 }}>
            <TrialUserTimeline websiteId={websiteId} user={selected} />
          </Dialog>
        </Modal>
      )}
    </Panel>
  );
}

function TrialUserTimeline({ websiteId, user }: { websiteId: string; user: TrialUser }) {
  const { formatMessage, labels, messages } = useMessages();
  const { locale } = useLocale();
  const { data, isLoading } = useTrialUserEventsQuery(
    websiteId,
    user.userId,
    +new Date(user.trialStart),
  );

  if (isLoading) {
    return <Loading placement="center" />;
  }

  return (
    <Column gap="3" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
      <Text color="muted" size="2">
        {formatMessage(messages.trialUserEvents, { userId: user.userId })}
      </Text>
      <DataTable data={data ?? []}>
        <DataColumn id="createdAt" label={formatMessage(labels.date)} width="180px">
          {(row: any) => formatDate(new Date(row.createdAt), 'PP pp', locale)}
        </DataColumn>
        <DataColumn id="eventName" label={formatMessage(labels.events)} width="1fr">
          {(row: any) => (
            <Text style={{ wordBreak: 'break-all' }}>{row.eventName ?? row.urlPath ?? '–'}</Text>
          )}
        </DataColumn>
        <DataColumn id="hostname" label={formatMessage(labels.hostname)} width="1fr">
          {(row: any) => (
            <Text color="muted" style={{ wordBreak: 'break-all' }}>
              {row.hostname ?? '–'}
            </Text>
          )}
        </DataColumn>
        <DataColumn id="properties" label={formatMessage(labels.properties)} width="2fr">
          {(row: any) => (
            <Text size="1" color="muted" style={{ wordBreak: 'break-all' }}>
              {Object.entries(row.properties ?? {})
                .filter(([key]) => key !== 'user_id')
                .map(([key, value]) => `${key}=${value}`)
                .join(' · ')}
            </Text>
          )}
        </DataColumn>
      </DataTable>
    </Column>
  );
}
