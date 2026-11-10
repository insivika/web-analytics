import {
  AlertDialog,
  Button,
  Dialog,
  Icon,
  IconLabel,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  NavMenuGroup,
  NavMenuItem,
  Popover,
  Row,
  Text,
} from '@umami/react-zen';
import Link from 'next/link';
import { useState } from 'react';
import {
  type SavedView,
  useDeleteQuery,
  useMessages,
  useNavigation,
  useWebsiteSavedViewsQuery,
} from '@/components/hooks';
import { Bookmark, Edit, MoreHorizontal, Trash } from '@/components/icons';
import { getSavedViewPath, isSavedViewMatch } from '@/lib/savedView';
import { SavedViewForm } from './SavedViewForm';

// Rendered inside the website SideMenu's NavMenu, so it shares its styling and onItemClick.
export function SavedViewsNav({ websiteId }: { websiteId: string }) {
  const { formatMessage, labels } = useMessages();
  const { pathname, searchParams, renderUrl } = useNavigation();
  const { data } = useWebsiteSavedViewsQuery(websiteId);

  if (!data?.length) {
    return null;
  }

  const currentPath = getSavedViewPath(pathname, websiteId);
  const currentQuery = searchParams.toString();

  const getHref = ({ path, query }: SavedView) => {
    const base = renderUrl(`/websites/${websiteId}${path}`, false);
    return query ? `${base}?${query}` : base;
  };

  return (
    <NavMenuGroup
      title={formatMessage(labels.savedViews)}
      gap="1"
      allowMinimize={false}
      marginBottom="3"
    >
      {data.map(view => (
        <NavMenuItem
          key={view.id}
          isSelected={isSavedViewMatch(view, currentPath, currentQuery)}
          alignItems="center"
          justifyContent="space-between"
        >
          <Link href={getHref(view)} style={{ flex: 1, minWidth: 0 }} title={view.name}>
            <IconLabel icon={<Bookmark />}>
              <Text truncate>{view.name}</Text>
            </IconLabel>
          </Link>
          <SavedViewMenu websiteId={websiteId} view={view} />
        </NavMenuItem>
      ))}
    </NavMenuGroup>
  );
}

function SavedViewMenu({ websiteId, view }: { websiteId: string; view: SavedView }) {
  const { formatMessage, labels, messages } = useMessages();
  const [action, setAction] = useState<'rename' | 'delete' | null>(null);
  const { mutateAsync, touch } = useDeleteQuery(`/websites/${websiteId}/views/${view.id}`);

  const handleClose = () => setAction(null);

  const handleDelete = async () => {
    await mutateAsync(null, {
      onSuccess: () => {
        touch('savedViews');
        handleClose();
      },
    });
  };

  return (
    // Keep clicks on the menu from triggering the nav item (e.g. closing the mobile drawer).
    <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <MenuTrigger>
        <Button variant="quiet" size="sm" aria-label={formatMessage(labels.manage)}>
          <Icon size="sm">
            <MoreHorizontal />
          </Icon>
        </Button>
        <Popover placement="bottom end">
          <Menu onAction={id => setAction(id as 'rename' | 'delete')}>
            <MenuItem id="rename">
              <Icon>
                <Edit />
              </Icon>
              <Text>{formatMessage(labels.rename)}</Text>
            </MenuItem>
            <MenuItem id="delete">
              <Icon>
                <Trash />
              </Icon>
              <Text>{formatMessage(labels.delete)}</Text>
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <Modal isOpen={!!action} isDismissable onOpenChange={open => !open && handleClose()}>
        {action === 'rename' && (
          <Dialog title={formatMessage(labels.rename)} style={{ width: 400, padding: 32 }}>
            <SavedViewForm
              websiteId={websiteId}
              viewId={view.id}
              name={view.name}
              onClose={handleClose}
            />
          </Dialog>
        )}
        {action === 'delete' && (
          <AlertDialog
            title={formatMessage(labels.delete)}
            onConfirm={handleDelete}
            onCancel={handleClose}
            isDanger
          >
            <Row gap="1">{formatMessage(messages.confirmDelete, { target: view.name })}</Row>
          </AlertDialog>
        )}
      </Modal>
    </span>
  );
}
