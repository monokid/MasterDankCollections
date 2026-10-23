/** The Music page's numbers: every song brought to a dated night, once, with the
 *  years, people and kinds of night around it. Pure: no React, no DOM, so
 *  tools/musicstats.test.ts can run it.
 *
 *  What counts (the same rules as songstats.ts, which the test cross-checks):
 *   - only tracks marked `played`, on a dated night. Collections are shelves;
 *   - a song is one entry however many people, copies or nights carry it;
 *   - an anonymised track takes its identity from its twin;
 *   - a track with no song identity is still a song if it has a real title (it
 *     goes under "Unknown artist" when it has no artist), keyed by its folded
 *     title. Anonymised tracks that nothing could name ("Rico 02") are not songs
 *     and are only counted in `unnamed`.
 *
 *  Sort and letter rules (one place, so the wall, the rail and the tests agree):
 *   - sort key = the title folded (lower case, accents and punctuation gone, as
 *     identity.ts does), with a leading "the " dropped and a few letters the
 *     accent fold leaves alone (o-slash, ae, sharp s, l-stroke, d-stroke)
 *     spelled the usual way. A title that folds to nothing ("+♂", an emoji)
 *     sorts by its lower-cased text;
 *   - letter bucket = the first character of that key: A-Z for Latin letters;
 *     "#" for digits, symbols, emoji and the rare extended Latin letter; "…" for
 *     every other script (Cyrillic, Greek, Japanese, Arabic...). Order: # A-Z …;
 *   - within a bucket: numeric-aware collation of the key, then artist, then
 *     song id, so equal titles never shuffle;
 *   - every other sort starts from that A-Z order and is stable, so ties read A-Z. */
import type { Catalog } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { coverUrlOf, decadeOf, familyOf, yearOf, type EnrichMap } from "./enrich.ts";
import { fold } from "./identity.ts";

// ------------------------------------------------------------------ types

export interface WallSong {
  songId: string;
  title: string;
  /** "" when nobody is credited. */
  artist: string;
  /** Resolves in `cat.artists`; null for a song with no (known) artist. */
  artistId: string | null;
  /** True when the track has no song identity: it cannot open a history page. */
  loose: boolean;
  /** Distinct nights. */
  nights: number;
  nightIds: string[];
  /** Dates of those nights, oldest first (parallel to `nightIds`). */
  dates: string[];
  firstDate: string;
  lastDate: string;
  /** Distinct years it was brought, ascending. */
  years: number[];
  /** Person ids, in the order of `cat.people`. */
  people: string[];
  types: string[];
  variants: string[];
  /** Sort key and letter bucket (see the header). */
  key: string;
  bucket: string;
  /** Folded "artist title", for the text filter. */
  hay: string;
}

export interface ArtistAgg {
  id: string;
  name: string;
  songs: number;
  nights: number;
  people: string[];
  first: string;
  last: string;
}

export interface Wall {
  /** A-Z order. */
  songs: WallSong[];
  byId: Map<string, WallSong>;
  byArtist: Map<string, WallSong[]>;
  artists: Map<string, ArtistAgg>;
  /** Played, dated tracks that carry no usable name at all (anonymised leftovers). */
  unnamed: number;
  minYear: number | null;
  maxYear: number | null;
}

// ---------------------------------------------------------- letters & keys

export const LETTERS: string[] = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "…"];
const letterRank = new Map(LETTERS.map((l, i) => [l, i]));

const SPELL: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", ł: "l", đ: "d", ð: "d", þ: "th" };
const spell = (s: string) => s.replace(/[øæœßłđðþ]/gi, (c) => SPELL[c.toLowerCase()]);

/** "The Prodigy" and "Prodigy" file together. Never empties a title. */
export function sortKey(title: string): string {
  const t = title.trim();
  let k = fold(spell(t.toLowerCase()));
  if (!k) return t.toLowerCase();
  if (k.startsWith("the ") && k.length > 4) k = k.slice(4);
  return k;
}

export function letterOf(key: string): string {
  const c = Array.from(key)[0];
  if (!c) return "#";
  if (/[a-z]/.test(c)) return c.toUpperCase();
  if (/\p{N}/u.test(c)) return "#";
  if (/\p{Script=Latin}/u.test(c)) return "#";
  if (/\p{L}/u.test(c)) return "…";
  return "#";
}

const collator = new Intl.Collator("en", { numeric: true });
const idCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareAz(a: WallSong, b: WallSong): number {
  const ra = letterRank.get(a.bucket)!, rb = letterRank.get(b.bucket)!;
  if (ra !== rb) return ra - rb;
  return collator.compare(a.key, b.key)
    || collator.compare(sortKey(a.artist), sortKey(b.artist))
    || idCmp(a.songId, b.songId);
}

// ------------------------------------------------------------- the wall

interface Acc {
  songId: string; title: string; artist: string; artistId: string | null; loose: boolean;
  nights: Map<string, string>; people: Set<string>; types: Set<string>; variants: Set<string>;
}

const cache = new WeakMap<Catalog, Wall>();

/** One pass over the tracks, once per catalogue. */
export function buildWall(cat: Catalog): Wall {
  const hit = cache.get(cat);
  if (hit) return hit;
  const ix = catalogIndex(cat);
  const accs = new Map<string, Acc>();
  let unnamed = 0;

  for (const t of cat.tracks) {
    const ev = ix.event.get(t.eventId);
    if (!ev || ev.kind !== "event" || !ev.date || !t.played) continue;
    const twin = t.twinId ? ix.track.get(t.twinId) : undefined;
    const sid = t.songId ?? twin?.songId ?? null;

    let key: string, title: string, artist: string, artistId: string | null, loose = false;
    if (sid) {
      key = sid;
      const song = ix.song.get(sid);
      title = song?.title ?? t.title ?? twin?.title ?? sid;
      artist = song?.artist ?? t.artist ?? twin?.artist ?? "";
      const head = sid.split("|")[0];
      artistId = head && ix.artist.has(head) ? head : null;
    } else {
      title = (t.title ?? twin?.title ?? "").trim();
      if (t.flags.includes("anon") || !title) { unnamed++; continue; }
      artist = (t.artist ?? twin?.artist ?? "").trim();
      key = `?${fold(artist)}|${fold(title) || title.toLowerCase()}`;
      const head = fold(artist);
      artistId = head && ix.artist.has(head) ? head : null;
      loose = true;
    }

    let a = accs.get(key);
    if (!a) {
      a = { songId: key, title, artist, artistId, loose, nights: new Map(), people: new Set(), types: new Set(), variants: new Set() };
      accs.set(key, a);
    }
    a.nights.set(ev.id, ev.date);
    if (t.personId) a.people.add(t.personId);
    for (const ty of ev.types) a.types.add(ty);
    if (t.variant) a.variants.add(t.variant);
  }

  const order = new Map(cat.people.map((p, i) => [p.id, i]));
  const songs: WallSong[] = [];
  for (const a of accs.values()) {
    const nights = [...a.nights].sort((x, y) => x[1].localeCompare(y[1]) || idCmp(x[0], y[0]));
    const key = sortKey(a.title);
    songs.push({
      songId: a.songId, title: a.title, artist: a.artist, artistId: a.artistId, loose: a.loose,
      nights: nights.length, nightIds: nights.map((n) => n[0]), dates: nights.map((n) => n[1]),
      firstDate: nights[0][1], lastDate: nights[nights.length - 1][1],
      years: [...new Set(nights.map((n) => +n[1].slice(0, 4)))],
      people: [...a.people].sort((p, q) => (order.get(p) ?? 1e9) - (order.get(q) ?? 1e9) || idCmp(p, q)),
      types: [...a.types].sort(), variants: [...a.variants].sort(),
      key, bucket: letterOf(key), hay: fold(`${a.artist} ${a.title}`),
    });
  }
  songs.sort(compareAz);

  const byId = new Map<string, WallSong>();
  const byArtist = new Map<string, WallSong[]>();
  const ev = new Map<string, Set<string>>();
  const ppl = new Map<string, Set<string>>();
  let minYear: number | null = null, maxYear: number | null = null;
  for (const s of songs) {
    byId.set(s.songId, s);
    if (minYear === null || s.years[0] < minYear) minYear = s.years[0];
    if (maxYear === null || s.years[s.years.length - 1] > maxYear) maxYear = s.years[s.years.length - 1];
    if (!s.artistId) continue;
    const l = byArtist.get(s.artistId);
    if (l) l.push(s); else byArtist.set(s.artistId, [s]);
    let e = ev.get(s.artistId); if (!e) ev.set(s.artistId, (e = new Set()));
    for (const n of s.nightIds) e.add(n);
    let p = ppl.get(s.artistId); if (!p) ppl.set(s.artistId, (p = new Set()));
    for (const x of s.people) p.add(x);
  }
  const artists = new Map<string, ArtistAgg>();
  for (const [id, list] of byArtist) {
    let first = list[0].firstDate, last = list[0].lastDate;
    for (const s of list) { if (s.firstDate < first) first = s.firstDate; if (s.lastDate > last) last = s.lastDate; }
    artists.set(id, {
      id, name: ix.artist.get(id)?.name ?? list[0].artist, songs: list.length,
      nights: ev.get(id)!.size, people: [...ppl.get(id)!].sort((p, q) => (order.get(p) ?? 1e9) - (order.get(q) ?? 1e9)),
      first, last,
    });
  }

  const wall: Wall = { songs, byId, byArtist, artists, unnamed, minYear, maxYear };
  cache.set(cat, wall);
  return wall;
}

// ------------------------------------------------------------ enrichment

export interface Facts { year: number | null; decade: string | null; family: string | null; cover: string | null }

const factsCache = new WeakMap<Wall, WeakMap<EnrichMap, Map<string, Facts>>>();

/** What the public databases say about each wall song; songs with nothing are
 *  simply absent, never given a year 0. */
export function factsOf(wall: Wall, enrich: EnrichMap | null): Map<string, Facts> {
  if (!enrich) return new Map();
  let per = factsCache.get(wall);
  if (!per) factsCache.set(wall, (per = new WeakMap()));
  let m = per.get(enrich);
  if (m) return m;
  m = new Map();
  for (const s of wall.songs) {
    const r = s.loose ? undefined : enrich[s.songId];
    if (!r) continue;
    const year = yearOf(r), family = familyOf(r), cover = coverUrlOf(r);
    if (year || family || cover) m.set(s.songId, { year, decade: decadeOf(year), family, cover });
  }
  per.set(enrich, m);
  return m;
}

export interface Coverage { total: number; cover: number; year: number; family: number }

export function coverage(songs: WallSong[], facts: Map<string, Facts>): Coverage {
  const c = { total: songs.length, cover: 0, year: 0, family: 0 };
  for (const s of songs) {
    const f = facts.get(s.songId);
    if (!f) continue;
    if (f.cover) c.cover++;
    if (f.year) c.year++;
    if (f.family) c.family++;
  }
  return c;
}

// --------------------------------------------------------------- filters

export interface Filters {
  q: string;
  family: string | null;
  decade: string | null;
  type: string | null;
  personId: string | null;
  /** Brought in this year or later / this year or earlier. */
  since: number | null;
  until: number | null;
  coverOnly: boolean;
  /** Only songs with no credited artist (the "Unknown artist" group). */
  noArtist: boolean;
}

export const NO_FILTERS: Filters = {
  q: "", family: null, decade: null, type: null, personId: null, since: null, until: null, coverOnly: false, noArtist: false,
};

export const isFiltered = (f: Filters) =>
  !!(f.q.trim() || f.family || f.decade || f.type || f.personId || f.since || f.until || f.coverOnly || f.noArtist);

/** Forgiving text match: every word of the query somewhere in "artist title",
 *  accents and punctuation ignored, spaces optional ("daftpunk"). */
export function matchesText(s: WallSong, q: string): boolean {
  const raw = q.trim();
  if (!raw) return true;
  const fq = fold(raw);
  if (!fq) return `${s.title} ${s.artist}`.toLowerCase().includes(raw.toLowerCase());
  if (fq.split(" ").every((w) => s.hay.includes(w))) return true;
  return s.hay.replace(/ /g, "").includes(fq.replace(/ /g, ""));
}

type Facet = "family" | "decade" | "type";

function passes(s: WallSong, f: Filters, facts: Map<string, Facts>, skip?: Facet): boolean {
  if (f.q && !matchesText(s, f.q)) return false;
  if (f.noArtist && s.artist) return false;
  if (f.personId && !s.people.includes(f.personId)) return false;
  if (skip !== "type" && f.type && !s.types.includes(f.type)) return false;
  // A window of years only counts a song if one of its years falls inside it.
  if ((f.since !== null || f.until !== null) && !s.years.some((y) => (f.since === null || y >= f.since) && (f.until === null || y <= f.until))) return false;
  const fa = facts.get(s.songId);
  if (skip !== "family" && f.family && fa?.family !== f.family) return false;
  if (skip !== "decade" && f.decade && fa?.decade !== f.decade) return false;
  if (f.coverOnly && !fa?.cover) return false;
  return true;
}

/** Keeps the order it is given. */
export function filterSongs(songs: WallSong[], f: Filters, facts: Map<string, Facts>): WallSong[] {
  return isFiltered(f) ? songs.filter((s) => passes(s, f, facts)) : songs;
}

/** Chip counts for one facet, under every other active filter, biggest first. */
export function facetCounts(songs: WallSong[], f: Filters, facts: Map<string, Facts>, facet: Facet): Array<[string, number]> {
  const n = new Map<string, number>();
  for (const s of songs) {
    if (!passes(s, f, facts, facet)) continue;
    const fa = facts.get(s.songId);
    const vals = facet === "type" ? s.types : [facet === "family" ? fa?.family : fa?.decade];
    for (const v of vals) if (v) n.set(v, (n.get(v) ?? 0) + 1);
  }
  const out = [...n];
  if (facet === "decade") return out.sort((a, b) => idCmp(a[0], b[0]));
  return out.sort((a, b) => b[1] - a[1] || idCmp(a[0], b[0]));
}

// ------------------------------------------------------------------ sort

export type SortKey = "az" | "nights" | "first" | "last" | "year";

export const SORT_LABEL: Record<SortKey, string> = {
  az: "A to Z", nights: "Most nights", first: "First brought", last: "Last brought", year: "Release year",
};

/** `songs` must be in A-Z order (the wall's); equal values then stay A-Z. */
export function sortSongs(songs: WallSong[], sort: SortKey, facts: Map<string, Facts>): WallSong[] {
  if (sort === "az") return songs;
  const out = [...songs];
  const year = (s: WallSong) => facts.get(s.songId)?.year ?? null;
  if (sort === "nights") out.sort((a, b) => b.nights - a.nights);
  else if (sort === "first") out.sort((a, b) => idCmp(a.firstDate, b.firstDate));
  else if (sort === "last") out.sort((a, b) => idCmp(b.lastDate, a.lastDate));
  else out.sort((a, b) => {
    const x = year(a), y = year(b);
    return x === null ? (y === null ? 0 : 1) : y === null ? -1 : x - y;
  });
  return out;
}

// ---------------------------------------------------------------- layout

export type Row =
  | { kind: "head"; letter: string; count: number }
  | { kind: "tiles"; from: number; to: number };

/** Rows of `cols` songs. Grouped (A-Z) starts every letter on a fresh row under
 *  its own heading; otherwise it is one run of rows. */
export function layoutRows(songs: WallSong[], cols: number, grouped: boolean): Row[] {
  const rows: Row[] = [];
  const n = Math.max(1, cols);
  let i = 0;
  while (i < songs.length) {
    let end = songs.length;
    if (grouped) {
      end = i + 1;
      while (end < songs.length && songs[end].bucket === songs[i].bucket) end++;
      rows.push({ kind: "head", letter: songs[i].bucket, count: end - i });
    }
    for (let j = i; j < end; j += n) rows.push({ kind: "tiles", from: j, to: Math.min(j + n, end) });
    i = end;
  }
  return rows;
}

export function letterCounts(songs: WallSong[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of songs) m.set(s.bucket, (m.get(s.bucket) ?? 0) + 1);
  return m;
}

// ------------------------------------------------------------- artists

export type DiscoOrder = "first" | "nights" | "az";

/** An artist's songs in the chosen order; ties stay A-Z. */
export function discography(wall: Wall, artistId: string, order: DiscoOrder): WallSong[] {
  const list = wall.byArtist.get(artistId) ?? [];
  if (order === "az") return list;
  const out = [...list];
  if (order === "first") out.sort((a, b) => idCmp(a.firstDate, b.firstDate) || b.nights - a.nights);
  else out.sort((a, b) => b.nights - a.nights || idCmp(a.firstDate, b.firstDate));
  return out;
}

/** Artists for prev/next. With A-Z they run by name; with any other sort, by
 *  where each first appears in the sorted, filtered list. Songs with no artist
 *  take no part. */
export function artistOrder(songs: WallSong[], sort: SortKey, wall: Wall): string[] {
  if (sort === "az") {
    const ids = new Set<string>();
    for (const s of songs) if (s.artistId) ids.add(s.artistId);
    return [...ids].sort((a, b) =>
      collator.compare(sortKey(wall.artists.get(a)!.name), sortKey(wall.artists.get(b)!.name)) || idCmp(a, b));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of songs) if (s.artistId && !seen.has(s.artistId)) { seen.add(s.artistId); out.push(s.artistId); }
  return out;
}

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;

/** Where a date falls on a strip from 1 Jan of `y0` to 31 Dec of `y1`, 0..1. */
export function stripPos(date: string, y0: number, y1: number): number {
  const a = Date.UTC(y0, 0, 1) / 864e5, b = Date.UTC(y1, 11, 31) / 864e5;
  return b <= a ? 0 : Math.min(1, Math.max(0, (dayNum(date) - a) / (b - a)));
}

// ------------------------------------------------------- generative tiles

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}

export interface TileArt {
  h1: number; h2: number; angle: number;
  x1: number; y1: number; x2: number; y2: number;
  /** Border radii for the soft blob, "55% 45% 40% 60% / ..." */
  blob: string; spin: number;
}

/** Deterministic from the id: the same song always gets the same tile. */
export function tileArt(id: string): TileArt {
  let h = hash32(id);
  const next = (mod: number) => { h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; h ^= h >>> 15; return (h >>> 0) % mod; };
  const h1 = next(360);
  const h2 = (h1 + 45 + next(130)) % 360;
  const r = () => 38 + next(25);
  return {
    h1, h2, angle: next(360),
    x1: 10 + next(40), y1: 10 + next(40), x2: 50 + next(40), y2: 50 + next(40),
    blob: `${r()}% ${100 - r()}% ${r()}% ${100 - r()}% / ${r()}% ${r()}% ${100 - r()}% ${100 - r()}%`,
    spin: next(360),
  };
}

/** The first letters of a title, for a tile with no cover: "Ghost Love Score" -> "GL". */
export function initialsOf(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const ws = words.length > 1 && /^the$/i.test(words[0]) ? words.slice(1) : words;
  if (!ws.length) return Array.from(title.trim()).slice(0, 1).join("") || "♪";
  const pick = ws.length === 1 ? Array.from(ws[0]).slice(0, 2) : ws.slice(0, 2).map((w) => Array.from(w)[0]);
  return pick.join("").toUpperCase();
}
