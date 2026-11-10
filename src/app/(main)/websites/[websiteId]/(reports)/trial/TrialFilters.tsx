import { Dialog, ListItem, ListSeparator, Modal, Row, Select, Switch } from '@umami/react-zen';
import { endOfYear } from 'date-fns';
import { useState } from 'react';
import { DateDisplay } from '@/components/common/DateDisplay';
import { useMessages } from '@/components/hooks';
import { DatePickerForm } from '@/components/metrics/DatePickerForm';
import { TrialSettingsButton } from './TrialSettingsButton';
import { SIGNUP_PRESETS, useTrialFilters } from './useTrialFilters';

export function TrialFilters({
  websiteId,
  excludeInternalDefault = true,
}: {
  websiteId: string;
  excludeInternalDefault?: boolean;
}) {
  const { formatMessage, labels } = useMessages();
  const { signup, platform, internal, window, setFilter } = useTrialFilters();
  const [showPicker, setShowPicker] = useState(false);
  const excludeInternal = internal ? internal === 'exclude' : excludeInternalDefault;
  const isCustom = signup.startsWith('range:');

  const handleSignupChange = (value: string) => {
    if (value === 'custom') {
      setShowPicker(true);
      return;
    }
    setFilter({ signup: value });
  };

  return (
    <Row alignItems="center" gap="3" wrap="wrap" justifyContent="space-between">
      <Row alignItems="center" gap="3" wrap="wrap">
        <Select
          aria-label={formatMessage(labels.signupWindow)}
          label={formatMessage(labels.signupWindow)}
          value={isCustom ? 'custom' : signup}
          onChange={value => handleSignupChange(String(value))}
          renderValue={({ defaultChildren }) =>
            isCustom ? (
              <DateDisplay startDate={window.startDate} endDate={window.endDate} />
            ) : (
              defaultChildren
            )
          }
          style={{ width: 220 }}
        >
          {SIGNUP_PRESETS.map(value => (
            <ListItem key={value} id={value}>
              {formatMessage(labels.lastDays, { x: parseInt(value, 10) })}
            </ListItem>
          ))}
          <ListSeparator />
          <ListItem id="custom">{formatMessage(labels.customRange)}</ListItem>
        </Select>
        <Select
          aria-label={formatMessage(labels.platform)}
          label={formatMessage(labels.platform)}
          value={platform}
          onChange={value => setFilter({ platform: value === 'all' ? undefined : String(value) })}
          style={{ width: 180 }}
        >
          <ListItem id="all">{formatMessage(labels.allPlatforms)}</ListItem>
          <ListItem id="ios">iOS</ListItem>
          <ListItem id="android">Android</ListItem>
          <ListItem id="web">Web</ListItem>
        </Select>
        <Switch
          isSelected={excludeInternal}
          onChange={selected => setFilter({ internal: selected ? 'exclude' : 'include' })}
          style={{ alignSelf: 'flex-end', paddingBottom: 8 }}
        >
          {formatMessage(labels.excludeInternalUsers)}
        </Switch>
      </Row>
      <TrialSettingsButton websiteId={websiteId} />
      {showPicker && (
        <Modal isOpen={true}>
          <Dialog>
            <DatePickerForm
              startDate={window.startDate}
              endDate={window.endDate}
              minDate={new Date(2000, 0, 1)}
              maxDate={endOfYear(new Date())}
              onChange={(value: string) => {
                setShowPicker(false);
                setFilter({ signup: value });
              }}
              onClose={() => setShowPicker(false)}
            />
          </Dialog>
        </Modal>
      )}
    </Row>
  );
}
