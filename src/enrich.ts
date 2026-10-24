/** What public music databases say about a song: release year, genre family,
 *  cover art. A layer of its own -- the catalogue never reads it -- keyed by
 *  songId and shipped inside the sealed vault. It is partial by nature (not every
 *  song matches), so every consumer must work without it and say how much of the
 *  library it covers.
 *
 *  Mirrors the fields of tools/enrich.ts `Enriched` that the app needs. */

import { isEventLabel } from "./analytics.ts";

export type EnrichConfidence = "high" | "medium" | "none";

export interface EnrichRecord {
  songId: string;
  confidence: EnrichConfidence;
  year: number | null;
  /** The match is wrong (released after it was first played): ignore the year. */
  yearSuspect?: boolean;
  genres: string[];
  /** One of ~25 families, e.g. "metal", "psytrance/trance", "j-pop/anime". */
  family?: string | null;
  genreConfidence?: "ok" | "low" | null;
  country: string | null;
  releaseGroup: string | null;
  cover: boolean;
  /** A hotlinked image (Deezer or iTunes); Cover Art Archive covers are derived. */
  coverUrl?: string | null;
  /** The release's album title. Added later by the enrich job: may be absent. */
  album?: string | null;
  /** 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY'; its year equals `year`. May be absent. */
  releaseDate?: string | null;
  /** Which service the album / date came from. */
  albumSource?: string | null;
}

export type EnrichMap = Record<string, EnrichRecord>;

/** A record worth reading at all. */
export const matched = (r: EnrichRecord | null | undefined): r is EnrichRecord =>
  !!r && r.confidence !== "none";

/** Release year, only when the match can be believed. */
export const yearOf = (r: EnrichRecord | null | undefined): number | null =>
  matched(r) && !r.yearSuspect && r.year ? r.year : null;

/** Genre family, only for a match. */
export const familyOf = (r: EnrichRecord | null | undefined): string | null =>
  matched(r) ? r.family ?? null : null;

/** The cover image to show, or null (the page then draws its own tile). */
export function coverUrlOf(r: EnrichRecord | null | undefined): string | null {
  if (!matched(r) || !r.cover) return null;
  if (r.coverUrl) return r.coverUrl;
  return r.releaseGroup ? `https://coverartarchive.org/release-group/${r.releaseGroup}/front-250` : null;
}

/** The decade of a release year: 1987 -> "1980s". */
export const decadeOf = (year: number | null): string | null =>
  year ? `${Math.floor(year / 10) * 10}s` : null;

/** The album a match says the song is on. A record that is not a believable
 *  match says nothing; a file's own album tag (when given) is the fallback.
 *  Tags that are only the label of a night ("Roll") are not albums. */
export function albumOf(
  r: EnrichRecord | null | undefined, track?: { album?: string | null } | null,
): string | null {
  const fromRec = matched(r) ? r.album?.trim() : "";
  if (fromRec) return fromRec;
  return tagAlbum(track?.album);
}

/** A file's album tag, or null when empty or just an event label. */
export function tagAlbum(a: string | null | undefined): string | null {
  const t = a?.trim();
  return t && !isEventLabel(t) ? t : null;
}

export type DatePrecision = "day" | "month" | "year";
export interface ReleaseDate { text: string; precision: DatePrecision }

/** The release date to show, at the precision it is known. The year always
 *  agrees with `yearOf` (a suspect or unmatched record has none, and a date whose
 *  year disagrees with `year` is dropped back to the year alone). */
export function dateOf(r: EnrichRecord | null | undefined): ReleaseDate | null {
  const year = yearOf(r);
  if (!year) return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(r?.releaseDate?.trim() ?? "");
  if (m && +m[1] === year) {
    const mo = m[2] ? +m[2] : 0, d = m[3] ? +m[3] : 0;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { text: m[0], precision: "day" };
    if (mo >= 1 && mo <= 12 && !m[3]) return { text: m[0], precision: "month" };
  }
  return { text: String(year), precision: "year" };
}
