import { useMessages, useNavigation } from '@/components/hooks';
import { Bookmark } from '@/components/icons';
import { DialogButton } from '@/components/input/DialogButton';
import { DATE_RANGE_CONFIG, DEFAULT_DATE_RANGE_VALUE } from '@/lib/constants';
import { buildSavedViewQuery, getSavedViewPath } from '@/lib/savedView';
import { getItem } from '@/lib/storage';
import { SavedViewForm } from './SavedViewForm';

export function SaveViewButton({ websiteId }: { websiteId: string }) {
  const { formatMessage, labels } = useMessages();
  const { pathname, searchParams } = useNavigation();

  const path = getSavedViewPath(pathname, websiteId);

  if (path === null) {
    return null;
  }

  return (
    <DialogButton
      icon={<Bookmark />}
      label={formatMessage(labels.saveView)}
      variant="outline"
      width="400px"
    >
      {({ close }) => (
        <SavedViewForm
          websiteId={websiteId}
          path={path}
          query={buildSavedViewQuery(
            searchParams.toString(),
            getItem(DATE_RANGE_CONFIG) || DEFAULT_DATE_RANGE_VALUE,
          )}
          onClose={close}
        />
      )}
    </DialogButton>
  );
}
