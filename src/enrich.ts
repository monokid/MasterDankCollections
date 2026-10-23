/** What public music databases say about a song: release year, genre family,
 *  cover art. A layer of its own -- the catalogue never reads it -- keyed by
 *  songId and shipped inside the sealed vault. It is partial by nature (not every
 *  song matches), so every consumer must work without it and say how much of the
 *  library it covers.
 *
 *  Mirrors the fields of tools/enrich.ts `Enriched` that the app needs. */

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
