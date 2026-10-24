/** Pure logic behind the Search control bar: which filters are on (as removable
 *  chips), how to remove one or all, the count badge text, the order sentence,
 *  the hidden-songs note and the idle-state suggestions. No React, no DOM, so
 *  tools/searchbar.test.ts can run it.
 *
 *  Filters never include the query: removing or clearing a chip leaves the text
 *  in the box (and so the URL, #/search?q=) alone. */
import { unknownWhat, type Sel, type Summary } from "./enrichfilter.ts";
import type { SortKey } from "./pagehelpers.ts";

/** Everything the bar can switch on, other than the text itself. */
export interface FilterState {
  personId: string;
  year: string;
  type: string;
  families: string[];
  decades: string[];
}

export const NO_FILTERS: FilterState = { personId: "", year: "", type: "", families: [], decades: [] };

export type ChipKind = "person" | "year" | "type" | "family" | "decade";
export interface ActiveChip { kind: ChipKind; value: string; label: string }

/** The filters that are on, in a stable order, each with the words to show. */
export function activeChips(
  s: FilterState,
  words: { person: (id: string) => string; family: (key: string) => string },
): ActiveChip[] {
  const out: ActiveChip[] = [];
  for (const f of s.families) out.push({ kind: "family", value: f, label: words.family(f) });
  for (const d of s.decades) out.push({ kind: "decade", value: d, label: d });
  if (s.personId) out.push({ kind: "person", value: s.personId, label: words.person(s.personId) });
  if (s.year) out.push({ kind: "year", value: s.year, label: s.year });
  if (s.type) out.push({ kind: "type", value: s.type, label: s.type });
  return out;
}

/** The state with one chip switched off; every other field (the query too, if the
 *  caller carries it along) is kept. */
export function removeChip<T extends FilterState>(s: T, c: Pick<ActiveChip, "kind" | "value">): T {
  switch (c.kind) {
    case "family": return { ...s, families: s.families.filter((x) => x !== c.value) };
    case "decade": return { ...s, decades: s.decades.filter((x) => x !== c.value) };
    case "person": return { ...s, personId: "" };
    case "year": return { ...s, year: "" };
    case "type": return { ...s, type: "" };
  }
}

export function clearAll<T extends FilterState>(s: T): T {
  return { ...s, personId: "", year: "", type: "", families: [], decades: [] };
}

/** "Genre" while nothing is picked, "Genre · 2" once something is. */
export const badgeLabel = (name: string, n: number) => (n > 0 ? `${name} · ${n}` : name);

/** The sentence after the counts: what the list is ordered by. */
export function orderText(sort: SortKey): string {
  switch (sort) {
    case "match": return "best match first";
    case "nights": return "most nights first";
    case "az": return "A to Z";
    case "newest": return "newest play first";
  }
}

const n = (x: number) => x.toLocaleString("en-GB");

/** The quiet footer inside the Genre / Released popovers: how many songs the
 *  chips are hiding for want of data, or (nothing picked) how many have data. */
export function hiddenNote(
  sum: Summary, sel: Sel, cov: { total: number; either: number },
): string {
  if (sum.unknown > 0 && (sel.families.length > 0 || sel.decades.length > 0)) {
    return `${n(sum.unknown)} of ${n(sum.total)} songs hidden because no ${unknownWhat(sel)} on file.`;
  }
  return `${n(cov.either)} of ${n(cov.total)} songs have a genre or year on file; the rest are hidden while a filter is on.`;
}

// -------------------------------------------------------------- suggestions

export interface SongLite { artist: string | null; title: string; nights: string[] }
export interface Suggestions {
  artists: Array<{ name: string; nights: number }>;
  songs: Array<{ title: string; artist: string | null; nights: number }>;
  decades: string[];
}

/** Idle-state shortcuts, all counted from the library itself: artists by the
 *  number of different nights any of their songs was played, songs by nights,
 *  and the decades that exist (passed in; none when there is no enrichment). */
export function suggestions(
  songs: readonly SongLite[], decades: readonly string[], limits = { artists: 6, songs: 5 },
): Suggestions {
  const byArtist = new Map<string, Set<string>>();
  for (const s of songs) {
    const a = s.artist?.trim();
    if (!a || !s.nights.length) continue;
    let set = byArtist.get(a);
    if (!set) byArtist.set(a, set = new Set());
    for (const e of s.nights) set.add(e);
  }
  const artists = [...byArtist].map(([name, set]) => ({ name, nights: set.size }))
    .sort((a, b) => b.nights - a.nights || a.name.localeCompare(b.name))
    .slice(0, limits.artists);
  const top = songs.filter((s) => s.nights.length > 0 && s.title.trim())
    .map((s) => ({ title: s.title, artist: s.artist, nights: s.nights.length }))
    .sort((a, b) => b.nights - a.nights || a.title.localeCompare(b.title))
    .slice(0, limits.songs);
  return { artists, songs: top, decades: [...decades] };
}
