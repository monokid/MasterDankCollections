/** What the library knows about one song, or one artist, as a history: when it
 *  was first and last brought, by whom, how often, where in a set it lands.
 *  Pure: no React, no DOM, so tools/songstats.test.ts can run it.
 *
 *  What counts as "a play" (the rules every number below rests on):
 *   - only tracks marked `played`, on a night that is a dated event. Collections
 *     (favs, mix, Albums...) are shelves, not nights, and are reported apart;
 *   - a person's anonymised list and its named twin are one playlist, so a song
 *     is counted once per person per night however many copies carry it;
 *   - two people bringing the same song to the same night is 2 plays, 1 night;
 *   - an anonymised track with stripped tags takes its identity from its twin.
 *  "Now" is the newest night in the library, not today's date, so "5 months
 *  since the last play" stays true however long the library sits unrefreshed. */
import type { Catalog, PhaseBucket, Track } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { plural } from "./format.ts";

// ------------------------------------------------------------------ types

export interface Occurrence {
  date: string;
  eventId: string;
  /** Kinds of night: roll, trip, candyflip... */
  types: string[];
  personId: string | null;
  person: string | null;
  /** The phase folder's cleaned name, and the bucket it falls in. */
  phase: string | null;
  bucket: PhaseBucket | null;
  playOrder: number | null;
  trackId: string;
  songId: string;
  title: string | null;
  variant: string | null;
  anon: boolean;
}

/** An occurrence plus everyone who brought this thing that same night. */
export interface Mark extends Occurrence { nightPeople: string[] }

export interface PersonCount {
  personId: string | null;
  name: string;
  /** Position in `cat.people`: the colour the timeline lanes use. -1 when unknown. */
  index: number;
  plays: number;
  nights: number;
  first: string;
  last: string;
}

export interface YearBar { year: string; plays: number; nights: number }

export interface Gap { days: number; from: string; to: string; label: string }

export type PhaseDist = Record<PhaseBucket, number> & {
  /** Occurrences that have a phase at all. */
  total: number;
  /** The bucket with strictly the most, or null on a tie / no data. */
  dominant: PhaseBucket | null;
  dominantShare: number;
};

export type Verdict = "never" | "one-off" | "twice" | "regular" | "staple" | "comeback";

export interface Signature { personId: string; name: string; share: number; plays: number }

export interface Stats {
  plays: number;
  nights: number;
  people: PersonCount[];
  /** Plays by someone we could not identify. */
  unknownPlays: number;
  first: Mark | null;
  last: Mark | null;
  nightList: Array<{ date: string; eventId: string }>;
  years: YearBar[];
  phases: PhaseDist;
  longestGap: Gap | null;
  /** From the last play to the newest night in the library. */
  sinceLast: { days: number; label: string } | null;
  /** The newest night in the library: the "now" for every gap. */
  asOf: string | null;
  verdict: Verdict;
  /** Brought within a year of the newest night. */
  recent: boolean;
  /** One person accounts for 80% or more of 3+ plays. */
  signature: Signature | null;
  /** Every occurrence, newest night first (running order within a night). */
  occurrences: Occurrence[];
}

export interface VariantStat {
  /** null is the plain, unmarked version. */
  variant: string | null;
  plays: number;
  nights: number;
  first: string;
  last: string;
  /** A track to open for it: its newest play. */
  trackId: string;
}

export interface SongHistory extends Stats {
  songId: string;
  artist: string;
  title: string;
  /** Empty when the song only ever appears in one form. */
  variants: VariantStat[];
  /** Tracks of this song sitting in collections (shelves), never counted above. */
  shelfTracks: number;
}

export interface ArtistSong {
  songId: string;
  title: string;
  nights: number;
  plays: number;
  people: number;
  first: string;
  last: string;
  /** A track to open for it: its newest play. */
  trackId: string;
}

export interface ArtistHistory extends Stats {
  artistId: string;
  name: string;
  /** Distinct songs by this artist that were brought to a night. */
  songCount: number;
  /** Ranked by nights, then plays, then title. */
  songs: ArtistSong[];
  shelfTracks: number;
}

// ---------------------------------------------------------- dates, locally

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Apr 2026". Locale-independent, so a sentence reads the same everywhere. */
export const monthYear = (d: string) => `${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
/** "4 Apr 2026". */
export const dayMonthYear = (d: string) => `${+d.slice(8, 10)} ${monthYear(d)}`;
const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;

/** A length of time as people say it: "12 days", "8 months", "5 years 3 months". */
export function spanLabel(days: number): string {
  if (days < 31) return days === 1 ? "1 day" : `${days} days`;
  const months = Math.round(days / 30.4375);
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? plural(y, "year") : "", m ? plural(m, "month") : ""].filter(Boolean).join(" ");
}

/** "Bo", "Bo and Cy", "Bo, Cy and Di". */
export const joinNames = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** A gap of this many days or more, followed by another play, makes a comeback. */
export const COMEBACK_DAYS = 5 * 365 + 1;

// ------------------------------------------------------------ the index

interface SongIx {
  bySong: Map<string, Track[]>;
  byArtist: Map<string, Track[]>;
  shelf: Map<string, number>;
  asOf: string | null;
}
const cache = new WeakMap<Catalog, SongIx>();

/** The identity a track plays under: its own, or its twin's when anonymised. */
function songOf(cat: Catalog, t: Track): string | null {
  if (t.songId) return t.songId;
  return t.twinId ? catalogIndex(cat).track.get(t.twinId)?.songId ?? null : null;
}
const artistKey = (songId: string) => songId.split("|")[0];

/** One pass over the tracks, once per catalogue. */
function songIndex(cat: Catalog): SongIx {
  let s = cache.get(cat);
  if (s) return s;
  const ix = catalogIndex(cat);
  s = { bySong: new Map(), byArtist: new Map(), shelf: new Map(), asOf: null };
  for (const e of cat.events) {
    if (e.kind === "event" && e.date && (s.asOf === null || e.date > s.asOf)) s.asOf = e.date;
  }
  const push = (m: Map<string, Track[]>, k: string, t: Track) => {
    const l = m.get(k);
    if (l) l.push(t); else m.set(k, [t]);
  };
  for (const t of cat.tracks) {
    const ev = ix.event.get(t.eventId);
    if (!ev) continue;
    const sid = songOf(cat, t);
    if (!sid) continue;
    if (ev.kind === "collection") {
      if (!t.flags.includes("anon")) s.shelf.set(sid, (s.shelf.get(sid) ?? 0) + 1);
      continue;
    }
    if (!t.played || !ev.date) continue;
    push(s.bySong, sid, t);
    push(s.byArtist, artistKey(sid), t);
  }
  cache.set(cat, s);
  return s;
}

// ------------------------------------------------------------- building

function occurrenceOf(cat: Catalog, t: Track): Occurrence {
  const ix = catalogIndex(cat);
  const ev = ix.event.get(t.eventId)!;
  const twin = t.twinId ? ix.track.get(t.twinId) : undefined;
  const ph = (t.phaseId ? ix.phase.get(t.phaseId) : undefined)
    ?? (twin?.phaseId ? ix.phase.get(twin.phaseId) : undefined);
  return {
    date: ev.date!, eventId: t.eventId, types: ev.types,
    personId: t.personId, person: t.personId ? ix.person.get(t.personId)?.name ?? null : null,
    phase: ph?.clean ?? null, bucket: ph?.bucket ?? null,
    playOrder: t.playOrder ?? twin?.playOrder ?? null,
    trackId: t.id, songId: songOf(cat, t)!, title: t.title ?? twin?.title ?? null,
    variant: t.variant, anon: t.flags.includes("anon"),
  };
}

/** Keep one occurrence per key; the named copy beats the anonymised one. */
function dedupe(occs: Occurrence[], key: (o: Occurrence) => string): Occurrence[] {
  const m = new Map<string, Occurrence>();
  for (const o of occs) {
    const k = key(o), have = m.get(k);
    if (!have || (have.anon && !o.anon)) m.set(k, o);
  }
  return [...m.values()];
}
const perPersonNight = (o: Occurrence) => `${o.personId ?? "?"}|${o.eventId}|${o.songId}`;

const byOrder = (a: Occurrence, b: Occurrence) =>
  (a.playOrder ?? 1e9) - (b.playOrder ?? 1e9)
  || (a.personId ?? "￿").localeCompare(b.personId ?? "￿")
  || a.trackId.localeCompare(b.trackId, undefined, { numeric: true });
const oldestFirst = (a: Occurrence, b: Occurrence) =>
  a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId) || byOrder(a, b);
const newestFirst = (a: Occurrence, b: Occurrence) =>
  b.date.localeCompare(a.date) || b.eventId.localeCompare(a.eventId) || byOrder(a, b);

const BUCKETS: PhaseBucket[] = ["early", "peak", "late", "afterglow", "other"];

function core(cat: Catalog, occs: Occurrence[], asOf: string | null): Stats {
  const newest = [...occs].sort(newestFirst);
  const oldest = [...occs].sort(oldestFirst);
  const mark = (o: Occurrence | undefined): Mark | null => o
    ? {
        ...o,
        nightPeople: [...new Set(occs.filter((x) => x.eventId === o.eventId && x.person).map((x) => x.person!))].sort(),
      }
    : null;

  const nightMap = new Map<string, string>();
  for (const o of oldest) nightMap.set(o.eventId, o.date);
  const nightList = [...nightMap].map(([eventId, date]) => ({ date, eventId }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId));

  // who
  const pm = new Map<string, { c: PersonCount; ev: Set<string> }>();
  let unknownPlays = 0;
  for (const o of oldest) {
    if (!o.personId) { unknownPlays++; continue; }
    let r = pm.get(o.personId);
    if (!r) {
      const idx = cat.people.findIndex((p) => p.id === o.personId);
      r = { c: { personId: o.personId, name: o.person ?? o.personId, index: idx, plays: 0, nights: 0, first: o.date, last: o.date }, ev: new Set() };
      pm.set(o.personId, r);
    }
    r.c.plays++; r.ev.add(o.eventId); r.c.last = o.date;
    r.c.nights = r.ev.size;
  }
  const people = [...pm.values()].map((r) => r.c)
    .sort((a, b) => b.plays - a.plays || b.nights - a.nights || a.name.localeCompare(b.name));

  // when
  const years: YearBar[] = [];
  if (oldest.length) {
    const y0 = +oldest[0].date.slice(0, 4), y1 = +oldest[oldest.length - 1].date.slice(0, 4);
    for (let y = y0; y <= y1; y++) years.push({ year: String(y), plays: 0, nights: 0 });
    for (const o of oldest) years[+o.date.slice(0, 4) - y0].plays++;
    for (const n of nightList) years[+n.date.slice(0, 4) - y0].nights++;
  }

  // where in a set
  const phases = { early: 0, peak: 0, late: 0, afterglow: 0, other: 0, total: 0, dominant: null, dominantShare: 0 } as PhaseDist;
  for (const o of occs) if (o.bucket) { phases[o.bucket]++; phases.total++; }
  if (phases.total) {
    const top = Math.max(...BUCKETS.map((b) => phases[b]));
    const tops = BUCKETS.filter((b) => phases[b] === top);
    if (tops.length === 1) { phases.dominant = tops[0]; phases.dominantShare = top / phases.total; }
  }

  // gaps
  let longestGap: Gap | null = null;
  for (let i = 1; i < nightList.length; i++) {
    const days = dayNum(nightList[i].date) - dayNum(nightList[i - 1].date);
    if (!longestGap || days > longestGap.days) {
      longestGap = { days, from: nightList[i - 1].date, to: nightList[i].date, label: spanLabel(days) };
    }
  }
  const lastDate = newest[0]?.date;
  const sinceDays = lastDate && asOf ? Math.max(0, dayNum(asOf) - dayNum(lastDate)) : null;
  const sinceLast = sinceDays === null ? null : { days: sinceDays, label: spanLabel(sinceDays) };

  // the verdict
  const n = nightList.length, p = people.length;
  let verdict: Verdict;
  if (n === 0) verdict = "never";
  else if (n === 1) verdict = "one-off";
  else if (n >= 8 || p >= 4) verdict = "staple";
  else if (longestGap && longestGap.days >= COMEBACK_DAYS) verdict = "comeback";
  else if (n >= 3) verdict = "regular";
  else verdict = "twice";

  const known = occs.length;
  const top = people[0];
  const signature: Signature | null = top && known >= 3 && top.plays / known >= 0.8
    ? { personId: top.personId!, name: top.name, share: top.plays / known, plays: top.plays }
    : null;

  return {
    plays: occs.length, nights: n, people, unknownPlays,
    first: mark(oldest[0]), last: mark(newest[0]), nightList, years, phases,
    longestGap, sinceLast, asOf, verdict,
    recent: sinceDays !== null && sinceDays <= 365,
    signature, occurrences: newest,
  };
}

// --------------------------------------------------------------- public

/** Everything about one song, by its `songId`. Unknown ids give an empty
 *  history (verdict "never"), never a throw. */
export function songHistory(cat: Catalog, songId: string): SongHistory {
  const si = songIndex(cat);
  const ix = catalogIndex(cat);
  const tracks = si.bySong.get(songId) ?? [];
  const raw = tracks.map((t) => occurrenceOf(cat, t));
  const occs = dedupe(raw, perPersonNight);
  const stats = core(cat, occs, si.asOf);

  const song = ix.song.get(songId);
  const named = tracks.find((t) => t.title);
  // Variants: the same dedupe, but keyed per version, so Live and plain are
  // each counted by their own person-nights.
  const vOccs = dedupe(raw, (o) => `${perPersonNight(o)}|${o.variant ?? ""}`);
  const vm = new Map<string, Occurrence[]>();
  for (const o of vOccs) {
    const k = o.variant ?? "";
    const l = vm.get(k);
    if (l) l.push(o); else vm.set(k, [o]);
  }
  const variants: VariantStat[] = vm.size > 1 || (vm.size === 1 && !vm.has(""))
    ? [...vm.entries()].map(([k, os]) => {
        const sorted = [...os].sort(newestFirst);
        return {
          variant: k || null, plays: os.length, nights: new Set(os.map((o) => o.eventId)).size,
          first: sorted[sorted.length - 1].date, last: sorted[0].date, trackId: sorted[0].trackId,
        };
      }).sort((a, b) => b.plays - a.plays || (a.variant ? 1 : 0) - (b.variant ? 1 : 0)
        || (a.variant ?? "").localeCompare(b.variant ?? ""))
    : [];

  return {
    ...stats, songId,
    artist: song?.artist ?? named?.artist ?? songId.split("|")[0],
    title: song?.title ?? named?.title ?? songId,
    variants, shelfTracks: si.shelf.get(songId) ?? 0,
  };
}

/** Everything about one artist, by `ArtistEntry.id` (or, failing that, the name). */
export function artistHistory(cat: Catalog, artist: string): ArtistHistory {
  const si = songIndex(cat);
  const ix = catalogIndex(cat);
  let entry = ix.artist.get(artist);
  if (!entry) {
    const low = artist.trim().toLowerCase();
    entry = cat.artists.find((a) => a.name.toLowerCase() === low);
  }
  const key = entry?.id ?? artist;
  const tracks = si.byArtist.get(key) ?? [];
  const occs = dedupe(tracks.map((t) => occurrenceOf(cat, t)), perPersonNight);
  const stats = core(cat, occs, si.asOf);

  const by = new Map<string, Occurrence[]>();
  for (const o of occs) {
    const l = by.get(o.songId);
    if (l) l.push(o); else by.set(o.songId, [o]);
  }
  const songs: ArtistSong[] = [...by.entries()].map(([songId, os]) => {
    const sorted = [...os].sort(newestFirst);
    return {
      songId, title: ix.song.get(songId)?.title ?? sorted[0].title ?? songId,
      nights: new Set(os.map((o) => o.eventId)).size, plays: os.length,
      people: new Set(os.map((o) => o.personId).filter(Boolean)).size,
      first: sorted[sorted.length - 1].date, last: sorted[0].date, trackId: sorted[0].trackId,
    };
  }).sort((a, b) => b.nights - a.nights || b.plays - a.plays || a.title.localeCompare(b.title));

  let shelf = 0;
  for (const [sid, n] of si.shelf) if (artistKey(sid) === key) shelf += n;
  return {
    ...stats, artistId: key, name: entry?.name ?? (songs.length ? ix.song.get(songs[0].songId)?.artist : undefined) ?? artist,
    songCount: songs.length, songs, shelfTracks: shelf,
  };
}

// --------------------------------------------------------------- words

/** "A staple: brought on 11 nights since 2015 by 3 people, last by Dov in Apr 2026." */
export function verdictSentence(h: Stats & { shelfTracks?: number }): string {
  const f = h.first, l = h.last;
  if (h.verdict === "never" || !f || !l) {
    return (h.shelfTracks ?? 0) > 0
      ? "Only on a shelf: in a collection, never brought to a night."
      : "Never brought to a dated night.";
  }
  const who = (names: string[]) => (names.length ? `, by ${joinNames(names)}` : "");
  const lastWho = l.nightPeople.length ? ` by ${joinNames(l.nightPeople)}` : "";
  if (h.verdict === "one-off") {
    const when = h.plays === 1
      ? `brought once, in ${monthYear(f.date)}`
      : `brought ${h.plays} times on one night, in ${monthYear(f.date)}`;
    return `A one-off: ${when}${who(f.nightPeople)}.`;
  }
  if (h.verdict === "twice") {
    return `Brought on 2 nights: ${monthYear(f.date)}${f.nightPeople.length ? ` (${joinNames(f.nightPeople)})` : ""} `
      + `and ${monthYear(l.date)}${l.nightPeople.length ? ` (${joinNames(l.nightPeople)})` : ""}.`;
  }
  const names = h.people.map((p) => p.name);
  const crowd = names.length === 1 ? `, always by ${names[0]}, last in ${monthYear(l.date)}`
    : names.length === 0 ? `, last in ${monthYear(l.date)}`
    : ` by ${plural(names.length, "person", "people")}, last${lastWho} in ${monthYear(l.date)}`;
  const head = `brought on ${plural(h.nights, "night")} since ${f.date.slice(0, 4)}`;
  if (h.verdict === "comeback" && h.longestGap) {
    return `A comeback: ${head}${crowd}, back in ${monthYear(h.longestGap.to)} after ${h.longestGap.label} away.`;
  }
  return `${h.verdict === "staple" ? "A staple" : "A regular"}: ${head}${crowd}.`;
}

/** A compact plain-text history, for pasting into a chat while planning. */
export function summaryText(label: string, h: Stats): string {
  const lines = [label, verdictSentence(h)];
  if (h.first && h.last) {
    const m = (x: Mark) => `${dayMonthYear(x.date)}${x.nightPeople.length ? `, ${joinNames(x.nightPeople)}` : ""}`
      + (x.types.length ? ` (${x.types.join("/")})` : "");
    lines.push(`First: ${m(h.first)}`, `Last: ${m(h.last)}`);
  }
  if (h.people.length) lines.push(`Brought by: ${h.people.map((p) => `${p.name} x${p.plays}`).join(", ")}`);
  const ys = h.years.filter((y) => y.plays);
  if (ys.length) lines.push(`Years: ${ys.map((y) => `${y.year} x${y.plays}`).join(", ")}`);
  if (h.longestGap) lines.push(`Longest gap: ${h.longestGap.label} (${monthYear(h.longestGap.from)} to ${monthYear(h.longestGap.to)})`);
  if (h.sinceLast && h.asOf) lines.push(`Since last: ${h.sinceLast.label}, as of the newest night (${monthYear(h.asOf)})`);
  return lines.join("\n");
}
