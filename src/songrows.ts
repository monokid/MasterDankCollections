/** Small pure pieces the Music wall and artist page use to put the shared song
 *  facts on their own row types (WallSong). No React, so tools/songrows.test.ts runs it. */
import type { Catalog } from "./catalog.ts";
import type { EnrichMap } from "./enrich.ts";
import { fmtDuration, songFactsFor, type Column, type SongInfo } from "./songcols.ts";

/** The slice of a wall song the facts need. */
export interface SongLike { songId: string; title: string; artist: string; loose: boolean; nights: number }

/** One SongInfo per wall song. Title, artist and the night count are the wall's
 *  own (it counts dated, played nights); the rest is the shared per-song answer.
 *  A loose song (no song id) has nothing to look up: just its title and artist. */
export function makeWallInfo(cat: Catalog, enrich: EnrichMap | null | undefined): (s: SongLike) => SongInfo {
  const memo = new WeakMap<object, SongInfo>();
  return (s) => {
    let i = memo.get(s);
    if (i) return i;
    const base = s.loose ? null : songFactsFor(cat, enrich, s.songId);
    i = {
      songId: s.loose ? null : s.songId,
      album: null, durationSec: null, year: null, releaseDate: null, datePrecision: null,
      family: null, familyLabel: null, genres: [], spotifyUri: null,
      ...base,
      title: s.title, artist: s.artist || null, nights: s.nights,
    };
    memo.set(s, i);
    return i;
  };
}

/** Links need something to search for: an artist, or a real title. */
export function linkable(i: Pick<SongInfo, "artist" | "title">): boolean {
  const t = (i.title ?? "").trim();
  return !!(i.artist?.trim() || (t && t !== "(untitled)"));
}

/** A tile's quiet line: "4:35 · 2017 · 9 nights · 2015–2026". Unknown parts are left out. */
export function tileQuiet(i: Pick<SongInfo, "durationSec" | "year">, nights: string, span: string): string {
  return [fmtDuration(i.durationSec), i.year ? String(i.year) : null, nights, span].filter(Boolean).join(" · ");
}

export interface ColSort { id: string; dir: "asc" | "desc" }

/** A header click: off -> ascending -> descending -> off; another column starts at ascending. */
export function nextSort(cur: ColSort | null, id: string): ColSort | null {
  if (!cur || cur.id !== id) return { id, dir: "asc" };
  return cur.dir === "asc" ? { id, dir: "desc" } : null;
}

export interface Arrange<R> {
  /** Column ids to leave out. */
  drop?: string[];
  /** Column ids that start switched off. */
  off?: string[];
  /** Per-column overrides (width, alignment ...). */
  patch?: Record<string, Partial<Column<R>>>;
  /** Page-only columns, each placed before an existing id (at the end if it is absent). */
  extra?: Array<{ col: Column<R>; before: string }>;
}

/** The standard columns, shaped for one page. Input is not modified. */
export function arrangeColumns<R>(std: Column<R>[], o: Arrange<R> = {}): Column<R>[] {
  const out = std.filter((c) => !o.drop?.includes(c.id)).map((c) => {
    const off = o.off?.includes(c.id) ? { defaultOn: false } : null;
    const p = o.patch?.[c.id];
    return p || off ? { ...c, ...p, ...off } : c;
  });
  for (const { col, before } of o.extra ?? []) {
    const at = out.findIndex((c) => c.id === before);
    if (at < 0) out.push(col); else out.splice(at, 0, col);
  }
  return out;
}
