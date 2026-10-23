/** Everyone as a profile: when they were there, what they brought, how their sets
 *  changed. Pure (no React, no DOM) so tools/peoplestats.test.ts can run it.
 *
 *  The page is deliberately NOT a scoreboard. Nothing here orders people by a
 *  count: people are listed by when they first appeared, and every comparison is
 *  either within one person across their own years, or an overlap between two
 *  people's artists (symmetrical, so it can't say who is "more").
 *
 *  How the numbers are kept honest (each one has a test named after the mistake):
 *   - only tracks marked `played`, on a dated event. A named list and its
 *     anonymised twin are one playlist; the distiller marks one copy played.
 *   - an anonymised track with stripped tags takes its song from its twin.
 *   - a song is counted once per person per night, whatever versions or copies
 *     the files have. A played track with no song identity still counts as a
 *     play and as running time, but takes no part in song-level facts.
 *   - tracks with no person belong to nobody. They do count when asking whether
 *     a song was heard before, or whether anyone else brought it.
 *   - the library's first night has no "before", so nothing on it is called new
 *     or "first brought".
 *   - attendance is measured against the nights between a person's first and last,
 *     not against the whole decade.
 */
import type { Catalog } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { decadeOf, familyOf, matched, yearOf, type EnrichMap } from "./enrich.ts";
import { fmtDate, fmtSpan, plural } from "./format.ts";

// ------------------------------------------------------------------- types

export interface Night { id: string; date: string; year: number; idx: number }

interface NightSet {
  songs: Set<string>;   // distinct identified songs
  plays: number;        // identified songs + played tracks with no identity
  seconds: number;
  fresh: number;        // songs here for the first time in the library
  judged: number;       // songs the freshness question applies to (0 on the opening night)
}

interface SongFacts {
  id: string;
  title: string;
  artist: string;
  first: number;                          // earliest night index
  nights: Set<number>;                    // every night, by anyone
  bringers: Map<number, Set<string>>;     // night -> attributed people
  unattributed: boolean;                  // some play of it has no person
}

interface PersonFacts {
  id: string;
  name: string;
  colourIndex: number;                    // place in cat.people: the timeline's colour
  nights: number[];                       // attended night indices, ascending
  perNight: Map<number, NightSet>;
  songs: Set<string>;
  artistNights: Map<string, Set<number>>; // artist key -> nights they brought that artist
  plays: number;
}

export interface PeopleIndex {
  nights: Night[];
  nightIdx: Map<string, number>;
  yearsWithNights: number[];
  songs: Map<string, SongFacts>;
  artistPeople: Map<string, Set<string>>;
  artistUnattributed: Set<string>;
  artistName: Map<string, string>;
  persons: PersonFacts[];                 // in the order they first appeared
  byId: Map<string, PersonFacts>;
}

export interface Away { from: number; to: number; backIn: number }

export interface YearRow {
  year: number;
  nights: number;
  songsPerNight: number | null;
  newShare: number | null;
  avgSec: number | null;
  marks: { list?: "high" | "low"; fresh?: "high" | "low"; len?: "high" | "low" };
}

export interface Outlier { text: string; eventId?: string; songId?: string }

export interface Seed {
  songId: string; title: string; artist: string; firstEventId: string; firstDate: string;
  nightsAfter: number; others: number;
}

export interface Profile {
  id: string; name: string; colourIndex: number;
  nights: number; songs: number; plays: number;
  firstNight: Night | null; lastNight: Night | null;
  span: string;
  /** Nights that happened between their first and last, and how many of those they were at. */
  possible: number;
  attendedShare: number;
  line: string | null;
  away: Away[];
  awayText: string[];
  /** Every night in the library, in order, flagged for this person. */
  strip: Array<{ night: Night; there: boolean; inSpan: boolean }>;
  /** Artists they brought on 2+ nights (alphabetical; the page sizes them by nights). */
  returning: Array<{ id: string; name: string; nights: number }>;
  onlyTheirs: Array<{ id: string; name: string; songs: number }>;
  overlaps: Array<{ id: string; name: string; colourIndex: number; shared: number; union: number; share: number; ofMine: number; ofTheirs: number }>;
  firstBrought: Array<{ songId: string; title: string; artist: string; eventId: string; date: string }>;
  seeds: Seed[];
  yearly: YearRow[];
  readings: string[];
  outliers: Outlier[];
}

// ------------------------------------------------------------------ helpers

const artistKey = (songId: string) => songId.split("|")[0];
const yearOfDate = (d: string) => Number(d.slice(0, 4));
const dayNumber = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);

/** "2021" or "2021–22" for the stretch from..to. */
const yearRange = (from: number, to: number) => (from === to ? `${from}` : `${from}–${to}`);

// -------------------------------------------------------------------- index

const indexCache = new WeakMap<Catalog, PeopleIndex>();

/** One pass over the catalogue's tracks; every profile reads from this. */
export function peopleIndex(cat: Catalog): PeopleIndex {
  const hit = indexCache.get(cat);
  if (hit) return hit;
  const cix = catalogIndex(cat);

  const nights: Night[] = cat.events
    .filter((e) => e.kind === "event" && !!e.date)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id))
    .map((e, idx) => ({ id: e.id, date: e.date!, year: yearOfDate(e.date!), idx }));
  const nightIdx = new Map(nights.map((n) => [n.id, n.idx]));
  const yearsWithNights = [...new Set(nights.map((n) => n.year))].sort((a, b) => a - b);

  // Pass 1: collapse the played tracks to one occurrence per person, night and song.
  interface Occ { person: string | null; n: number; song: string | null; sec: number }
  const occs: Occ[] = [];
  const seen = new Set<string>();
  const personKnown = new Set(cat.people.map((p) => p.id));
  for (const t of cat.tracks) {
    if (!t.played) continue;
    const n = nightIdx.get(t.eventId);
    if (n === undefined) continue;
    const song = t.songId ?? (t.twinId ? cix.track.get(t.twinId)?.songId ?? null : null);
    const person = t.personId && personKnown.has(t.personId) ? t.personId : null;
    if (song) {
      const key = `${person ?? "?"}|${n}|${song}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    occs.push({ person, n, song, sec: t.durationSec ?? 0 });
  }

  const songs = new Map<string, SongFacts>();
  const artistPeople = new Map<string, Set<string>>();
  const artistUnattributed = new Set<string>();
  for (const o of occs) {
    if (!o.song) continue;
    let s = songs.get(o.song);
    if (!s) {
      const rec = cix.song.get(o.song);
      s = {
        id: o.song, title: rec?.title ?? o.song, artist: rec?.artist ?? artistKey(o.song),
        first: o.n, nights: new Set(), bringers: new Map(), unattributed: false,
      };
      songs.set(o.song, s);
    }
    if (o.n < s.first) s.first = o.n;
    s.nights.add(o.n);
    const a = artistKey(o.song);
    if (o.person) {
      let b = s.bringers.get(o.n);
      if (!b) s.bringers.set(o.n, (b = new Set()));
      b.add(o.person);
      let ap = artistPeople.get(a);
      if (!ap) artistPeople.set(a, (ap = new Set()));
      ap.add(o.person);
    } else {
      s.unattributed = true;
      artistUnattributed.add(a);
    }
  }
  const artistName = new Map<string, string>();
  for (const s of songs.values()) {
    const a = artistKey(s.id);
    if (!artistName.has(a)) artistName.set(a, cix.artist.get(a)?.name ?? s.artist);
  }

  // Pass 2: per person.
  const facts = new Map<string, PersonFacts>(cat.people.map((p, i) => [p.id, {
    id: p.id, name: p.name, colourIndex: i, nights: [], perNight: new Map(),
    songs: new Set(), artistNights: new Map(), plays: 0,
  }]));
  for (const o of occs) {
    if (!o.person) continue;
    const p = facts.get(o.person)!;
    let ns = p.perNight.get(o.n);
    if (!ns) p.perNight.set(o.n, (ns = { songs: new Set(), plays: 0, seconds: 0, fresh: 0, judged: 0 }));
    ns.plays++; p.plays++;
    ns.seconds += o.sec;
    if (!o.song) continue;
    ns.songs.add(o.song);
    p.songs.add(o.song);
    const a = artistKey(o.song);
    let an = p.artistNights.get(a);
    if (!an) p.artistNights.set(a, (an = new Set()));
    an.add(o.n);
    if (o.n > 0) {
      ns.judged++;
      if (songs.get(o.song)!.first === o.n) ns.fresh++;
    }
  }
  for (const p of facts.values()) p.nights = [...p.perNight.keys()].sort((a, b) => a - b);

  const persons = [...facts.values()].sort((a, b) => {
    const fa = a.nights.length ? a.nights[0] : Infinity, fb = b.nights.length ? b.nights[0] : Infinity;
    return fa === fb ? a.name.localeCompare(b.name) : fa < fb ? -1 : 1;
  });
  const ix: PeopleIndex = {
    nights, nightIdx, yearsWithNights, songs, artistPeople, artistUnattributed, artistName,
    persons, byId: facts,
  };
  indexCache.set(cat, ix);
  return ix;
}

// -------------------------------------------------------------- collective

export interface Collective {
  people: number;
  nights: number;
  /** Nights by how many people were there. sizes[n] = nights with n people. */
  sizes: number[];
  /** Per year, the group size of each of its nights, in date order. */
  byYear: Array<{ year: number; sizes: number[] }>;
  maxSize: number;
}

const collectiveCache = new WeakMap<Catalog, Collective>();

export function collective(cat: Catalog): Collective {
  const hit = collectiveCache.get(cat);
  if (hit) return hit;
  const ix = peopleIndex(cat);
  const per = new Array<number>(ix.nights.length).fill(0);
  for (const p of ix.persons) for (const n of p.nights) per[n]++;
  const maxSize = per.reduce((m, v) => Math.max(m, v), 0);
  const sizes = new Array<number>(maxSize + 1).fill(0);
  for (const v of per) sizes[v]++;
  const byYear = ix.yearsWithNights.map((year) => ({
    year, sizes: ix.nights.filter((n) => n.year === year).map((n) => per[n.idx]),
  }));
  const out = { people: ix.persons.filter((p) => p.nights.length > 0).length, nights: ix.nights.length, sizes, byYear, maxSize };
  collectiveCache.set(cat, out);
  return out;
}

// ----------------------------------------------------------------- breaks

/** Whole calendar years, with nights, that a person missed between their first and
 *  last night, grouped into stretches. A year in which nobody met is not a break. */
export function awayStretches(yearsWithNights: number[], attendedYears: Set<number>): Away[] {
  if (!attendedYears.size) return [];
  const lo = Math.min(...attendedYears), hi = Math.max(...attendedYears);
  const inSpan = yearsWithNights.filter((y) => y >= lo && y <= hi);
  const out: Away[] = [];
  let cur: Away | null = null;
  for (const y of inSpan) {
    if (attendedYears.has(y)) {
      if (cur) { cur.backIn = y; out.push(cur); cur = null; }
    } else if (cur) cur.to = y;
    else cur = { from: y, to: y, backIn: y };
  }
  return out;
}

export const awayPhrase = (a: Away) =>
  a.from === a.to ? `away in ${a.from}, back in ${a.backIn}` : `away ${yearRange(a.from, a.to)}, back in ${a.backIn}`;

// ------------------------------------------------------ the descriptive line

/** The one neutral line on a card. First rule that is true wins; none is a
 *  superlative and none compares a person with another. Rules, in order:
 *   1. one night, or every night in one calendar year -> "a presence in 2016"
 *   2. first night is after the library's first year   -> "joined in 2023"
 *   3. two or more full-year breaks                    -> "returns after long breaks"
 *   4. exactly one full-year break                     -> "back in 2021 after time away"
 *   5. 10+ artists nobody else ever brought, and they are three quarters or more
 *      of the artists they have brought               -> "brings music nobody else does"
 *   6. was at the library's first night                -> "there from the start"
 *   7. otherwise                                       -> "there in 6 of the 11 years"
 *  No nights at all gives null. */
export function describe(c: {
  nights: number; firstYear: number | null; lastYear: number | null; libraryFirstYear: number | null;
  attendedOpening: boolean; away: Away[]; onlyTheirsArtists: number; artists: number;
  yearsPresent: number; yearsInSpan: number;
}): string | null {
  if (c.nights === 0 || c.firstYear === null) return null;
  if (c.nights === 1 || c.firstYear === c.lastYear) return `a presence in ${c.firstYear}`;
  if (c.libraryFirstYear !== null && c.firstYear > c.libraryFirstYear) return `joined in ${c.firstYear}`;
  if (c.away.length >= 2) return "returns after long breaks";
  if (c.away.length === 1) return `back in ${c.away[0].backIn} after time away`;
  if (c.onlyTheirsArtists >= 10 && c.onlyTheirsArtists * 4 >= c.artists * 3) return "brings music nobody else does";
  if (c.attendedOpening) return "there from the start";
  return `there in ${c.yearsPresent} of the ${c.yearsInSpan} years`;
}

// ---------------------------------------------------------------- profiles

const profileCache = new WeakMap<Catalog, Map<string, Profile>>();

export function profileOf(cat: Catalog, id: string): Profile | null {
  const ix = peopleIndex(cat);
  let m = profileCache.get(cat);
  if (!m) profileCache.set(cat, (m = new Map()));
  const hit = m.get(id);
  if (hit) return hit;
  const p = ix.byId.get(id);
  if (!p) return null;
  const prof = build(cat, ix, p);
  m.set(id, prof);
  return prof;
}

const longDate = (n: Night) => fmtDate(n.date);

function build(cat: Catalog, ix: PeopleIndex, p: PersonFacts): Profile {
  const first = p.nights.length ? ix.nights[p.nights[0]] : null;
  const last = p.nights.length ? ix.nights[p.nights[p.nights.length - 1]] : null;
  const attendedSet = new Set(p.nights);
  const possible = first && last ? last.idx - first.idx + 1 : 0;
  const attendedYears = new Set(p.nights.map((n) => ix.nights[n].year));
  const away = awayStretches(ix.yearsWithNights, attendedYears);
  const yearsInSpan = first && last ? ix.yearsWithNights.filter((y) => y >= first.year && y <= last.year).length : 0;

  const onlyTheirsArtists = [...p.artistNights.keys()].filter((a) =>
    ix.artistPeople.get(a)?.size === 1 && !ix.artistUnattributed.has(a));
  const line = describe({
    nights: p.nights.length, firstYear: first?.year ?? null, lastYear: last?.year ?? null,
    libraryFirstYear: ix.nights[0]?.year ?? null, attendedOpening: attendedSet.has(0),
    away, onlyTheirsArtists: onlyTheirsArtists.length, artists: p.artistNights.size,
    yearsPresent: attendedYears.size, yearsInSpan,
  });

  // taste
  const returning = [...p.artistNights.entries()].filter(([, ns]) => ns.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 30)
    .map(([a, ns]) => ({ id: a, name: ix.artistName.get(a) ?? a, nights: ns.size }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const songsByArtist = new Map<string, number>();
  for (const s of p.songs) songsByArtist.set(artistKey(s), (songsByArtist.get(artistKey(s)) ?? 0) + 1);
  const onlyTheirs = onlyTheirsArtists
    .map((a) => ({ id: a, name: ix.artistName.get(a) ?? a, songs: songsByArtist.get(a) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const mine = new Set(p.artistNights.keys());
  const overlaps: Profile["overlaps"] = [];
  for (const q of ix.persons) {
    if (q.id === p.id || !q.artistNights.size || !mine.size) continue;
    let shared = 0;
    for (const a of mine) if (q.artistNights.has(a)) shared++;
    if (shared < 3) continue;   // one or two artists in common is chance, not a shape
    const union = mine.size + q.artistNights.size - shared;
    overlaps.push({ id: q.id, name: q.name, colourIndex: q.colourIndex, shared, union, share: safeDiv(shared, union), ofMine: safeDiv(shared, mine.size), ofTheirs: safeDiv(shared, q.artistNights.size) });
  }
  // the four closest overlaps, shown in join order (not as a ranking)
  const order = new Map(ix.persons.map((q, i) => [q.id, i]));
  const closest = overlaps.sort((a, b) => b.share - a.share || a.name.localeCompare(b.name)).slice(0, 4)
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  // first brought, and the seeds that grew
  const fb: Profile["firstBrought"] = [];
  const seeds: Seed[] = [];
  for (const sid of p.songs) {
    const s = ix.songs.get(sid)!;
    if (s.first === 0 || !p.perNight.get(s.first)?.songs.has(sid)) continue;
    const night = ix.nights[s.first];
    fb.push({ songId: sid, title: s.title, artist: s.artist, eventId: night.id, date: night.date });
    const nightsAfter = s.nights.size - 1;
    if (nightsAfter >= 3) {
      const carriers = new Set<string>();
      for (const [n, who] of s.bringers) if (n > s.first) for (const w of who) if (w !== p.id) carriers.add(w);
      seeds.push({ songId: sid, title: s.title, artist: s.artist, firstEventId: night.id, firstDate: night.date, nightsAfter, others: carriers.size });
    }
  }
  const byNewest = (a: { eventId: string; title: string }, b: { eventId: string; title: string }) =>
    ix.nightIdx.get(b.eventId)! - ix.nightIdx.get(a.eventId)! || a.title.localeCompare(b.title);
  fb.sort(byNewest);
  seeds.sort((a, b) => byNewest({ eventId: a.firstEventId, title: a.title }, { eventId: b.firstEventId, title: b.title }));

  const { yearly, readings } = yearlyShape(ix, p);

  return {
    id: p.id, name: p.name, colourIndex: p.colourIndex,
    nights: p.nights.length, songs: p.songs.size, plays: p.plays,
    firstNight: first, lastNight: last,
    span: !first || !last ? "no nights on record" : first.year === last.year ? `only ${first.year}` : `${first.year} – ${last.year}`,
    possible, attendedShare: safeDiv(p.nights.length, possible),
    line, away, awayText: away.map(awayPhrase),
    strip: ix.nights.map((night) => ({
      night, there: attendedSet.has(night.idx),
      inSpan: !!first && !!last && night.idx >= first.idx && night.idx <= last.idx,
    })),
    returning, onlyTheirs, overlaps: closest,
    firstBrought: fb, seeds,
    yearly, readings,
    outliers: outliersOf(cat, ix, p, first),
  };
}

// ---------------------------------------------------------- how sets change

function yearlyShape(ix: PeopleIndex, p: PersonFacts): { yearly: YearRow[]; readings: string[] } {
  if (!p.nights.length) return { yearly: [], readings: [] };
  const lo = ix.nights[p.nights[0]].year, hi = ix.nights[p.nights[p.nights.length - 1]].year;
  const yearly: YearRow[] = [];
  for (const year of ix.yearsWithNights) {
    if (year < lo || year > hi) continue;
    const ns = p.nights.filter((n) => ix.nights[n].year === year);
    let plays = 0, sec = 0, fresh = 0, judged = 0, timed = 0;
    for (const n of ns) {
      const s = p.perNight.get(n)!;
      plays += s.plays; sec += s.seconds; fresh += s.fresh; judged += s.judged;
      if (s.seconds > 0) timed += s.plays;
    }
    yearly.push({
      year, nights: ns.length,
      songsPerNight: ns.length ? plays / ns.length : null,
      newShare: judged > 0 ? fresh / judged : null,
      avgSec: timed > 0 ? sec / timed : null,
      marks: {},
    });
  }

  const readings: string[] = [];
  const metrics: Array<{ key: keyof YearRow["marks"]; get: (r: YearRow) => number | null; margin: (top: number, other: number) => boolean;
    high: string; low: string }> = [
    { key: "list", get: (r) => r.songsPerNight, margin: (a, b) => a >= b * 1.2 || a * 1.2 <= b, high: "longer sets than any other year of theirs", low: "shorter sets than any other year of theirs" },
    { key: "fresh", get: (r) => r.newShare, margin: (a, b) => Math.abs(a - b) >= 0.1, high: "more new music than any other year of theirs", low: "less new music than any other year of theirs" },
    { key: "len", get: (r) => r.avgSec, margin: (a, b) => a >= b * 1.15 || a * 1.15 <= b, high: "longer tracks than any other year of theirs", low: "shorter tracks than any other year of theirs" },
  ];
  for (const m of metrics) {
    const rows = yearly.filter((r) => m.get(r) !== null);
    if (rows.length < 3) continue;
    // a year is only called out when it clearly clears every other year, and
    // rests on 2+ nights (a single night is too thin to call a year's habit)
    for (const dir of ["high", "low"] as const) {
      const sorted = [...rows].sort((a, b) => (dir === "high" ? m.get(b)! - m.get(a)! : m.get(a)! - m.get(b)!));
      const top = sorted[0], next = sorted[1];
      if (top.nights < 2 || m.get(top) === m.get(next) || !m.margin(m.get(top)!, m.get(next)!)) continue;
      top.marks[m.key] = dir;
      readings.push(`${top.year}: ${dir === "high" ? m.high : m.low}`);
    }
  }
  readings.sort();
  return { yearly, readings };
}

// ------------------------------------------------------------------ outliers

function gapPhrase(days: number) {
  const months = Math.round(days / 30.4);
  return months < 24 ? `about ${months} months` : `about ${Math.round(days / 365.25)} years`;
}

function outliersOf(cat: Catalog, ix: PeopleIndex, p: PersonFacts, first: Night | null): Outlier[] {
  const out: Outlier[] = [];
  if (p.nights.length < 2 || !first) return out;

  // the night with the most songs heard here for the first time
  let bestFresh: { n: number; fresh: number } | null = null;
  for (const n of p.nights) {
    const f = p.perNight.get(n)!.fresh;
    if (f >= 3 && (!bestFresh || f > bestFresh.fresh)) bestFresh = { n, fresh: f };
  }
  if (bestFresh) {
    const nt = ix.nights[bestFresh.n];
    out.push({ eventId: nt.id, text: `${longDate(nt)}: ${plural(bestFresh.fresh, "song")} heard in the library for the first time, the most new music in a single night of theirs.` });
  }

  // the longest set
  let longest: { n: number; sec: number } | null = null;
  for (const n of p.nights) {
    const s = p.perNight.get(n)!.seconds;
    if (s > 0 && (!longest || s > longest.sec)) longest = { n, sec: s };
  }
  if (longest) {
    const nt = ix.nights[longest.n];
    out.push({ eventId: nt.id, text: `${longDate(nt)}: their longest set, ${fmtSpan(longest.sec)} across ${plural(p.perNight.get(longest.n)!.plays, "song")}.` });
  }

  // the longest gap before a comeback, with nights happening in between
  let gap: { from: number; to: number; days: number } | null = null;
  for (let i = 1; i < p.nights.length; i++) {
    const a = p.nights[i - 1], b = p.nights[i];
    if (b - a < 2) continue;                      // nothing happened in between
    const days = dayNumber(ix.nights[b].date) - dayNumber(ix.nights[a].date);
    if (days >= 180 && (!gap || days > gap.days)) gap = { from: a, to: b, days };
  }
  if (gap) {
    const back = ix.nights[gap.to];
    out.push({ eventId: back.id, text: `${longDate(back)}: back after ${gapPhrase(gap.days)} away, the longest stretch in which nights happened without them.` });
  }

  // a song nobody else ever brought that came back on several of their nights
  let kept: SongFacts | null = null;
  for (const sid of p.songs) {
    const s = ix.songs.get(sid)!;
    if (s.unattributed || s.nights.size < 3) continue;
    const only = [...s.bringers.values()].every((w) => w.size === 1 && w.has(p.id));
    if (only && (!kept || s.nights.size > kept.nights.size || (s.nights.size === kept.nights.size && s.first < kept.first))) kept = s;
  }
  if (kept) out.push({ songId: kept.id, text: `${kept.title} by ${kept.artist}: nobody else has brought it, and it has come back on ${kept.nights.size} nights.` });
  return out;
}

// ----------------------------------------------- decade and genre (enriched)

export interface MusicProfile {
  total: number;
  withYear: number;
  withFamily: number;
  decades: Array<{ decade: string; songs: number }>;
  families: Array<{ family: string; songs: number }>;
}

/** Null when public-database facts cover under 30% of the person's songs: a
 *  chart of the few songs that happen to match would say little about the rest. */
export function musicProfile(cat: Catalog, id: string, enrich: EnrichMap | null): MusicProfile | null {
  const p = peopleIndex(cat).byId.get(id);
  if (!p || !enrich || !p.songs.size) return null;
  const dec = new Map<string, number>(), fam = new Map<string, number>();
  let known = 0, withYear = 0, withFamily = 0;
  for (const sid of p.songs) {
    const r = enrich[sid];
    if (!matched(r)) continue;
    known++;
    const d = decadeOf(yearOf(r));
    if (d) { withYear++; dec.set(d, (dec.get(d) ?? 0) + 1); }
    const f = familyOf(r);
    if (f) { withFamily++; fam.set(f, (fam.get(f) ?? 0) + 1); }
  }
  if (known < p.songs.size * 0.3) return null;
  return {
    total: p.songs.size, withYear, withFamily,
    decades: [...dec.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([decade, songs]) => ({ decade, songs })),
    // chips in alphabetical order: the size shows the share, the order says nothing
    families: [...fam.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([family, songs]) => ({ family, songs })),
  };
}

// ------------------------------------------------------------ copy summary

export function summaryText(cat: Catalog, id: string, enrich: EnrichMap | null): string {
  const pr = profileOf(cat, id);
  if (!pr) return "";
  const lines = [`${pr.name} (${pr.span})`];
  if (pr.line) lines.push(pr.line);
  if (!pr.nights) { lines.push("No nights on record."); return lines.join("\n"); }
  lines.push(`${plural(pr.nights, "night")}${pr.possible > 1 ? ` of the ${pr.possible} that happened in their span` : ""}, ${plural(pr.songs, "song")}.`);
  if (pr.firstNight) lines.push(`Joined at ${longDate(pr.firstNight)}.`);
  for (const a of pr.awayText) lines.push(a[0].toUpperCase() + a.slice(1) + ".");
  if (pr.returning.length) lines.push(`Comes back to: ${[...pr.returning].sort((a, b) => b.nights - a.nights).slice(0, 8).map((a) => a.name).join(", ")}.`);
  if (pr.firstBrought.length) lines.push(`First brought to the library: ${plural(pr.firstBrought.length, "song")}.`);
  if (pr.seeds.length) lines.push(`Seeds that grew: ${pr.seeds.slice(0, 5).map((s) => `${s.title} (${s.artist})`).join("; ")}.`);
  for (const r of pr.readings) lines.push(r + ".");
  for (const o of pr.outliers) lines.push(o.text);
  const mp = musicProfile(cat, id, enrich);
  if (mp) lines.push(`Decades: ${mp.decades.map((d) => `${d.decade} ${d.songs}`).join(", ")} (known for ${mp.withYear} of ${mp.total} songs).`);
  return lines.join("\n");
}

// ----------------------------------------------------------------- gallery

export interface Card {
  id: string; name: string; colourIndex: number; span: string;
  nights: number; songs: number; line: string | null;
}

/** Cards in the order people first appeared (ties by name). */
export function galleryCards(cat: Catalog): Card[] {
  const ix = peopleIndex(cat);
  return ix.persons.map((p) => {
    const pr = profileOf(cat, p.id)!;
    return { id: p.id, name: p.name, colourIndex: p.colourIndex, span: pr.span, nights: pr.nights, songs: pr.songs, line: pr.line };
  });
}

/** Neighbours in join order, wrapping round. */
export function neighbours(cat: Catalog, id: string): { prev: Card | null; next: Card | null } {
  const cards = galleryCards(cat);
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0 || cards.length < 2) return { prev: null, next: null };
  return { prev: cards[(i - 1 + cards.length) % cards.length], next: cards[(i + 1) % cards.length] };
}
