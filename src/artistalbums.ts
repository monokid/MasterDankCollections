/** The Music page's artist perspective: artists > albums > songs. Pure: no React,
 *  no DOM, so tools/artistalbums.test.ts can run it.
 *
 *  Rules (one place, so the Artists view, the artist page and the tests agree):
 *   - an artist is the wall's own artist (artistId). "A & B" is its own artist and
 *     is never split into A and B. A song with no credited artist goes to one
 *     group, "Unknown artist", which always sorts last;
 *   - an album is grouped by its normalised name: case, accents, punctuation and
 *     noise suffixes like "(Remastered 2011)", "- Deluxe Edition" do not make a
 *     second album. The name shown is the cleanest original spelling seen. An
 *     event label ("Roll") is not an album and counts as no album;
 *   - albums belong to one artist: a compilation whose songs have different
 *     artists is a separate album group under each artist;
 *   - an album's year is the earliest known release year of its songs; albums run
 *     by year (unknown last), then name; songs with no album go to one last group;
 *   - a song is in exactly one album group, so counts add up to the artist's songs;
 *   - the filters decide which SONGS count; an artist is whoever still has songs. */
import { isEventLabel } from "./analytics.ts";
import { fold } from "./identity.ts";
import { letterOf, LETTERS, sortKey, type WallSong } from "./musicstats.ts";

export const NO_ARTIST = "Unknown artist";
export const NO_ALBUM = "Singles and songs with no album on file";

// ------------------------------------------------------------- album names

const NOISE = /remaster|deluxe|expanded|anniversary|bonus|special edition|collector|re-?issue|edition|explicit/i;
const BRACKET_TAIL = /\s*[(\[]([^)\]]*)[)\]]\s*$/;
const DASH_TAIL = /\s+[-–—]\s+([^-–—]*)$/;

/** The album name without noise suffixes, keeping the original spelling:
 *  "Abbey Road (Remastered 2009)" -> "Abbey Road". Never empties a name. */
export function cleanAlbum(raw: string): string {
  let t = raw.trim();
  for (let again = true; again;) {
    again = false;
    for (const re of [BRACKET_TAIL, DASH_TAIL]) {
      const m = re.exec(t);
      if (m && NOISE.test(m[1])) {
        const next = t.slice(0, m.index).trim();
        if (next) { t = next; again = true; }
      }
    }
  }
  return t;
}

/** Tags people file whole playlists under: a collection name, not an album. */
const PLAYLIST_TAGS = new Set(["favorites", "favourites", "mix", "youtube", "playlist", "downloads", "downloaded"]);

/** What makes two spellings one album; null when it is no album at all (empty,
 *  or just the label of a night). */
export function albumKey(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (!t || isEventLabel(t) || PLAYLIST_TAGS.has(fold(t))) return null;
  const core = cleanAlbum(t);
  if (isEventLabel(core)) return null;
  return fold(core) || fold(t) || null;
}

/** Of several spellings of one album, the one to show: the most common noise-free
 *  spelling; on a tie one with mixed case (not ALL CAPS or all lower), then A-Z. */
export function pickDisplay(spellings: string[]): string {
  const n = new Map<string, number>();
  for (const s of spellings) { const c = cleanAlbum(s); n.set(c, (n.get(c) ?? 0) + 1); }
  const mixed = (s: string) => (s !== s.toLowerCase() && s !== s.toUpperCase() ? 1 : 0);
  return [...n].sort((a, b) => b[1] - a[1] || mixed(b[0]) - mixed(a[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
}

// ----------------------------------------------------------- album groups

/** The slice of a song's facts the grouping needs (SongInfo has all of it). */
export interface AlbumFacts { album: string | null; year: number | null; durationSec: number | null }

export interface AlbumGroup<S> {
  key: string;
  name: string;
  /** Earliest known release year of its songs, or null. */
  year: number | null;
  songs: S[];
  /** Sum of the lengths that are known, and how many songs those are. */
  seconds: number;
  withLength: number;
}

export interface Grouped<S> { albums: AlbumGroup<S>[]; noAlbum: S[] }

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const collator = new Intl.Collator("en", { numeric: true });

/** Splits one artist's songs by album. Songs keep the order they were given in,
 *  inside each group. */
export function groupByAlbum<S>(songs: readonly S[], facts: (s: S) => AlbumFacts): Grouped<S> {
  const map = new Map<string, { spell: string[]; songs: S[]; year: number | null; seconds: number; withLength: number }>();
  const noAlbum: S[] = [];
  for (const s of songs) {
    const f = facts(s);
    const k = albumKey(f.album);
    if (!k) { noAlbum.push(s); continue; }
    let g = map.get(k);
    if (!g) map.set(k, (g = { spell: [], songs: [], year: null, seconds: 0, withLength: 0 }));
    g.spell.push(f.album!.trim());
    g.songs.push(s);
    if (f.year && (g.year === null || f.year < g.year)) g.year = f.year;
    if (f.durationSec && f.durationSec > 0) { g.seconds += f.durationSec; g.withLength++; }
  }
  const albums = [...map].map(([key, g]): AlbumGroup<S> => ({
    key, name: pickDisplay(g.spell), year: g.year, songs: g.songs, seconds: g.seconds, withLength: g.withLength,
  }));
  albums.sort((a, b) =>
    (a.year === null ? (b.year === null ? 0 : 1) : b.year === null ? -1 : a.year - b.year)
    || collator.compare(fold(a.name), fold(b.name)) || byName(a.key, b.key));
  return { albums, noAlbum };
}

/** The artist page opens By album when there is something to group: one album with
 *  two or more songs, or at least two albums. Otherwise a flat list reads better. */
export function defaultGrouping<S>(g: Grouped<S>): "album" | "flat" {
  return g.albums.length >= 2 || g.albums.some((a) => a.songs.length >= 2) ? "album" : "flat";
}

// ------------------------------------------------------------ artist rows

export interface ArtistRow {
  /** Identity of the group; unique among rows. "" is the Unknown artist group. */
  key: string;
  /** Opens the artist page when set (the wall knows this artist). */
  id: string | null;
  name: string;
  unknown: boolean;
  /** Only the songs that passed the filters, in the wall's A-Z order. */
  songs: WallSong[];
  nights: number;
  first: string;
  last: string;
  /** Distinct years it was brought, ascending. */
  years: number[];
  groups: Grouped<WallSong>;
  bucket: string;
}

/** Groups songs by artist. `known` says which artist ids have a page. Songs must
 *  already be filtered; an artist with none is simply not here. */
export function buildArtistRows(
  songs: readonly WallSong[], facts: (s: WallSong) => AlbumFacts, known: (id: string) => boolean,
  nameOf: (id: string) => string | undefined,
): ArtistRow[] {
  const by = new Map<string, WallSong[]>();
  for (const s of songs) {
    const k = s.artistId ?? (s.artist ? `?${fold(s.artist) || s.artist.toLowerCase()}` : "");
    const l = by.get(k);
    if (l) l.push(s); else by.set(k, [s]);
  }
  const rows: ArtistRow[] = [];
  for (const [key, list] of by) {
    const unknown = key === "";
    const id = list[0].artistId && known(list[0].artistId) ? list[0].artistId : null;
    const name = unknown ? NO_ARTIST : (id ? nameOf(id) : undefined) ?? list[0].artist;
    const nights = new Set<string>(), years = new Set<number>();
    let first = list[0].firstDate, last = list[0].lastDate;
    for (const s of list) {
      for (const n of s.nightIds) nights.add(n);
      for (const y of s.years) years.add(y);
      if (s.firstDate < first) first = s.firstDate;
      if (s.lastDate > last) last = s.lastDate;
    }
    rows.push({
      key, id, name, unknown, songs: list, nights: nights.size, first, last,
      years: [...years].sort((a, b) => a - b), groups: groupByAlbum(list, facts),
      bucket: unknown ? "" : letterOf(sortKey(name)),
    });
  }
  return sortArtists(rows, "az");
}

export type ArtistSort = "az" | "songs" | "nights" | "first" | "last";
export const ARTIST_SORTS: ArtistSort[] = ["az", "songs", "nights", "first", "last"];
export const ARTIST_SORT_LABEL: Record<ArtistSort, string> = {
  az: "A to Z", songs: "Most songs", nights: "Most nights", first: "First brought", last: "Last brought",
};

const rank = new Map(LETTERS.map((l, i) => [l, i]));
const az = (a: ArtistRow, b: ArtistRow) => {
  if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
  const ra = rank.get(a.bucket) ?? 0, rb = rank.get(b.bucket) ?? 0;
  return ra - rb || collator.compare(sortKey(a.name), sortKey(b.name)) || byName(a.key, b.key);
};

/** Sorted copy. Every sort starts from A-Z, so ties read A-Z and never shuffle;
 *  Unknown artist is last whatever the sort. */
export function sortArtists(rows: readonly ArtistRow[], sort: ArtistSort): ArtistRow[] {
  const out = [...rows].sort(az);
  if (sort === "az") return out;
  const num = (r: ArtistRow) => (sort === "songs" ? -r.songs.length : sort === "nights" ? -r.nights : 0);
  return out.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    if (sort === "first") return byName(a.first, b.first);
    if (sort === "last") return byName(b.last, a.last);
    return num(a) - num(b);
  });
}

/** "12 songs · 5 albums · 8 nights · 2015-2026"; albums left out when none is known. */
export function artistLine(r: ArtistRow, plural: (n: number, w: string) => string): string {
  const y0 = r.first.slice(0, 4), y1 = r.last.slice(0, 4);
  return [
    plural(r.songs.length, "song"),
    r.groups.albums.length ? plural(r.groups.albums.length, "album") : null,
    plural(r.nights, "night"),
    y0 === y1 ? y0 : `${y0}–${y1}`,
  ].filter(Boolean).join(" · ");
}

export interface AlbumCoverage { songs: number; withAlbum: number }

/** How many of these songs sit in a known album. */
export function albumCoverage(rows: readonly ArtistRow[]): AlbumCoverage {
  let songs = 0, noAlbum = 0;
  for (const r of rows) { songs += r.songs.length; noAlbum += r.groups.noAlbum.length; }
  return { songs, withAlbum: songs - noAlbum };
}

// ----------------------------------------------------------- virtual rows

export type Item =
  | { kind: "head"; label: string; letter: string; count: number }
  | { kind: "artist"; row: ArtistRow; open: boolean }
  | { kind: "album"; row: ArtistRow; album: AlbumGroup<WallSong> | null; count: number }
  | { kind: "song"; row: ArtistRow; song: WallSong };

/** Every row has a fixed height by kind, so offsets are exact without measuring. */
export const HEIGHT = { head: 56, artist: 84, album: 50, song: 40 } as const;

/** The flat list the Artists view draws: letter heads (A-Z only), artists, and for
 *  each open artist its albums and their songs. */
export function flatten(rows: readonly ArtistRow[], open: ReadonlySet<string>, heads: boolean): Item[] {
  const out: Item[] = [];
  let bucket: string | null = null;
  if (heads) {
    const n = new Map<string, number>();
    for (const r of rows) n.set(r.bucket, (n.get(r.bucket) ?? 0) + 1);
    rows.forEach((r) => {
      if (r.bucket !== bucket) {
        bucket = r.bucket;
        out.push({ kind: "head", label: r.unknown ? NO_ARTIST : r.bucket, letter: r.bucket, count: n.get(r.bucket) ?? 0 });
      }
      push(r);
    });
    return out;
  }
  rows.forEach(push);
  return out;

  function push(r: ArtistRow) {
    const isOpen = open.has(r.key);
    out.push({ kind: "artist", row: r, open: isOpen });
    if (!isOpen) return;
    for (const a of r.groups.albums) {
      out.push({ kind: "album", row: r, album: a, count: a.songs.length });
      for (const s of a.songs) out.push({ kind: "song", row: r, song: s });
    }
    if (r.groups.noAlbum.length) {
      out.push({ kind: "album", row: r, album: null, count: r.groups.noAlbum.length });
      for (const s of r.groups.noAlbum) out.push({ kind: "song", row: r, song: s });
    }
  }
}
