/** The few things the shell (App) and the pages say to each other without
 *  props. Everything here is a plain browser event or a tiny store, so a page
 *  can opt in by adding one listener and the shell never imports the page.
 *
 *  Contract for the search view (SongSearch):
 *   - On mount, start from `getSearchQuery()` and call `consumeFocusRequest()`;
 *     if it returns true, focus the input (a '/' press can arrive before the
 *     lazy chunk has loaded).
 *   - Listen on `window` for FOCUS_SEARCH_EVENT and focus + select the input.
 *   - When the user types, call `setSearchQuery(text)`. The shell mirrors it
 *     into the URL (#/search?q=...). `subscribeSearchQuery(fn)` reports changes
 *     that came from elsewhere (back button, deep link) so the box can follow. */

export const FOCUS_SEARCH_EVENT = "mdc:focus-search";

let focusWanted = false;

/** Ask the search view to focus its input, now if it is mounted, else on mount. */
export function requestSearchFocus(): void {
  focusWanted = true;
  window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
}

/** True once per request: call from the search view's mount effect. Also
 *  clears the flag when a mounted listener handles the event itself. */
export function consumeFocusRequest(): boolean {
  const w = focusWanted;
  focusWanted = false;
  return w;
}

// --------------------------------------------------------- search query store

let query = "";
const listeners = new Set<(q: string) => void>();

export const getSearchQuery = (): string => query;

/** Returns true when the value actually changed. */
export function setSearchQuery(q: string): boolean {
  if (q === query) return false;
  query = q;
  for (const fn of [...listeners]) fn(q);
  return true;
}

export function subscribeSearchQuery(fn: (q: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
