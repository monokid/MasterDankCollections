/** Genre-family / release-decade filtering shared by Search and Browse. Pure, so
 *  tools/enrichfilter.test.ts can run it.
 *
 *  Enrichment is partial (most songs match, some never do), so a filter is never
 *  silent about what it cannot see: with a family or decade selected, a song whose
 *  family or decade is unknown is hidden, and `summarise` says how many. Chip
 *  counts are faceted: a row's counts are computed under the OTHER row's selection
 *  only, so picking "rock" never zeroes the other rock chips and picking 1990s
 *  shows how many of each family are from the 1990s. */
import { decadeOf, familyOf, yearOf, type EnrichMap } from "./enrich.ts";

/** What a filter needs to know about one song. Both null = nothing on file. */
export interface Fact { family: string | null; decade: string | null }

/** The chips ticked. Empty list = no restriction in that row; within a row the
 *  choices are OR, across the two rows AND. */
export interface Sel { families: string[]; decades: string[] }

export const NO_SEL: Sel = { families: [], decades: [] };
export const selActive = (s: Sel) => s.families.length > 0 || s.decades.length > 0;

export const NIGHT_MIN_SONGS = 3;
export const NIGHT_MIN_SHARE = 0.1;
/** A night shows its "sound" line only when this much of it is known. */
export const SOUND_MIN_KNOWN = 0.3;

/** Family and decade of a song. A suspect year (match released after the song was
 *  first played) gives no decade; a year with no family keeps its decade. */
export function factOf(enrich: EnrichMap | null | undefined, songId: string | null | undefined): Fact {
  const r = enrich && songId ? enrich[songId] : undefined;
  return { family: familyOf(r), decade: decadeOf(yearOf(r)) };
}

export const toggle = (list: string[], v: string) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

/** Does a song pass? A selected row needs a known value inside it. */
export function passes(f: Fact, s: Sel): boolean {
  if (s.families.length && (!f.family || !s.families.includes(f.family))) return false;
  if (s.decades.length && (!f.decade || !s.decades.includes(f.decade))) return false;
  return true;
}

/** True when the song is hidden only for want of data (not for being outside the
 *  selection): a selected row and an unknown value there. */
export const unseen = (f: Fact, s: Sel) =>
  (s.families.length > 0 && !f.family) || (s.decades.length > 0 && !f.decade);

/** "genre", "year" or "genre or year", for the hidden-songs sentence. */
export const unknownWhat = (s: Sel) =>
  s.families.length && s.decades.length ? "genre or year" : s.families.length ? "genre" : "year";

export interface Summary { total: number; shown: number; unknown: number }

/** total = songs before the chips, shown = songs after, unknown = songs the
 *  chips could not judge (no genre/year on file). */
export function summarise(facts: Fact[], s: Sel): Summary {
  let shown = 0, unknown = 0;
  for (const f of facts) {
    if (passes(f, s)) shown++;
    else if (unseen(f, s)) unknown++;
  }
  return { total: facts.length, shown, unknown };
}

/** The sentence under the result count. */
export function summaryText(sum: Summary, s: Sel, noun: "song" | "night" = "song"): string {
  const n = (x: number) => x.toLocaleString("en-GB");
  const base = `${n(sum.shown)} of ${n(sum.total)} ${noun}s`;
  if (!sum.unknown) return base;
  const one = sum.unknown === 1;
  return `${base} (${n(sum.unknown)} ${noun}${one ? "" : "s"} ${one ? "has" : "have"} no ${unknownWhat(s)} on file and ${one ? "is" : "are"} hidden by these filters)`;
}

// ------------------------------------------------------------------- facets

export type Counts = Map<string, number>;

const bump = (m: Counts, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Every value that exists at all, with its unfiltered count: families by count
 *  (largest first), decades oldest first. Fixes the chips' order and which exist. */
export function universe(facts: Fact[]): { families: Array<[string, number]>; decades: Array<[string, number]> } {
  const fam: Counts = new Map(), dec: Counts = new Map();
  for (const f of facts) { if (f.family) bump(fam, f.family); if (f.decade) bump(dec, f.decade); }
  return {
    families: [...fam].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    decades: [...dec].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

/** Faceted chip counts for songs: families counted under the decade selection,
 *  decades under the family selection. */
export function songFacets(facts: Fact[], s: Sel): { families: Counts; decades: Counts } {
  const families: Counts = new Map(), decades: Counts = new Map();
  for (const f of facts) {
    if (f.family && passes(f, { families: [], decades: s.decades })) bump(families, f.family);
    if (f.decade && passes(f, { families: s.families, decades: [] })) bump(decades, f.decade);
  }
  return { families, decades };
}

/** How much of a list enrichment knows (for the coverage note). */
export function coverage(facts: Fact[]) {
  let family = 0, decade = 0, either = 0;
  for (const f of facts) {
    if (f.family) family++;
    if (f.decade) decade++;
    if (f.family || f.decade) either++;
  }
  return { total: facts.length, family, decade, either };
}

// ------------------------------------------------------------------- nights

/** Does a night match? It needs at least NIGHT_MIN_SONGS songs, or NIGHT_MIN_SHARE
 *  of the songs it has data for, inside the selection. "Has data" means known on
 *  every selected row, so a night of year-only songs is not judged on genre.
 *  `judged` = 0 means the night could not be judged at all. */
export function nightMatch(facts: Fact[], s: Sel): { match: boolean; hits: number; judged: number } {
  let hits = 0, judged = 0;
  for (const f of facts) {
    if (unseen(f, s)) continue;
    judged++;
    if (passes(f, s)) hits++;
  }
  const match = hits >= 1 && (hits >= NIGHT_MIN_SONGS || hits >= NIGHT_MIN_SHARE * judged);
  return { match, hits, judged };
}

/** Which nights pass, and how many could not be judged for want of data. */
export function filterNights<T>(nights: Array<{ key: T; facts: Fact[] }>, s: Sel): { keep: Set<T>; unjudged: number } {
  const keep = new Set<T>();
  let unjudged = 0;
  for (const n of nights) {
    const r = nightMatch(n.facts, s);
    if (r.match) keep.add(n.key);
    else if (!r.judged) unjudged++;
  }
  return { keep, unjudged };
}

/** Faceted night counts: for each family, the nights that match if it alone were
 *  ticked in its row (decade selection kept), and likewise per decade. */
export function nightFacets(
  nights: Fact[][], s: Sel, values: { families: string[]; decades: string[] },
): { families: Counts; decades: Counts } {
  const families: Counts = new Map(), decades: Counts = new Map();
  for (const fam of values.families) {
    const sel = { families: [fam], decades: s.decades };
    let n = 0;
    for (const facts of nights) if (nightMatch(facts, sel).match) n++;
    families.set(fam, n);
  }
  for (const dec of values.decades) {
    const sel = { families: s.families, decades: [dec] };
    let n = 0;
    for (const facts of nights) if (nightMatch(facts, sel).match) n++;
    decades.set(dec, n);
  }
  return { families, decades };
}

/** "mostly rock, 1990s–2000s" for a night, or null when too little is known
 *  (under SOUND_MIN_KNOWN of its songs have a genre or year). The decades are
 *  the middle half of the dated songs, so one odd old track does not stretch it. */
export function nightSound(facts: Fact[], label: (f: string) => string = (f) => f): { text: string; known: number; total: number } | null {
  const total = facts.length;
  const known = facts.filter((f) => f.family || f.decade).length;
  if (!total || known / total < SOUND_MIN_KNOWN) return null;

  const parts: string[] = [];
  const fam: Counts = new Map();
  for (const f of facts) if (f.family) bump(fam, f.family);
  const famTotal = [...fam.values()].reduce((a, b) => a + b, 0);
  if (famTotal) {
    const [top, n] = [...fam].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const name = top === "other" ? "other genres" : label(top);
    parts.push(n / famTotal >= 0.5 ? `mostly ${name}` : `mixed, led by ${name}`);
  }
  const decs = facts.map((f) => f.decade).filter((d): d is string => !!d).sort();
  if (decs.length) {
    const lo = decs[Math.floor((decs.length - 1) * 0.25)];
    const hi = decs[Math.ceil((decs.length - 1) * 0.75)];
    parts.push(lo === hi ? lo : `${lo}–${hi}`);
  }
  return parts.length ? { text: parts.join(", "), known, total } : null;
}

/** A small stable number from a string (for the generated cover tile). */
export function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
