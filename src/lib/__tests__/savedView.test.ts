import {
  buildSavedViewQuery,
  getSavedViewPath,
  isSavedViewMatch,
  normalizeSavedViewQuery,
} from '../savedView';

const websiteId = '0b1e1d9a-1111-2222-3333-444455556666';

describe('getSavedViewPath', () => {
  test('returns the sub path for a report page', () => {
    expect(getSavedViewPath(`/websites/${websiteId}/events`, websiteId)).toBe('/events');
  });

  test('returns empty string for the overview page', () => {
    expect(getSavedViewPath(`/websites/${websiteId}`, websiteId)).toBe('');
    expect(getSavedViewPath(`/websites/${websiteId}/`, websiteId)).toBe('');
  });

  test('ignores a team prefix', () => {
    expect(getSavedViewPath(`/teams/abc-123/websites/${websiteId}/sessions`, websiteId)).toBe(
      '/sessions',
    );
  });

  test('returns null for other websites', () => {
    expect(getSavedViewPath('/websites/other/events', websiteId)).toBeNull();
  });
});

describe('buildSavedViewQuery', () => {
  test('keeps relative date keys as-is', () => {
    expect(buildSavedViewQuery('?cohort=abc&date=7day', '24hour')).toBe('cohort=abc&date=7day');
  });

  test('keeps 14day and other non-preset relative values', () => {
    expect(buildSavedViewQuery('date=14day&cohort=abc', '24hour')).toBe('cohort=abc&date=14day');
    expect(buildSavedViewQuery('date=21day', '24hour')).toBe('date=21day');
  });

  test('pins the default date when none is in the URL', () => {
    expect(buildSavedViewQuery('cohort=abc', '30day')).toBe('cohort=abc&date=30day');
  });

  test('sorts params', () => {
    expect(buildSavedViewQuery('z=1&a=2')).toBe('a=2&z=1');
  });
});

describe('isSavedViewMatch', () => {
  const view = { path: '/events', query: 'cohort=abc&date=7day' };

  test('matches regardless of param order', () => {
    expect(isSavedViewMatch(view, '/events', 'date=7day&cohort=abc')).toBe(true);
  });

  test('does not match a different path or query', () => {
    expect(isSavedViewMatch(view, '/sessions', 'cohort=abc&date=7day')).toBe(false);
    expect(isSavedViewMatch(view, '/events', 'cohort=abc&date=30day')).toBe(false);
    expect(isSavedViewMatch(view, null, 'cohort=abc&date=7day')).toBe(false);
  });

  test('normalizes leading question mark', () => {
    expect(normalizeSavedViewQuery('?b=1&a=2')).toBe('a=2&b=1');
  });
});
