/** Group-level views of the people, pure (no React) so tools/peopleinsights.test.ts
 *  can run it. Built on peopleIndex (peoplestats.ts), which already settles the
 *  counting rules: songs once per person per night, twins and copies not doubled,
 *  tracks with no person belong to nobody, the opening night has no "new".
 *
 *  Tone: nothing here ranks anyone. People are listed in the order they first
 *  appeared, overlaps are symmetric, and shapes are compared on shared scales.
 *
 *  `ids` is the set of night ids inside the Insights range (null = every night).
 *  "First brought" is always decided on the whole history; only the nights
 *  counted are limited to the range. */
import type { PeopleIndex } from "./peoplestats.ts";

const artistKey = (songId: string) => songId.split("|")[0];
const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export interface Scoped {
  /** Night indices (into ix.nights) inside the range, ascending. */
  nights: number[];
  years: number[];
  nightsPerYear: number[];
  inScope: Set<number>;
  /** People with at least one night in range, in joining order, with those nights. */
  people: Array<{ id: string; name: string; colourIndex: number; nights: number[] }>;
}

export function scope(ix: PeopleIndex, ids: Set<string> | null): Scoped {
  const nights = ix.nights.filter((n) => !ids || ids.has(n.id)).map((n) => n.idx);
  const inScope = new Set(nights);
  const years = [...new Set(nights.map((i) => ix.nights[i].year))].sort((a, b) => a - b);
  const nightsPerYear = years.map((y) => nights.filter((i) => ix.nights[i].year === y).length);
  const people = ix.persons
    .map((p) => ({ id: p.id, name: p.name, colourIndex: p.colourIndex, nights: p.nights.filter((n) => inScope.has(n)) }))
    .filter((p) => p.nights.length > 0);
  return { nights, years, nightsPerYear, inScope, people };
}

// ------------------------------------------------------------ who was there

export interface Attendance {
  people: Scoped["people"];
  years: number[];
  nightsPerYear: number[];
  /** share[p][y] = that person's nights in the year / all nights of the year.
   *  null = before their first or after their last year (not part of their span). */
  share: Array<Array<number | null>>;
  counts: number[][];
  firstYear: number[];
  lastYear: number[];
}

export function attendance(ix: PeopleIndex, ids: Set<string> | null): Attendance {
  const sc = scope(ix, ids);
  const firstYear = sc.people.map((p) => ix.nights[p.nights[0]].year);
  const lastYear = sc.people.map((p) => ix.nights[p.nights[p.nights.length - 1]].year);
  const counts = sc.people.map((p) => sc.years.map((y) => p.nights.filter((n) => ix.nights[n].year === y).length));
  const share = sc.people.map((_, i) => sc.years.map((y, j) =>
    y < firstYear[i] || y > lastYear[i] ? null : safeDiv(counts[i][j], sc.nightsPerYear[j])));
  return { people: sc.people, years: sc.years, nightsPerYear: sc.nightsPerYear, share, counts, firstYear, lastYear };
}

// --------------------------------------------------------------- group size

export interface GroupSize {
  nights: number;
  /** sizes[n] = nights with n people, n = 0..max. */
  sizes: number[];
  perYear: Array<{ year: number; nights: number; avg: number | null }>;
  /** The narrowest run of sizes that covers at least half the nights. */
  common: { from: number; to: number; nights: number } | null;
}

export function groupSize(ix: PeopleIndex, ids: Set<string> | null): GroupSize {
  const sc = scope(ix, ids);
  const per = new Map<number, number>(sc.nights.map((n) => [n, 0]));
  for (const p of sc.people) for (const n of p.nights) per.set(n, per.get(n)! + 1);
  const max = Math.max(0, ...per.values());
  const sizes = new Array<number>(max + 1).fill(0);
  for (const v of per.values()) sizes[v]++;
  const perYear = sc.years.map((year) => {
    const v = sc.nights.filter((n) => ix.nights[n].year === year).map((n) => per.get(n)!);
    return { year, nights: v.length, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null };
  });
  return { nights: sc.nights.length, sizes, perYear, common: commonRun(sizes, sc.nights.length) };
}

/** Narrowest [from, to] holding >= half the nights; ties go to the busier run. */
export function commonRun(sizes: number[], total: number) {
  if (total === 0) return null;
  let best: { from: number; to: number; nights: number } | null = null;
  for (let a = 0; a < sizes.length; a++) {
    let sum = 0;
    for (let b = a; b < sizes.length; b++) {
      sum += sizes[b];
      if (sum * 2 >= total) {
        if (!best || b - a < best.to - best.from || (b - a === best.to - best.from && sum > best.nights)) best = { from: a, to: b, nights: sum };
        break;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------ joins / returns

export interface YearChange { year: number; joined: string[]; away: string[]; back: string[] }

/** Per year: who attended for the first time, who was absent although they came
 *  both before and after, and who came back after missing the previous year. */
export function changes(ix: PeopleIndex, ids: Set<string> | null): YearChange[] {
  const a = attendance(ix, ids);
  return a.years.map((year, j) => {
    const out: YearChange = { year, joined: [], away: [], back: [] };
    a.people.forEach((p, i) => {
      const here = a.counts[i][j] > 0;
      if (here && a.firstYear[i] === year) out.joined.push(p.name);
      else if (!here && a.firstYear[i] < year && a.lastYear[i] > year) out.away.push(p.name);
      else if (here && j > 0 && a.counts[i][j - 1] === 0 && a.firstYear[i] < year) out.back.push(p.name);
    });
    return out;
  });
}

// ----------------------------------------------------------- taste overlap

export interface Overlap {
  people: Scoped["people"];
  /** Artist keys each person brought on a night in range (unattributed tracks are nobody's). */
  artists: Array<Set<string>>;
  /** Jaccard: shared / either. Symmetric; null on the diagonal and where neither has any artist. */
  jaccard: Array<Array<number | null>>;
  shared: number[][];
  /** Library split by how many people brought each artist. */
  split: { one: number; two: number; three: number; total: number };
  name: (artist: string) => string;
}

export function overlap(ix: PeopleIndex, ids: Set<string> | null): Overlap {
  const sc = scope(ix, ids);
  const artists = sc.people.map((p) => {
    const set = new Set<string>();
    for (const [a, ns] of ix.byId.get(p.id)!.artistNights) if ([...ns].some((n) => sc.inScope.has(n))) set.add(a);
    return set;
  });
  const n = sc.people.length;
  const shared = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const jaccard: Array<Array<number | null>> = Array.from({ length: n }, () => new Array<number | null>(n).fill(null));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    for (const a of artists[i]) if (artists[j].has(a)) s++;
    shared[i][j] = s;
    if (i !== j) jaccard[i][j] = safeDiv(s, artists[i].size + artists[j].size - s);
  }
  const count = new Map<string, number>();
  for (const set of artists) for (const a of set) count.set(a, (count.get(a) ?? 0) + 1);
  const split = { one: 0, two: 0, three: 0, total: count.size };
  for (const c of count.values()) { if (c === 1) split.one++; else if (c === 2) split.two++; else split.three++; }
  return { people: sc.people, artists, jaccard, shared, split, name: (a) => ix.artistName.get(a) ?? a };
}

/** Artists both people brought, alphabetical. */
export function sharedArtists(o: Overlap, i: number, j: number): Array<{ id: string; name: string }> {
  if (i === j || !o.artists[i] || !o.artists[j]) return [];
  return [...o.artists[i]].filter((a) => o.artists[j].has(a))
    .map((id) => ({ id, name: o.name(id) })).sort((x, y) => x.name.localeCompare(y.name));
}

// -------------------------------------------------------------- set shapes

export interface Shape {
  id: string; name: string; colourIndex: number;
  /** Per year in `years`: mean songs on the nights they brought something; null if none. */
  songsPerNight: Array<number | null>;
  /** Per year: share of their songs new to the library; null if nothing to judge (or only the opening night). */
  newShare: Array<number | null>;
  nights: number;
}

export function shapes(ix: PeopleIndex, ids: Set<string> | null): { years: number[]; shapes: Shape[]; maxSongs: number } {
  const sc = scope(ix, ids);
  const list = sc.people.map((p): Shape => {
    const f = ix.byId.get(p.id)!;
    const songsPerNight: Array<number | null> = [], newShare: Array<number | null> = [];
    for (const y of sc.years) {
      const ns = p.nights.filter((n) => ix.nights[n].year === y).map((n) => f.perNight.get(n)!);
      songsPerNight.push(ns.length ? ns.reduce((a, s) => a + s.songs.size, 0) / ns.length : null);
      const judged = ns.reduce((a, s) => a + s.judged, 0);
      newShare.push(safeDiv(ns.reduce((a, s) => a + s.fresh, 0), judged));
    }
    return { id: p.id, name: p.name, colourIndex: p.colourIndex, songsPerNight, newShare, nights: p.nights.length };
  });
  const maxSongs = Math.max(0, ...list.flatMap((s) => s.songsPerNight.filter((v): v is number => v !== null)));
  return { years: sc.years, shapes: list, maxSongs };
}

// ------------------------------------------------------------ handing on

export interface Handing {
  people: Scoped["people"];
  /** counts[first][later] = songs first brought by `first` that `later` brought on a later night. */
  counts: number[][];
  songs: Map<string, Array<{ id: string; title: string; artist: string }>>;
  /** Songs whose first night (not the opening night) had a known bringer, and how many were brought on by someone else. */
  considered: number;
  passed: number;
}

export function handing(ix: PeopleIndex, ids: Set<string> | null): Handing {
  const sc = scope(ix, ids);
  const pos = new Map(sc.people.map((p, i) => [p.id, i]));
  const n = sc.people.length;
  const counts = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const songs = new Map<string, Array<{ id: string; title: string; artist: string }>>();
  let considered = 0, passed = 0;
  for (const s of ix.songs.values()) {
    if (s.first === 0 || !sc.inScope.has(s.first)) continue;   // the opening night has no "first"
    const firsts = [...(s.bringers.get(s.first) ?? [])].filter((id) => pos.has(id));
    if (!firsts.length) continue;                               // first heard from nobody's list
    considered++;
    const later = new Set<string>();
    for (const [night, who] of s.bringers) {
      if (night <= s.first || !sc.inScope.has(night)) continue;
      for (const q of who) if (pos.has(q) && !firsts.includes(q)) later.add(q);
    }
    if (later.size) passed++;
    for (const f of firsts) for (const q of later) {
      counts[pos.get(f)!][pos.get(q)!]++;
      const k = `${pos.get(f)}|${pos.get(q)}`;
      let l = songs.get(k);
      if (!l) songs.set(k, (l = []));
      l.push({ id: s.id, title: s.title, artist: s.artist });
    }
  }
  for (const l of songs.values()) l.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  return { people: sc.people, counts, songs, considered, passed };
}

export { artistKey };
