/** Pure figures behind the Music tab's charts. No React, so
 *  tools/musicinsights.test.ts runs it.
 *
 *  Counting rules (they come from src/insightstats.ts, which builds the rows):
 *   - a song is counted once per night, whoever brought it and however many
 *     copies carry it; a track with no song id is a play, never a song;
 *   - "distinct songs in a year" means songs on at least one night of that year;
 *   - enrichment is partial: every table says how many songs it knows
 *     (`Cover`), and a song with a release year but no genre family is in the
 *     decade figures and absent from the family ones (and the other way round);
 *   - "new" is judged against the whole history, and the opening night has no
 *     "before", so nothing on it is new. */
import type { Catalog } from "./catalog.ts";
import { decadeOf, familyOf, yearOf, type EnrichMap } from "./enrich.ts";
import { median, type NightRow } from "./insightstats.ts";

/** How much of a set of songs a figure is based on. */
export interface Cover { known: number; total: number }

// ------------------------------------------------------------------ basics

export function distinctSongs(rows: NightRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) for (const id of r.songIds) s.add(id);
  return s;
}

/** year -> songs on at least one night of that year. Every year in `years` has an entry. */
export function songsByYear(rows: NightRow[], years: string[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>(years.map((y) => [y, new Set()]));
  for (const r of rows) {
    let s = m.get(r.year);
    if (!s) { s = new Set(); m.set(r.year, s); }
    for (const id of r.songIds) s.add(id);
  }
  return m;
}

export const songFamily = (enrich: EnrichMap | null, id: string) => familyOf(enrich?.[id]);
export const songDecade = (enrich: EnrichMap | null, id: string) => decadeOf(yearOf(enrich?.[id]));

// ------------------------------------------------- a key per song, per year

export interface KeyTable {
  years: string[];
  /** Keys by size, biggest first (or in `order`). */
  keys: string[];
  /** Songs per [year][key]. Songs with no key are in `total` but in no cell. */
  cells: number[][];
  /** Per year: songs that have a key / songs at all. */
  known: number[];
  total: number[];
  /** Over the whole span. */
  cover: Cover;
}

/** Distinct songs per year, split by `keyOf` (genre family, release decade ...). */
export function keyTable(
  years: string[], byYear: Map<string, Set<string>>, keyOf: (songId: string) => string | null,
  order?: (a: string, b: string) => number,
): KeyTable {
  const size = new Map<string, number>(), all = new Set<string>(), knownAll = new Set<string>();
  const perYear = years.map((y) => {
    const c = new Map<string, number>();
    let known = 0;
    const songs = byYear.get(y) ?? new Set<string>();
    for (const id of songs) {
      all.add(id);
      const k = keyOf(id);
      if (k === null) continue;
      known++; knownAll.add(id);
      c.set(k, (c.get(k) ?? 0) + 1);
      size.set(k, (size.get(k) ?? 0) + 1);
    }
    return { c, known, total: songs.size };
  });
  const keys = [...size.keys()].sort(order ?? ((a, b) => size.get(b)! - size.get(a)! || a.localeCompare(b)));
  return {
    years, keys,
    cells: perYear.map((p) => keys.map((k) => p.c.get(k) ?? 0)),
    known: perYear.map((p) => p.known), total: perYear.map((p) => p.total),
    cover: { known: knownAll.size, total: all.size },
  };
}

/** Keep the `keep` biggest keys (shown in `order` if given) and fold the rest into one
 *  last column. `rest` lists what was folded, empty when nothing was. */
export function collapse(t: KeyTable, keep: number, order?: (a: string, b: string) => number): KeyTable & { rest: string[] } {
  const size = t.keys.map((_, j) => t.cells.reduce((a, row) => a + row[j], 0));
  const idx = t.keys.map((_, j) => j).sort((a, b) => size[b] - size[a] || a - b);
  const kept = idx.slice(0, keep), folded = idx.slice(keep);
  if (order) kept.sort((a, b) => order(t.keys[a], t.keys[b]));
  const keys = kept.map((j) => t.keys[j]);
  const cells = t.cells.map((row) => {
    const out = kept.map((j) => row[j]);
    if (folded.length) out.push(folded.reduce((a, j) => a + row[j], 0));
    return out;
  });
  return { ...t, keys, cells, rest: folded.map((j) => t.keys[j]) };
}

/** One key's share of the songs we know a key for, per year; null in a year with none. */
export function shareSeries(t: KeyTable, key: string): Array<number | null> {
  const j = t.keys.indexOf(key);
  return t.years.map((_, i) => (j < 0 || !t.known[i] ? null : t.cells[i][j] / t.known[i]));
}

export const decadeOrder = (a: string, b: string) => parseInt(a) - parseInt(b);

/** Median age of the music when it was brought: year of the night minus release year,
 *  over the distinct songs of each year that have a believable release year. Null for a
 *  year with none. A release year after the night (a wrong match) is left out, not
 *  clamped to zero: it says nothing about age. */
export function ageByYear(
  years: string[], byYear: Map<string, Set<string>>, enrich: EnrichMap | null,
): Array<{ median: number | null; known: number; total: number }> {
  return years.map((y) => {
    const songs = byYear.get(y) ?? new Set<string>();
    const ages: number[] = [];
    for (const id of songs) {
      const ry = yearOf(enrich?.[id]);
      if (ry !== null && +y - ry >= 0) ages.push(+y - ry);
    }
    return { median: median(ages), known: ages.length, total: songs.size };
  });
}

// -------------------------------------------------------- family x decade

export interface HeatTable {
  families: string[];
  /** Contiguous, oldest first, from the first to the last decade seen. */
  decades: string[];
  /** Songs per [family][decade]. */
  counts: number[][];
  /** Songs that have both a family and a decade / songs at all. */
  cover: Cover;
}

export function heatTable(songs: Set<string>, enrich: EnrichMap | null): HeatTable {
  const pairs: Array<[string, number]> = [];
  for (const id of songs) {
    const f = songFamily(enrich, id), y = yearOf(enrich?.[id]);
    if (f !== null && y !== null) pairs.push([f, Math.floor(y / 10) * 10]);
  }
  if (!pairs.length) return { families: [], decades: [], counts: [], cover: { known: 0, total: songs.size } };
  const lo = Math.min(...pairs.map((p) => p[1])), hi = Math.max(...pairs.map((p) => p[1]));
  const decades: string[] = [];
  for (let d = lo; d <= hi; d += 10) decades.push(`${d}s`);
  const size = new Map<string, number>();
  for (const [f] of pairs) size.set(f, (size.get(f) ?? 0) + 1);
  const families = [...size.keys()].sort((a, b) => size.get(b)! - size.get(a)! || a.localeCompare(b));
  const counts = families.map(() => decades.map(() => 0));
  for (const [f, d] of pairs) counts[families.indexOf(f)][(d - lo) / 10]++;
  return { families, decades, counts, cover: { known: pairs.length, total: songs.size } };
}

export function songsInCell(songs: Set<string>, enrich: EnrichMap | null, family: string, decade: string): string[] {
  return [...songs].filter((id) => songFamily(enrich, id) === family && songDecade(enrich, id) === decade);
}

/** The empty cells where the rest of the table says most should be: expected songs if
 *  family and decade were unrelated = row total x column total / all. Cells expected to
 *  hold under `minExpected` songs are not worth naming. */
export function littleExplored(h: HeatTable, n = 3, minExpected = 2): Array<{ family: string; decade: string; expected: number }> {
  const rowT = h.counts.map((r) => r.reduce((a, b) => a + b, 0));
  const colT = h.decades.map((_, j) => h.counts.reduce((a, r) => a + r[j], 0));
  const all = rowT.reduce((a, b) => a + b, 0);
  const out: Array<{ family: string; decade: string; expected: number }> = [];
  if (!all) return out;
  h.families.forEach((f, i) => h.decades.forEach((d, j) => {
    const expected = (rowT[i] * colT[j]) / all;
    if (h.counts[i][j] === 0 && expected >= minExpected) out.push({ family: f, decade: d, expected });
  }));
  return out.sort((a, b) => b.expected - a.expected || a.family.localeCompare(b.family) || a.decade.localeCompare(b.decade)).slice(0, n);
}

// ----------------------------------------------------------- concentration

/** Share of the total held by the `k` biggest counts. Null when there is nothing to
 *  share, or when there are no more than `k` things (the top k would trivially be all). */
export function topShare(counts: number[], k: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total || counts.length <= k) return null;
  const top = [...counts].sort((a, b) => b - a).slice(0, k);
  return top.reduce((a, b) => a + b, 0) / total;
}

export interface ConcentrationYear { year: string; song10: number | null; song50: number | null; artist10: number | null; artist50: number | null }

/** Per year, the share of song-nights (a song on a night is one) and artist-nights held by
 *  the 10 and 50 biggest. Bigger years spread thinner by arithmetic alone. */
export function concentrationByYear(rows: NightRow[], years: string[]): ConcentrationYear[] {
  const songs = new Map<string, Map<string, number>>(years.map((y) => [y, new Map()]));
  const artists = new Map<string, Map<string, number>>(years.map((y) => [y, new Map()]));
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of rows) {
    const sm = songs.get(r.year), am = artists.get(r.year);
    if (!sm || !am) continue;
    for (const s of r.songIds) bump(sm, s);
    for (const a of r.artistIds) bump(am, a);
  }
  return years.map((year) => {
    const s = [...songs.get(year)!.values()], a = [...artists.get(year)!.values()];
    return { year, song10: topShare(s, 10), song50: topShare(s, 50), artist10: topShare(a, 10), artist50: topShare(a, 50) };
  });
}

// ---------------------------------------------------------------- per song

export interface SongSpan { id: string; nights: number; first: string; last: string; years: number }

const DAY = 86_400_000;
const dayNo = (d: string) => Date.parse(d + "T00:00:00Z") / DAY;
/** Whole years between two ISO dates (365.25-day years, rounded down). */
export const yearsBetween = (a: string, b: string) => Math.floor((dayNo(b) - dayNo(a)) / 365.25);

/** What each song did on the rows: nights it was on, first and last date. Rows must be oldest first. */
export function songSpans(rows: NightRow[]): SongSpan[] {
  const m = new Map<string, SongSpan>();
  for (const r of rows) {
    for (const id of r.songIds) {
      const s = m.get(id);
      if (s) { s.nights++; s.last = r.date; } else m.set(id, { id, nights: 1, first: r.date, last: r.date, years: 0 });
    }
  }
  for (const s of m.values()) s.years = yearsBetween(s.first, s.last);
  return [...m.values()];
}

/** Items into bins by a number each; `edges` are lower edges, the last one open-ended.
 *  A value below the first edge is in no bin. */
export function bin<T>(items: T[], valueOf: (t: T) => number, edges: number[], label: (lo: number, hi: number | null) => string): Array<{ key: string; label: string; items: T[] }> {
  const out = edges.map((lo, i) => ({ key: String(lo), label: label(lo, i + 1 < edges.length ? edges[i + 1] : null), items: [] as T[] }));
  for (const it of items) {
    const v = valueOf(it);
    let j = -1;
    for (let i = 0; i < edges.length; i++) if (v >= edges[i]) j = i;
    if (j >= 0) out[j].items.push(it);
  }
  return out;
}

export const REPEAT_EDGES = [1, 2, 3, 4];
export const NIGHTS_EDGES = [1, 2, 3, 4, 5, 6, 10, 20];
export const SPAN_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const LENGTH_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export const nightsLabel = (lo: number, hi: number | null) =>
  hi === null ? `${lo}+` : hi - lo === 1 ? String(lo) : `${lo}–${hi - 1}`;
export const spanLabel = (lo: number, hi: number | null) =>
  hi === null ? `${lo}+` : String(lo);
export const lengthLabel = (lo: number, hi: number | null) => (hi === null ? `${lo}+` : `${lo}–${hi}`);

// ------------------------------------------------------------ track length

/** Seconds a song runs: the median length of its played tracks, a track with none
 *  borrowing its twin's. Songs with no recorded length are absent. */
export function songSeconds(cat: Catalog): Map<string, number> {
  const byId = new Map(cat.tracks.map((t) => [t.id, t]));
  const per = new Map<string, number[]>();
  for (const t of cat.tracks) {
    if (!t.played) continue;
    const sid = t.songId ?? (t.twinId ? byId.get(t.twinId)?.songId ?? null : null);
    const d = t.durationSec ?? (t.twinId ? byId.get(t.twinId)?.durationSec : null) ?? 0;
    if (!sid || !(d > 0)) continue;
    (per.get(sid) ?? per.set(sid, []).get(sid)!).push(d);
  }
  return new Map([...per].map(([id, ds]) => [id, median(ds)!]));
}

/** Median song length in minutes per year, over song-nights; null for a year with no length known. */
export function medianLengthByYear(rows: NightRow[], years: string[], secs: Map<string, number>): Array<number | null> {
  const per = new Map<string, number[]>(years.map((y) => [y, []]));
  for (const r of rows) {
    const bucket = per.get(r.year);
    if (!bucket) continue;
    for (const id of r.songIds) { const s = secs.get(id); if (s !== undefined) bucket.push(s / 60); }
  }
  return years.map((y) => median(per.get(y)!));
}

// -------------------------------------------------------- where new comes from

/** Songs and artists that first turned up on each night, judged on the whole history
 *  (`history`, oldest first). The opening night introduces nothing: it has no "before". */
export function firstSightings(history: NightRow[]): { song: Map<string, string>; artist: Map<string, string> } {
  const song = new Map<string, string>(), artist = new Map<string, string>();
  history.forEach((r, i) => {
    for (const id of r.songIds) if (!song.has(id)) song.set(id, i === 0 ? "" : r.id);
    for (const id of r.artistIds) if (!artist.has(id)) artist.set(id, i === 0 ? "" : r.id);
  });
  return { song, artist };
}

/** year -> the songs (or artists) first heard on a night of that year within `rows`. */
export function newByYear(rows: NightRow[], years: string[], first: Map<string, string>, kind: "song" | "artist"): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>(years.map((y) => [y, new Set()]));
  for (const r of rows) {
    const s = m.get(r.year);
    if (!s) continue;
    for (const id of kind === "song" ? r.songIds : r.artistIds) if (first.get(id) === r.id) s.add(id);
  }
  return m;
}
