/** Pure rules behind "colour the timeline by sound" and the quiet enrichment
 *  lines on Home. Enrichment is partial, so every number here carries how much
 *  it rests on: a night with too few known songs is "not enough known", never a
 *  confident colour. */
import { coverUrlOf, decadeOf, familyOf, yearOf, type EnrichMap } from "./enrich.ts";
import { FAMILY_ORDER } from "./families.ts";

/** Below this share of known songs a night stays neutral. */
export const MIN_COVERAGE = 0.3;

/** The few track fields this reads (a Catalog Track satisfies it). */
export interface PlayedTrack {
  id: string;
  eventId: string;
  personId: string | null;
  songId: string | null;
  played: boolean;
}

export interface NightSound {
  /** Distinct (person, song) pairs played that night. */
  total: number;
  /** Of those, how many have a genre family. */
  known: number;
  coverage: number;
  /** Most common family among the known songs; null when none are known. */
  dominant: string | null;
  /** The dominant family's share of the known songs, 0-1. */
  share: number;
  /** Enough known songs (>= MIN_COVERAGE) to colour by. */
  enough: boolean;
  /** Median release decade of songs with a believable year, e.g. 1990. */
  decade: number | null;
}

const rank = (f: string) => {
  const i = (FAMILY_ORDER as readonly string[]).indexOf(f);
  return i < 0 ? FAMILY_ORDER.length : i;
};

/** Most common family; a tie goes to the earlier in FAMILY_ORDER (unlisted ones
 *  last, alphabetically), so the same night always gets the same colour. */
export function dominantFamily(counts: Map<string, number>): string | null {
  let best: string | null = null;
  for (const [f, n] of counts) {
    if (n <= 0) continue;
    if (best === null) { best = f; continue; }
    const b = counts.get(best)!;
    if (n > b || (n === b && (rank(f) < rank(best) || (rank(f) === rank(best) && f < best)))) best = f;
  }
  return best;
}

/** Median of the years, rounded down to a decade. Null for no years. */
export function medianDecade(years: number[]): number | null {
  if (!years.length) return null;
  const s = [...years].sort((a, b) => a - b);
  const m = s.length >> 1;
  const med = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.floor(med / 10) * 10;
}

/** Every night's sound. Only played tracks count (so an anonymised list and its
 *  named twin are one playlist, not two), and a song brought by one person is
 *  counted once that night however many copies or Spotify duplicates exist. */
export function nightSounds(tracks: PlayedTrack[], enrich: EnrichMap | null): Map<string, NightSound> {
  const seen = new Set<string>();
  const fam = new Map<string, Map<string, number>>();
  const yrs = new Map<string, number[]>();
  const tot = new Map<string, number>();
  const kn = new Map<string, number>();
  for (const t of tracks) {
    if (!t.played) continue;
    // A track with no song identity can only be itself.
    const key = `${t.eventId}\u0001${t.personId ?? ""}\u0001${t.songId ?? `#${t.id}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tot.set(t.eventId, (tot.get(t.eventId) ?? 0) + 1);
    const rec = t.songId && enrich ? enrich[t.songId] : null;
    const f = familyOf(rec);
    if (f) {
      kn.set(t.eventId, (kn.get(t.eventId) ?? 0) + 1);
      const m = fam.get(t.eventId) ?? new Map<string, number>();
      m.set(f, (m.get(f) ?? 0) + 1);
      fam.set(t.eventId, m);
    }
    const y = yearOf(rec);
    if (y) { const a = yrs.get(t.eventId) ?? []; a.push(y); yrs.set(t.eventId, a); }
  }
  const out = new Map<string, NightSound>();
  for (const [id, total] of tot) {
    const known = kn.get(id) ?? 0;
    const counts = fam.get(id);
    const dominant = counts ? dominantFamily(counts) : null;
    const coverage = total ? known / total : 0;
    out.set(id, {
      total, known, coverage, dominant,
      share: dominant && known ? counts!.get(dominant)! / known : 0,
      enough: dominant !== null && coverage >= MIN_COVERAGE,
      decade: medianDecade(yrs.get(id) ?? []),
    });
  }
  return out;
}

/** Legend rows: families in FAMILY_ORDER with how many nights they dominate. */
export function legendCounts(sounds: Iterable<NightSound>): { family: string; nights: number }[] {
  const c = new Map<string, number>();
  for (const s of sounds) if (s.enough && s.dominant) c.set(s.dominant, (c.get(s.dominant) ?? 0) + 1);
  return [...c].map(([family, nights]) => ({ family, nights }))
    .sort((a, b) => b.nights - a.nights || rank(a.family) - rank(b.family) || (a.family < b.family ? -1 : 1));
}

// ------------------------------------------------------------------- Home

export interface YearRange {
  from: number; to: number;
  /** The oldest was a lone outlier, so `from` is the 2nd percentile instead. */
  trimmed: boolean;
}

/** Oldest and newest believable release years. The oldest is trusted only when
 *  at least 3 songs lie within 5 years of it; otherwise a single odd match (or
 *  two) would stretch the range, so the 2nd percentile is used and `trimmed` set. */
export function yearRange(years: number[]): YearRange | null {
  if (!years.length) return null;
  const s = [...years].sort((a, b) => a - b);
  const min = s[0], to = s[s.length - 1];
  const near = s.filter((y) => y - min <= 5).length;
  if (near >= 3) return { from: min, to, trimmed: false };
  const p2 = s[Math.min(s.length - 1, Math.floor(s.length * 0.02))];
  return { from: p2, to, trimmed: p2 !== min };
}

export interface HomeSound {
  range: YearRange | null;
  /** Families (other than "other") with at least `minSongs` songs. */
  genres: number;
  art: number;
  songs: number;
}

export function homeSound(enrich: EnrichMap | null, songTotal?: number, minSongs = 5): HomeSound | null {
  if (!enrich) return null;
  const recs = Object.values(enrich);
  if (!recs.length) return null;
  const years: number[] = [];
  const fams = new Map<string, number>();
  let art = 0;
  for (const r of recs) {
    const y = yearOf(r); if (y) years.push(y);
    const f = familyOf(r); if (f && f !== "other") fams.set(f, (fams.get(f) ?? 0) + 1);
    if (coverUrlOf(r)) art++;
  }
  return {
    range: yearRange(years),
    genres: [...fams.values()].filter((n) => n >= minSongs).length,
    art,
    songs: Math.max(songTotal ?? 0, recs.length),
  };
}

/** The Home lines, only the ones with something to say. */
export function homeLines(h: HomeSound | null): string[] {
  if (!h) return [];
  const out: string[] = [];
  if (h.range) out.push(`${h.range.trimmed ? "most music" : "music"} from ${h.range.from} to ${h.range.to}`);
  if (h.genres > 0) out.push(`${h.genres} genres`);
  if (h.art > 0) out.push(`${h.art.toLocaleString()} of ${h.songs.toLocaleString()} songs have art on file`);
  return out;
}

export { decadeOf };
