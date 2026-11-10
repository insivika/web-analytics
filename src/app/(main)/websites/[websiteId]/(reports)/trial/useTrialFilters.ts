import { endOfDay, startOfDay, subDays } from 'date-fns';
import { useMemo } from 'react';
import { useNavigation } from '@/components/hooks';
import { parseDateRange } from '@/lib/date';
import type { TrialPlatformFilter } from '@/lib/trial';

export const SIGNUP_PRESETS = ['7day', '14day', '30day', '90day'];
export const DEFAULT_SIGNUP = '14day';

/** Signup window: last N calendar days including today, or a custom range. */
export function getSignupWindow(signup: string, now = new Date()) {
  if (signup?.startsWith('range:')) {
    const { startDate, endDate } = parseDateRange(signup);
    if (+startDate && +endDate && endDate > startDate) {
      return { startDate, endDate };
    }
  }

  const days = SIGNUP_PRESETS.includes(signup) ? parseInt(signup, 10) : 14;

  return { startDate: subDays(startOfDay(now), days - 1), endDate: endOfDay(now) };
}

/** Filters live in the URL (signup, platform, internal) so a view can be bookmarked. */
export function useTrialFilters() {
  const { query, router, updateParams } = useNavigation();
  const signup = query.signup || DEFAULT_SIGNUP;
  const platform = (
    ['ios', 'android', 'web'].includes(query.platform) ? query.platform : 'all'
  ) as TrialPlatformFilter;
  const internal =
    query.internal === 'include' || query.internal === 'exclude' ? query.internal : '';

  // Recompute only when the filter or the calendar day changes, so the query key is stable.
  const today = startOfDay(new Date()).getTime();
  const window = useMemo(() => getSignupWindow(signup), [signup, today]);

  const setFilter = (params: Record<string, string | undefined>) => {
    router.push(updateParams(params));
  };

  return { signup, platform, internal, window, setFilter };
}
