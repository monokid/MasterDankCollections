/** "The sound of this night": what the enrichment layer says about the songs one
 *  night played. Pure; the page only draws it.
 *
 *  Unit is the SONG (songId), once per scope. Only `played` tracks count, so a
 *  named list and its anonymised twin, or a Spotify entry that repeats a file, are
 *  one play. Played tracks with no songId cannot be looked up: they are left out
 *  of every song fact and reported in `noSong`, so the denominator can say so. */
import type { Track } from "./catalog.ts";
import { coverUrlOf, decadeOf, familyOf, matched, yearOf, type EnrichMap } from "./enrich.ts";
import { FAMILY_ORDER } from "./families.ts";

/** Below this share of the night's songs known, the card is not shown. */
export const MIN_COVERAGE = 0.3;
export const MOSAIC_MAX = 12;

export interface SoundSong { songId: string; title: string; artist: string | null; year: number; }
export interface SoundCover { songId: string; title: string; artist: string | null; url: string; track: Track; }

export interface Sound {
  /** Distinct songs with a songId in this scope: the denominator. */
  songs: number;
  /** ...of which the enrichment has a believable match for. */
  known: number;
  /** Played tracks with no songId, left out of everything above. */
  noSong: number;
  /** Songs with a genre family, most first. Sums to `familyKnown`. */
  families: { family: string; count: number }[];
  familyKnown: number;
  /** One entry per decade from the earliest to the latest, gaps as zero. */
  decades: { decade: string; count: number }[];
  yearKnown: number;
  /** Lower middle year: at least half the dated songs are this year or earlier. */
  median: number | null;
  oldest: SoundSong | null;
  newest: SoundSong | null;
  covers: SoundCover[];
}

const fnv = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

export const coverage = (s: Pick<Sound, "songs" | "known">) => (s.songs ? s.known / s.songs : 0);

/** Whether the night's card should show at all. */
export const worthShowing = (s: Sound) => s.known > 0 && coverage(s) >= MIN_COVERAGE;

export function soundOf(tracks: Track[], enrich: EnrichMap | null | undefined): Sound {
  const bySong = new Map<string, Track[]>();
  let noSong = 0;
  for (const t of tracks) {
    if (!t.played) continue;
    if (!t.songId) { noSong++; continue; }
    const l = bySong.get(t.songId);
    if (l) l.push(t); else bySong.set(t.songId, [t]);
  }

  const fam = new Map<string, number>();
  const decade = new Map<number, number>();
  const dated: SoundSong[] = [];
  const withCover: SoundCover[] = [];
  let known = 0;

  for (const [songId, ts] of bySong) {
    const r = enrich?.[songId];
    if (!matched(r)) continue;
    known++;
    const f = familyOf(r);
    if (f) fam.set(f, (fam.get(f) ?? 0) + 1);
    const named = ts.find((t) => t.title) ?? ts[0];
    const title = named.title ?? named.artist ?? "Unknown song";
    const y = yearOf(r);
    if (y) {
      dated.push({ songId, title, artist: named.artist, year: y });
      const d = Math.floor(y / 10) * 10;
      decade.set(d, (decade.get(d) ?? 0) + 1);
    }
    const url = coverUrlOf(r);
    if (url) withCover.push({ songId, title, artist: named.artist, url, track: named });
  }

  const rank = (f: string) => { const i = (FAMILY_ORDER as readonly string[]).indexOf(f); return i < 0 ? 999 : i; };
  const families = [...fam.entries()].map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || rank(a.family) - rank(b.family) || a.family.localeCompare(b.family));

  const decades: Sound["decades"] = [];
  if (decade.size) {
    const ds = [...decade.keys()];
    for (let d = Math.min(...ds); d <= Math.max(...ds); d += 10) {
      decades.push({ decade: decadeOf(d)!, count: decade.get(d) ?? 0 });
    }
  }

  // Ties break on songId so the same night always gives the same answer.
  dated.sort((a, b) => a.year - b.year || a.songId.localeCompare(b.songId));
  const median = dated.length ? dated[(dated.length - 1) >> 1].year : null;

  return {
    songs: bySong.size, known, noSong, families, familyKnown: [...fam.values()].reduce((a, b) => a + b, 0),
    decades, yearKnown: dated.length, median,
    oldest: dated[0] ?? null, newest: dated.length ? dated[dated.length - 1] : null,
    covers: pickCovers(withCover),
  };
}

/** Up to MOSAIC_MAX covers, one per artist first, in a fixed pseudo-random order. */
export function pickCovers(all: SoundCover[], max = MOSAIC_MAX): SoundCover[] {
  const sorted = [...all].sort((a, b) => fnv(a.songId) - fnv(b.songId) || a.songId.localeCompare(b.songId));
  const seen = new Set<string>();
  const first: SoundCover[] = [], rest: SoundCover[] = [];
  for (const c of sorted) {
    // No artist: never treat unknowns as one artist.
    const k = c.artist ? c.artist.toLowerCase() : `\0${c.songId}`;
    if (seen.has(k)) rest.push(c); else { seen.add(k); first.push(c); }
  }
  return [...first, ...rest].slice(0, max);
}

/** The plain facts, as sentences. Empty when no song has a believable year. */
export function factLines(s: Sound): string[] {
  if (!s.oldest || !s.newest || s.median === null) return [];
  const only = (x: SoundSong) => `${x.title}${x.artist ? ` by ${x.artist}` : ""} (${x.year})`;
  if (s.yearKnown === 1) return [`The one song with a known year is ${only(s.oldest)}.`];
  const out = [`Half of it is from ${s.median} or earlier.`];
  if (s.oldest.year === s.newest.year) out.push(`Every song with a known year is from ${s.oldest.year}.`);
  else {
    out.push(`Oldest known: ${only(s.oldest)}.`);
    out.push(`Newest known: ${only(s.newest)}.`);
  }
  return out;
}

/** "known for 31 of 40 songs", plus what was left out and why. */
export function coverageLine(s: Sound): string {
  const base = `known for ${s.known} of ${s.songs} songs`;
  return s.noSong ? `${base} · ${s.noSong} more ${s.noSong === 1 ? "track has" : "tracks have"} no song match and ${s.noSong === 1 ? "is" : "are"} left out` : base;
}
