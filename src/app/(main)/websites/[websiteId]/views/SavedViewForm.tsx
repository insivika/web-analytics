import {
  Button,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  TextField,
} from '@umami/react-zen';
import { useMessages, useUpdateQuery } from '@/components/hooks';

export function SavedViewForm({
  websiteId,
  viewId,
  name,
  path,
  query,
  onSave,
  onClose,
}: {
  websiteId: string;
  viewId?: string;
  name?: string;
  path?: string;
  query?: string;
  onSave?: () => void;
  onClose?: () => void;
}) {
  const { formatMessage, labels, messages, getErrorMessage } = useMessages();
  const { mutateAsync, error, isPending, touch, toast } = useUpdateQuery(
    viewId ? `/websites/${websiteId}/views/${viewId}` : `/websites/${websiteId}/views`,
  );

  const handleSubmit = async ({ name }: { name: string }) => {
    const data = viewId ? { name } : { name, path, query };

    await mutateAsync(data, {
      onSuccess: async () => {
        toast(formatMessage(messages.saved));
        touch('savedViews');
        onSave?.();
        onClose?.();
      },
    });
  };

  return (
    <Form onSubmit={handleSubmit} error={getErrorMessage(error)} defaultValues={{ name }}>
      <FormField
        name="name"
        label={formatMessage(labels.name)}
        rules={{ required: formatMessage(labels.required) }}
      >
        <TextField autoComplete="off" autoFocus maxLength={200} />
      </FormField>
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
