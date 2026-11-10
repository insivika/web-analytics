import {
  Button,
  Checkbox,
  Column,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  Grid,
  Loading,
  Text,
  TextField,
} from '@umami/react-zen';
import { useMessages, useTrialSettingsQuery, useUpdateQuery } from '@/components/hooks';
import { Settings } from '@/components/icons';
import { DialogButton } from '@/components/input/DialogButton';
import type { TrialSettings } from '@/lib/trial';

const splitList = (value: string) =>
  String(value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const LIST_FIELDS = ['engagementEvents', 'conversionEvents', 'paidStatuses'] as const;

const TEXT_FIELDS = [
  'trialStartEvent',
  'activeDayEvent',
  'activationEvent',
  'pushEvent',
  'pushAnswerProperty',
  'pushAnswerValue',
  'pushGrantedProperty',
  'statusProperty',
  'userIdProperty',
  'platformProperty',
  'internalProperty',
] as const;

export function toFormValues(settings: TrialSettings) {
  return {
    ...settings,
    trialLengthDays: String(settings.trialLengthDays),
    conversionGraceDays: String(settings.conversionGraceDays),
    milestones: settings.milestones.map(step => step.join(' | ')).join('\n'),
    ...Object.fromEntries(LIST_FIELDS.map(key => [key, settings[key].join(', ')])),
  };
}

export function fromFormValues(values: Record<string, any>): Partial<TrialSettings> {
  return {
    ...Object.fromEntries(TEXT_FIELDS.map(key => [key, String(values[key] ?? '').trim()])),
    trialLengthDays: Number(values.trialLengthDays),
    conversionGraceDays: Number(values.conversionGraceDays),
    excludeInternal: !!values.excludeInternal,
    milestones: String(values.milestones ?? '')
      .split('\n')
      .map(line =>
        line
          .split('|')
          .map(s => s.trim())
          .filter(Boolean),
      )
      .filter(step => step.length > 0),
    ...Object.fromEntries(LIST_FIELDS.map(key => [key, splitList(values[key])])),
  };
}

export function TrialSettingsButton({ websiteId }: { websiteId: string }) {
  const { formatMessage, labels } = useMessages();

  return (
    <DialogButton
      icon={<Settings />}
      label={formatMessage(labels.trialSettings)}
      variant="outline"
      width="720px"
    >
      {({ close }) => <TrialSettingsForm websiteId={websiteId} onClose={close} />}
    </DialogButton>
  );
}

function TrialSettingsForm({ websiteId, onClose }: { websiteId: string; onClose: () => void }) {
  const { formatMessage, labels, messages, getErrorMessage } = useMessages();
  const { data } = useTrialSettingsQuery(websiteId);
  const { mutateAsync, error, isPending, touch, toast } = useUpdateQuery(
    `/websites/${websiteId}/trial/settings`,
  );

  if (!data) {
    return <Loading placement="absolute" />;
  }

  const handleSubmit = async (values: Record<string, any>) => {
    await mutateAsync(fromFormValues(values), {
      onSuccess: () => {
        toast(formatMessage(messages.saved));
        touch('trialSettings');
        onClose();
      },
    });
  };

  const required = { required: formatMessage(labels.required) };
  const field = (name: string, label: string, hint?: string) => (
    <FormField name={name} label={label} rules={required}>
      <TextField autoComplete="off" placeholder={hint} />
    </FormField>
  );

  return (
    <Form onSubmit={handleSubmit} error={getErrorMessage(error)} defaultValues={toFormValues(data)}>
      <Column gap="3">
        <Grid columns={{ xs: '1fr', md: '1fr 1fr' }} gap="3">
          {field('trialStartEvent', formatMessage(labels.trialStartEvent))}
          {field('trialLengthDays', formatMessage(labels.trialLengthDays))}
          {field('activeDayEvent', formatMessage(labels.activeDayEvent))}
          {field('activationEvent', formatMessage(labels.activationEvent))}
        </Grid>
        <FormField name="milestones" label={formatMessage(labels.milestones)} rules={required}>
          <TextField asTextArea resize="vertical" autoComplete="off" />
        </FormField>
        <Text color="muted" size="1">
          {formatMessage(messages.milestonesHint)}
        </Text>
        <FormField name="engagementEvents" label={formatMessage(labels.engagementEvents)}>
          <TextField autoComplete="off" />
        </FormField>
        <Grid columns={{ xs: '1fr', md: '1fr 1fr' }} gap="3">
          <FormField name="conversionEvents" label={formatMessage(labels.conversionEvents)}>
            <TextField autoComplete="off" />
          </FormField>
          <FormField name="paidStatuses" label={formatMessage(labels.paidStatuses)}>
            <TextField autoComplete="off" />
          </FormField>
          {field('statusProperty', formatMessage(labels.statusProperty))}
          {field('conversionGraceDays', formatMessage(labels.conversionGraceDays))}
          {field('pushEvent', formatMessage(labels.pushEvent))}
          {field('pushAnswerProperty', formatMessage(labels.pushAnswerProperty))}
          {field('pushAnswerValue', formatMessage(labels.pushAnswerValue))}
          {field('pushGrantedProperty', formatMessage(labels.pushGrantedProperty))}
          {field('userIdProperty', formatMessage(labels.userIdProperty))}
          {field('platformProperty', formatMessage(labels.platformProperty))}
          {field('internalProperty', formatMessage(labels.internalProperty))}
        </Grid>
        <Text color="muted" size="1">
          {formatMessage(messages.commaSeparatedHint)}
        </Text>
        <FormField name="excludeInternal">
          {({ field }) => (
            <Checkbox isSelected={!!field.value} onChange={field.onChange}>
              {formatMessage(labels.excludeInternalByDefault)}
            </Checkbox>
          )}
        </FormField>
      </Column>
      <FormButtons>
        <Button isDisabled={isPending} onPress={onClose}>
          {formatMessage(labels.cancel)}
        </Button>
        <FormSubmitButton variant="primary" isDisabled={isPending}>
          {formatMessage(labels.save)}
        </FormSubmitButton>
      </FormButtons>
    </Form>
  );
}
