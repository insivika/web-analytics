import { Dialog, ListItem, ListSeparator, Modal, Select, type SelectProps } from '@umami/react-zen';
import { endOfYear } from 'date-fns';
import { Fragment, type Key, useState } from 'react';
import { DateDisplay } from '@/components/common/DateDisplay';
import { useMessages, useMobile } from '@/components/hooks';
import { DatePickerForm } from '@/components/metrics/DatePickerForm';
import { parseDateRange, parseDateValue } from '@/lib/date';

export interface DateFilterProps extends SelectProps {
  value?: string;
  onChange?: (value: string) => void;
  showAllTime?: boolean;
  renderDate?: boolean;
  placement?: any;
}

export function DateFilter({
  value,
  onChange,
  showAllTime,
  renderDate,
  placement = 'bottom',
  ...props
}: DateFilterProps) {
  const { formatMessage, labels } = useMessages();
  const [showPicker, setShowPicker] = useState(false);
  const { startDate, endDate } = parseDateRange(value) || {};
  const { isMobile } = useMobile();

  const options = [
    { label: formatMessage(labels.today), value: '0day' },
    {
      label: formatMessage(labels.lastHours, { x: '24' }),
      value: '24hour',
    },
    {
      label: formatMessage(labels.thisWeek),
      value: '0week',
      divider: true,
    },
    {
      label: formatMessage(labels.lastDays, { x: '7' }),
      value: '7day',
    },
    {
      label: formatMessage(labels.thisMonth),
      value: '0month',
      divider: true,
    },
    {
      label: formatMessage(labels.lastDays, { x: '30' }),
      value: '30day',
    },
    {
      label: formatMessage(labels.lastDays, { x: '90' }),
      value: '90day',
    },
    { label: formatMessage(labels.thisYear), value: '0year' },
    {
      label: formatMessage(labels.lastMonths, { x: '6' }),
      value: '6month',
      divider: true,
    },
    {
      label: formatMessage(labels.lastMonths, { x: '12' }),
      value: '12month',
    },
    showAllTime && {
      label: formatMessage(labels.allTime),
      value: 'all',
      divider: true,
    },
    {
      label: formatMessage(labels.customRange),
      value: 'custom',
      divider: true,
    },
  ].filter(n => n);

  // A stored value that isn't a preset (e.g. a cohort saved via the API with `21day`)
  // gets its own option, so it is displayed as-is and kept on save instead of the
  // select falling back to an empty placeholder.
  const getCustomLabel = (value: string) => {
    const { num, unit } = parseDateValue(value) || {};

    if (num > 0) {
      if (unit === 'hour') return formatMessage(labels.lastHours, { x: num });
      if (unit === 'day') return formatMessage(labels.lastDays, { x: num });
      if (unit === 'month') return formatMessage(labels.lastMonths, { x: num });
    }

    return value;
  };

  if (
    value &&
    !value.startsWith('range') &&
    !value.endsWith(':all') &&
    !options.some(option => option.value === value)
  ) {
    options.splice(options.length - 1, 0, {
      label: getCustomLabel(value),
      value,
      divider: true,
    });
  }

  const items = options.map((a, id) => ({ ...a, id }));

  const handleChange = (value: Key) => {
    if (value === 'custom') {
      setShowPicker(true);
      return;
    }
    onChange(value.toString());
  };

  const handlePickerChange = (value: string) => {
    setShowPicker(false);
    onChange(value.toString());
  };

  const renderValue = ({ defaultChildren }) => {
    return value?.startsWith('range') || renderDate ? (
      <DateDisplay startDate={startDate} endDate={endDate} />
    ) : (
      defaultChildren
    );
  };

  const selectedValue = value?.endsWith(':all') ? 'all' : value;

  return (
    <>
      <Select
        {...props}
        value={selectedValue}
        placeholder={formatMessage(labels.selectDate)}
        onChange={handleChange}
        renderValue={renderValue}
        popoverProps={{ placement }}
        isFullscreen={isMobile}
      >
        {items.map(({ label, value, divider }: any) => {
          return (
            <Fragment key={value}>
              {divider && <ListSeparator />}
              <ListItem id={value}>{label}</ListItem>
            </Fragment>
          );
        })}
      </Select>
      {showPicker && (
        <Modal isOpen={true}>
          <Dialog>
            <DatePickerForm
              startDate={startDate}
              endDate={endDate}
              minDate={new Date(2000, 0, 1)}
              maxDate={endOfYear(new Date())}
              onChange={handlePickerChange}
              onClose={() => setShowPicker(false)}
            />
          </Dialog>
        </Modal>
      )}
    </>
  );
}
