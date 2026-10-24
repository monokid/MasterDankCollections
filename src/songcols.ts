/** The columns every song list shares (Search, the night playlists, track detail,
 *  Music) and the one place that works out what each cell says. Pure: no React,
 *  no DOM, so tools/songcols.test.ts can run it.
 *
 *  A list is `Column<R>[]` over its own row type R. `songColumns(get)` builds the
 *  standard ones from any `get(row) -> SongInfo`; a page appends its own (Search
 *  adds "brought by" and "when") by pushing more `Column<R>`.
 *
 *  Missing is a value, not a hole: every unknown is null, shown as an em-dash,
 *  and sorts last in both directions. */
import type { Catalog, Track } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { isEventLabel } from "./analytics.ts";
import { familyLabel } from "./families.ts";
import {
  albumOf, dateOf, familyOf, tagAlbum, yearOf, type DatePrecision, type EnrichMap, type EnrichRecord,
} from "./enrich.ts";

// ------------------------------------------------------------------ facts

export interface SongInfo {
  songId: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  /** Release year (the believable match only). */
  year: number | null;
  /** The date at its known precision; tables show the year, the tooltip this. */
  releaseDate: string | null;
  datePrecision: DatePrecision | null;
  /** Raw family key (colour) and its name for people. */
  family: string | null;
  familyLabel: string | null;
  /** Real genres only: from the match, else file tags that are not event labels. */
  genres: string[];
  nights: number;
  spotifyUri: string | null;
}

const NO_ENRICH: object = {};
type Memo = Map<string, SongInfo>;
const memo = new WeakMap<Catalog, WeakMap<object, Memo>>();
const tracksBySong = new WeakMap<Catalog, Map<string, Track[]>>();

/** Tracks of each song, played ones first; an anonymised track joins its twin's song. */
function songTracks(cat: Catalog): Map<string, Track[]> {
  let m = tracksBySong.get(cat);
  if (m) return m;
  m = new Map();
  const ix = catalogIndex(cat);
  for (const t of cat.tracks) {
    const sid = t.songId ?? (t.twinId ? ix.track.get(t.twinId)?.songId : null);
    if (!sid) continue;
    const l = m.get(sid);
    if (l) l.push(t); else m.set(sid, [t]);
  }
  tracksBySong.set(cat, m);
  return m;
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
};

/** Most common value; ties go to the first seen. */
function commonest(xs: string[]): string | null {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}

/** Real genres from file tags: "Rock; Pop" -> Rock, Pop; event labels dropped. */
export function tagGenres(tracks: Array<{ genre: string | null }>): string[] {
  const c = new Map<string, number>();
  for (const t of tracks) {
    for (const g of (t.genre ?? "").split(/[;,]/).map((x) => x.trim())) {
      if (g && !isEventLabel(g)) c.set(g, (c.get(g) ?? 0) + 1);
    }
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 4);
}

function build(
  rec: EnrichRecord | undefined, tracks: Track[], base: { songId: string | null; title: string; artist: string | null; nights: number },
): SongInfo {
  const used = tracks.some((t) => t.played) ? tracks.filter((t) => t.played) : tracks;
  const d = dateOf(rec);
  const family = familyOf(rec);
  const enrichGenres = rec && rec.confidence !== "none" ? rec.genres.filter((g) => g && !isEventLabel(g)) : [];
  return {
    ...base,
    album: albumOf(rec) ?? commonest(used.map((t) => tagAlbum(t.album)).filter((a): a is string => !!a)),
    durationSec: median(used.map((t) => t.durationSec).filter((s): s is number => !!s && s > 0)),
    year: yearOf(rec), releaseDate: d?.text ?? null, datePrecision: d?.precision ?? null,
    family, familyLabel: family ? familyLabel(family) : null,
    genres: enrichGenres.length ? enrichGenres : tagGenres(used),
    spotifyUri: used.find((t) => t.spotifyUri)?.spotifyUri ?? tracks.find((t) => t.spotifyUri)?.spotifyUri ?? null,
  };
}

/** Everything a song row shows. `what` is a songId or a track. Memoised per
 *  (catalogue, enrichment): the same objects give the same answer object, and a
 *  new enrichment map (it arrives after the catalogue) starts afresh. A track
 *  with no song identity is described by itself, uncached. */
export function songFactsFor(
  cat: Catalog, enrich: EnrichMap | null | undefined, what: string | Track,
): SongInfo {
  const ix = catalogIndex(cat);
  const songId = typeof what === "string" ? what : what.songId ?? (what.twinId ? ix.track.get(what.twinId)?.songId ?? null : null);
  if (!songId) {
    const t = typeof what === "string" ? null : what;
    return build(undefined, t ? [t] : [], {
      songId: null, title: t?.title ?? "(untitled)", artist: t?.artist ?? null, nights: 0,
    });
  }
  let byEnrich = memo.get(cat);
  if (!byEnrich) memo.set(cat, byEnrich = new WeakMap());
  const key = enrich ?? NO_ENRICH;
  let m = byEnrich.get(key);
  if (!m) byEnrich.set(key, m = new Map());
  let info = m.get(songId);
  if (!info) {
    const song = ix.song.get(songId);
    const tracks = songTracks(cat).get(songId) ?? [];
    const named = tracks.find((t) => t.title);
    info = build(enrich?.[songId], tracks, {
      songId, title: song?.title ?? named?.title ?? songId.split("|").pop() ?? songId,
      artist: song?.artist ?? named?.artist ?? null, nights: song?.nights.length ?? 0,
    });
    m.set(songId, info);
  }
  return info;
}

// ------------------------------------------------------------- formatting

/** "3:07"; "1:02:03" from an hour up. Rounds the whole value first, so 3599.6 is
 *  "1:00:00" and never "59:60". Null for unknown (zero is not a length). */
export function fmtDuration(s: number | null | undefined): string | null {
  if (s == null || !Number.isFinite(s) || s <= 0) return null;
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export const UNKNOWN = "—";
export const UNKNOWN_LABEL = "unknown";

// ------------------------------------------------------------------ links

export interface Link { href: string; exact: boolean }
export type LinkSource = Pick<SongInfo, "artist" | "title" | "spotifyUri">;

const query = (f: Pick<SongInfo, "artist" | "title">) => [f.artist, f.title].filter(Boolean).join(" ");

/** The track page when a `spotify:track:<id>` URI is known, else a search. */
export function spotifyHref(f: LinkSource): Link {
  const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(f.spotifyUri ?? "")?.[1];
  return id
    ? { href: `https://open.spotify.com/track/${id}`, exact: true }
    : { href: `https://open.spotify.com/search/${encodeURIComponent(query(f))}`, exact: false };
}

/** YouTube only ever searches (no video ids are held), so never exact. */
export function youtubeHref(f: LinkSource): Link {
  return { href: `https://www.youtube.com/results?search_query=${encodeURIComponent(query(f))}`, exact: false };
}

// ---------------------------------------------------------------- columns

export type SortVal = string | number | null;

export interface Column<R> {
  id: string;
  label: string;
  /** A CSS grid track: "minmax(0,1fr)", "72px". */
  width: string;
  align: "left" | "right";
  /** What sorting compares; null = not sortable. Unknown (null) always sorts last. */
  sortKey: ((r: R) => SortVal) | null;
  /** Plain text of the cell; null = unknown (drawn as an em-dash). */
  text: (r: R) => string | null;
  /** Hover text, when it says more than the cell. */
  title?: (r: R) => string | undefined;
  /** Not in the Columns menu: always shown. */
  locked?: boolean;
  /** Shown unless the user turned it off. Default true. */
  defaultOn?: boolean;
  /** Hidden when the viewport is narrower than this many px. */
  hideBelow?: number;
}

const ci = (s: string) => s.toLocaleLowerCase();
const dateKey = (i: SongInfo): number | null => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(i.releaseDate ?? "");
  return m ? +m[1] * 10000 + (+m[2] || 0) * 100 + (+m[3] || 0) : null;
};

/** The standard song columns over any row type. `cover` and `links` have no text:
 *  the page draws them (they are in the list so the menu can toggle them). */
export function songColumns<R>(get: (r: R) => SongInfo): Column<R>[] {
  return [
    { id: "cover", label: "Cover", width: "40px", align: "left", sortKey: null, text: () => null },
    { id: "title", label: "Title", width: "minmax(0,1.6fr)", align: "left", locked: true,
      sortKey: (r) => ci(get(r).title), text: (r) => get(r).title },
    { id: "artist", label: "Artist", width: "minmax(0,1fr)", align: "left",
      sortKey: (r) => { const a = get(r).artist; return a ? ci(a) : null; }, text: (r) => get(r).artist },
    { id: "album", label: "Album", width: "minmax(0,1fr)", align: "left", hideBelow: 1100,
      sortKey: (r) => { const a = get(r).album; return a ? ci(a) : null; }, text: (r) => get(r).album },
    { id: "duration", label: "Length", width: "64px", align: "right",
      sortKey: (r) => get(r).durationSec, text: (r) => fmtDuration(get(r).durationSec) },
    { id: "released", label: "Released", width: "72px", align: "right",
      sortKey: (r) => dateKey(get(r)), text: (r) => { const i = get(r); return i.year ? String(i.year) : null; },
      title: (r) => { const i = get(r); return i.releaseDate ? `Released ${i.releaseDate}` : undefined; } },
    { id: "genre", label: "Genre", width: "minmax(0,0.8fr)", align: "left", hideBelow: 1100,
      sortKey: (r) => { const i = get(r); const g = i.familyLabel ?? i.genres[0]; return g ? ci(g) : null; },
      text: (r) => { const i = get(r); return i.familyLabel ?? (i.genres.slice(0, 2).join(", ") || null); },
      title: (r) => get(r).genres.join(", ") || undefined },
    { id: "nights", label: "Nights", width: "64px", align: "right",
      sortKey: (r) => { const n = get(r).nights; return n > 0 ? n : null; },
      text: (r) => { const n = get(r).nights; return n > 0 ? String(n) : null; } },
    { id: "links", label: "Links", width: "64px", align: "right", sortKey: null, text: () => null },
  ];
}

/** Sorted copy; stable (ties keep their order); unknown values last either way. */
export function sortRows<R>(rows: readonly R[], key: (r: R) => SortVal, dir: "asc" | "desc"): R[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows.map((r, i) => ({ r, i, k: key(r) })).sort((a, b) => {
    const au = a.k === null || a.k === undefined, bu = b.k === null || b.k === undefined;
    if (au || bu) return au === bu ? a.i - b.i : au ? 1 : -1;
    const c = typeof a.k === "number" && typeof b.k === "number"
      ? a.k - b.k : String(a.k).localeCompare(String(b.k), undefined, { sensitivity: "base", numeric: true });
    return c ? sign * c : a.i - b.i;
  }).map((x) => x.r);
}

// -------------------------------------------------------- column choices

/** What a user changed from the defaults. Deltas, not a full list, so a column
 *  added later shows up by its own default instead of being silently hidden. */
export interface Choice { show: string[]; hide: string[] }
export const NO_CHOICE: Choice = { show: [], hide: [] };

/** Junk-proof: saved data comes from storage and may be anything. */
export function cleanChoice(raw: unknown): Choice {
  const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { show: strs(o.show), hide: strs(o.hide) };
}

export function isOn(c: Pick<Column<never>, "id" | "locked" | "defaultOn">, ch: Choice): boolean {
  if (c.locked) return true;
  if (ch.show.includes(c.id)) return true;
  if (ch.hide.includes(c.id)) return false;
  return c.defaultOn !== false;
}

export function toggleColumn(c: Pick<Column<never>, "id" | "defaultOn">, ch: Choice): Choice {
  const on = isOn({ ...c }, ch), def = c.defaultOn !== false;
  const rest = (xs: string[]) => xs.filter((x) => x !== c.id);
  const next = { show: rest(ch.show), hide: rest(ch.hide) };
  if (on && def) next.hide.push(c.id);          // was default-on, now off
  else if (!on && !def) next.show.push(c.id);   // was default-off, now on
  return next;                                  // back to the default: no delta
}

/** Columns to draw: chosen ones, and (when a width is given) those that fit it. */
export function visibleColumns<R>(cols: Column<R>[], ch: Choice, width = Infinity): Column<R>[] {
  return cols.filter((c) => isOn(c, ch) && !(c.hideBelow && width < c.hideBelow));
}

export const gridTemplate = (cols: Array<Pick<Column<never>, "width">>) => cols.map((c) => c.width).join(" ");
