import { getOffsetDateRange, parseDateRange, parseDateValue } from '../date';

describe('parseDateRange relative day ranges', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 10, 10, 15, 30)); // Nov 10 2026, 15:30 local
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  test('parses the 14day value', () => {
    expect(parseDateValue('14day')).toEqual({ num: 14, unit: 'day' });
  });

  test('14day resolves to a rolling window ending today', () => {
    const range = parseDateRange('14day');

    expect(range.startDate).toEqual(new Date(2026, 9, 27, 0, 0, 0, 0));
    expect(range.endDate).toEqual(new Date(2026, 10, 10, 23, 59, 59, 999));
    expect(range.unit).toBe('day');
    expect(range.num).toBe(14);
    expect(range.value).toBe('14day');
  });

  test('14day uses the same convention as 7day and 30day', () => {
    const day = 24 * 60 * 60 * 1000;
    const span = (value: string) => {
      const { startDate, endDate } = parseDateRange(value);
      return Math.round((+endDate - +startDate) / day);
    };

    expect(span('7day')).toBe(8);
    expect(span('14day')).toBe(15);
    expect(span('30day')).toBe(31);
  });

  test('14day rolls forward with the current date', () => {
    const before = parseDateRange('14day');

    jest.setSystemTime(new Date(2026, 10, 11, 9, 0));
    const after = parseDateRange('14day');
    jest.setSystemTime(new Date(2026, 10, 10, 15, 30));

    expect(after.startDate).toEqual(new Date(2026, 9, 28));
    expect(+after.startDate - +before.startDate).toBe(24 * 60 * 60 * 1000);
  });

  test('previous-period offset shifts 14day by 14 days', () => {
    const range = getOffsetDateRange(parseDateRange('14day'), -1);

    expect(range.startDate).toEqual(new Date(2026, 9, 13));
    expect(range.endDate).toEqual(new Date(2026, 9, 27, 23, 59, 59, 999));
  });

  test('non-preset values such as 21day still parse', () => {
    expect(parseDateRange('21day').startDate).toEqual(new Date(2026, 9, 20));
  });
});
