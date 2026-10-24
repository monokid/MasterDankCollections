/** What the public databases add to ONE song's page, as pure logic: the facts
 *  line, the gap between release and first play, the "also in the library"
 *  neighbours, and which service a cover / year came from. No React, no DOM.
 *
 *  Enrichment is partial (a song may have no record, or a record with
 *  confidence "none"), so every function here accepts null/undefined and says
 *  nothing rather than invent something. */
import { decadeOf, familyOf, matched, yearOf, type EnrichMap, type EnrichRecord } from "./enrich.ts";
import { familyLabel } from "./families.ts";

// ------------------------------------------------------------------ facts

export interface SongFacts {
  year: number | null;
  /** The raw family key (for the colour dot) and its name for people. */
  family: string | null;
  familyName: string | null;
  /** Plain country name, or null when unknown / not an ISO code we can name. */
  country: string | null;
}

/** An ISO 3166 region code as a plain name ("JP" -> "Japan"). Free text that is
 *  not a two-letter code is kept as written; a code the runtime cannot name is dropped. */
export function countryName(code: string | null | undefined, locale = "en"): string | null {
  const c = (code ?? "").trim();
  if (!c) return null;
  if (!/^[A-Za-z]{2}$/.test(c)) return c;
  try {
    const n = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(c.toUpperCase());
    return n && n.toUpperCase() !== c.toUpperCase() && !/unknown/i.test(n) ? n : null;
  } catch {
    return null;
  }
}

export function songFacts(r: EnrichRecord | null | undefined): SongFacts {
  const family = familyOf(r);
  return {
    year: yearOf(r), family, familyName: family ? familyLabel(family) : null,
    country: matched(r) ? countryName(r.country) : null,
  };
}

export const hasFacts = (f: SongFacts) => f.year !== null || !!f.family || !!f.country;

// -------------------------------------------------------------------- gap

const EARLIEST_RELEASE = 1900;

/** "released 2011, first brought in 2016: 5 years later". Null when either year
 *  is missing or the order is impossible (a song cannot be brought before it
 *  exists: that match is wrong, so we stay silent rather than print "-3 years"). */
export function gapSentence(released: number | null, firstBrought: number | null): string | null {
  if (!Number.isInteger(released) || !Number.isInteger(firstBrought)) return null;
  const r = released as number, b = firstBrought as number;
  if (r < EARLIEST_RELEASE || b < r) return null;
  const n = b - r;
  if (n === 0) return `released ${r}, first brought the same year`;
  return `released ${r}, first brought in ${b}: ${n} ${n === 1 ? "year" : "years"} later`;
}

// ------------------------------------------------------------- neighbours

/** A library song with what we know about it. */
export interface PoolSong {
  songId: string;
  title: string;
  artist: string;
  artistId: string | null;
  nights: number;
  /** A song with no identity cannot open a page: never offered. */
  loose?: boolean;
  year: number | null;
  family: string | null;
}

/** Wall songs plus enrichment, as a pool. Songs without a record keep null year/family. */
export function poolOf(
  songs: Array<Omit<PoolSong, "year" | "family">>, enrich: EnrichMap | null,
): PoolSong[] {
  return songs.map((s) => {
    const r = enrich?.[s.songId];
    return { ...s, year: yearOf(r), family: familyOf(r) };
  });
}

export type NeighbourBasis = "family+decade" | "family" | "decade";
export interface Neighbours { basis: NeighbourBasis; label: string; songs: PoolSong[] }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Fewest nights first; ties by title, artist, id so the order never wobbles. */
export const rarerFirst = (a: PoolSong, b: PoolSong) =>
  a.nights - b.nights || cmp(a.title.toLowerCase(), b.title.toLowerCase())
  || cmp(a.artist.toLowerCase(), b.artist.toLowerCase()) || cmp(a.songId, b.songId);

/** Fewer than this and a narrower group is widened (same family, then same decade). */
export const MIN_NEIGHBOURS = 3;

/** Other songs of the same genre family and release decade; if that is thin,
 *  the same family; then the same decade. Never includes the song itself or a
 *  song with no page. Null when nothing is known about the song or nobody matches. */
export function neighbours(
  self: { songId: string; year: number | null; family: string | null },
  pool: PoolSong[], limit = 8, min = MIN_NEIGHBOURS,
): Neighbours | null {
  const dec = decadeOf(self.year);
  const fam = self.family;
  const others = pool.filter((s) => s.songId !== self.songId && !s.loose);
  const tries: Array<{ basis: NeighbourBasis; label: string; songs: PoolSong[] }> = [];
  if (fam && dec) {
    tries.push({
      basis: "family+decade", label: `${familyLabel(fam)} from the ${dec}`,
      songs: others.filter((s) => s.family === fam && decadeOf(s.year) === dec),
    });
  }
  if (fam) {
    tries.push({ basis: "family", label: `${familyLabel(fam)}, any decade`, songs: others.filter((s) => s.family === fam) });
  }
  if (dec) {
    tries.push({ basis: "decade", label: `from the ${dec}, any genre`, songs: others.filter((s) => decadeOf(s.year) === dec) });
  }
  const pick = tries.find((t) => t.songs.length >= min) ?? tries.find((t) => t.songs.length > 0);
  if (!pick) return null;
  return { basis: pick.basis, label: pick.label, songs: [...pick.songs].sort(rarerFirst).slice(0, Math.max(0, limit)) };
}

/** The artist's other songs in the library, most-brought first. */
export function moreFromArtist(selfId: string, artistSongs: PoolSong[], limit = 6): PoolSong[] {
  return artistSongs
    .filter((s) => s.songId !== selfId && !s.loose)
    .sort((a, b) => b.nights - a.nights || rarerFirst(a, b))
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------- sources

export type CoverSource = "Cover Art Archive" | "Deezer" | "iTunes";
type WithSource = EnrichRecord & { source?: string | null; coverSource?: string | null };

/** Which service the cover came from, judged from the record itself. */
export function coverSourceOf(r: EnrichRecord | null | undefined): CoverSource | null {
  if (!matched(r) || !r.cover) return null;
  const w = r as WithSource;
  if (w.coverSource === "deezer") return "Deezer";
  if (w.coverSource === "itunes") return "iTunes";
  if (r.coverUrl) {
    let host = "";
    try { host = new URL(r.coverUrl).hostname.toLowerCase(); } catch { /* unparseable: fall through */ }
    if (/(^|\.)(deezer|dzcdn)\./.test(host + ".")) return "Deezer";
    if (/(^|\.)(itunes|mzstatic)\./.test(host + ".") || host.endsWith("apple.com")) return "iTunes";
    if (host.includes("coverartarchive") || host.includes("archive.org")) return "Cover Art Archive";
    return null; // a host we do not recognise: claim nothing
  }
  return r.releaseGroup ? "Cover Art Archive" : null;
}

/** Where the year / genre came from: a Deezer or iTunes record says so, anything
 *  else matched is MusicBrainz. */
function dataSourceOf(r: EnrichRecord): "MusicBrainz" | "Deezer" | "iTunes" {
  const s = (r as WithSource).source;
  if (s === "deezer") return "Deezer";
  if (s === "itunes") return "iTunes";
  if (s === "musicbrainz") return "MusicBrainz";
  const c = coverSourceOf(r);
  return c === "Deezer" || c === "iTunes" ? c : "MusicBrainz";
}

/** A quiet line naming the services, only for what is actually shown. */
export function sourceNote(r: EnrichRecord | null | undefined): string | null {
  if (!matched(r)) return null;
  const hasYear = yearOf(r) !== null, hasFam = !!familyOf(r);
  const cover = coverSourceOf(r);
  if (!hasYear && !hasFam && !cover) return null;
  const data = dataSourceOf(r);
  const items = [cover ? "Cover art" : null, hasYear ? "year" : null, hasFam ? "genre" : null].filter(Boolean) as string[];
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
  const lead = items[0] === "Cover art" ? list : list[0].toUpperCase() + list.slice(1);
  // All from one place.
  const coverSvc = cover === "Cover Art Archive" ? "MusicBrainz" : cover;
  if (!cover || coverSvc === data) {
    return data === "MusicBrainz" && cover
      ? `${lead} come from MusicBrainz and the Cover Art Archive.`
      : `${lead} ${items.length > 1 ? "come" : "comes"} from ${data}.`;
  }
  // Mixed: say each part.
  const rest = items.filter((i) => i !== "Cover art");
  const restList = rest.length > 1 ? rest.join(" and ") : rest[0];
  return rest.length
    ? `Cover art comes from ${cover}; ${restList} from ${data}.`
    : `Cover art comes from ${cover}.`;
}

export const NOT_FOUND = "Not found in the public music databases";

/** The honest gap line: only when enrichment is loaded and this song has no match. */
export function notFoundLine(enrich: EnrichMap | null, r: EnrichRecord | null | undefined): string | null {
  return enrich && !matched(r) ? NOT_FOUND : null;
}
