// Helpers for saved views. A saved view stores a path relative to the website root
// (e.g. '' for Overview, '/events' for Events) plus the raw query string. Relative
// date keys like `7day` are stored as-is so views roll forward over time.

export function getSavedViewPath(pathname: string, websiteId: string): string | null {
  const marker = `/websites/${websiteId}`;
  const index = pathname.indexOf(marker);

  if (index === -1) {
    return null;
  }

  return pathname.slice(index + marker.length).replace(/\/+$/, '');
}

export function normalizeSavedViewQuery(query: string | URLSearchParams): string {
  const params = new URLSearchParams(typeof query === 'string' ? query.replace(/^\?/, '') : query);

  params.sort();

  return params.toString();
}

export function buildSavedViewQuery(
  searchParams: string | URLSearchParams,
  defaultDate?: string,
): string {
  const params = new URLSearchParams(
    typeof searchParams === 'string' ? searchParams.replace(/^\?/, '') : searchParams,
  );

  // The date range falls back to local storage when absent from the URL. Pin the
  // effective relative key so every viewer of the saved view gets the same range.
  if (!params.get('date') && defaultDate) {
    params.set('date', defaultDate);
  }

  return normalizeSavedViewQuery(params);
}

export function isSavedViewMatch(
  view: { path: string; query: string },
  currentPath: string | null,
  currentQuery: string | URLSearchParams,
): boolean {
  if (currentPath === null || view.path !== currentPath) {
    return false;
  }

  return normalizeSavedViewQuery(view.query) === normalizeSavedViewQuery(currentQuery);
}
