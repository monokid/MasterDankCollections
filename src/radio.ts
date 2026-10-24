/** The cosmic radio's brain: which songs belong to the "psychedelic, spacey,
 *  organic" pool, and a shuffler that walks a pool without repeating itself.
 *  Pure: no React, no DOM, no network -- tools/radio.test.ts runs it.
 *
 *  The pool is designed from the real library (families and raw genre tags
 *  counted in the enrichment): see the weight tables below. A song's weight is
 *  how likely the shuffle is to reach for it; 0 means never in the Cosmic pool. */
import type { Catalog } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import type { SongInfo } from "./songcols.ts";

// ------------------------------------------------------------------ events

export type RadioMode = "cosmic" | "library" | "night" | "artist";

/** What the small play buttons around the app ask the radio for. `radio` means
 *  "start in whatever mode is remembered" (the `r` key and the pill). `songIds`
 *  carries a prepared list for `library` (the Music wall's filtered songs). */
export interface PlayDetail {
  mode: "radio" | "song" | "night" | "artist" | "library";
  songId?: string;
  eventId?: string;
  artistId?: string;
  songIds?: string[];
}

export const PLAY_EVENT = "mdc:play";

/** Ask the player to start. Safe to call before the player has loaded. */
export function requestPlay(detail: PlayDetail): void {
  window.dispatchEvent(new CustomEvent<PlayDetail>(PLAY_EVENT, { detail }));
}

// ----------------------------------------------------------------- scoring

/** Families that are the heart of the pool. */
const FAMILY_WEIGHT: Record<string, number> = {
  "psytrance/trance": 10,
  "ambient/downtempo": 8,
  "post-rock/prog": 6,
  "synthwave": 6,
  "reggae/dub": 2,          // dub is spacious; the rest of reggae needs a tag to get in
  "world": 1,
};

/** Never in the Cosmic pool, whatever else a song is tagged. */
const VETO_FAMILY = new Set([
  "hip hop", "punk", "country", "comedy/novelty", "hard dance/hardcore", "dubstep/bass", "j-pop/anime",
]);

/** Raw tags that veto a song (the fast, loud and silly ends of the library). */
const VETO_TAG = /punk|\brap\b|hip hop|country|comedy|hardcore|hardstyle|gabber|frenchcore|speedcore|j-?core|eurodance|\bedm\b|big room|bass house|electro house|dubstep|drumstep|brostep|\btrap\b|k-pop|j-pop|vocaloid|christmas|children|polka|doujin|touhou/i;

/** Raw genre tags, first match wins per tag, best tag counts. Substring rules
 *  as the real tags are messy ("neo-psychedelia", "goa trance", "ambient dub"). */
const TAG_WEIGHT: Array<[RegExp, number]> = [
  [/psytrance|psychedelic trance|\bgoa\b|psybient|full-on|krautrock|kosmische|space rock|\bspace\b|cosmic/i, 10],
  [/psychedelic|psych\b|heavy psych|acid rock|neo-psychedel|dark ambient|ambient dub|drone|shoegaze|post-rock|trip hop|trip-hop/i, 8],
  [/\btrance\b|ambient|downtempo|chill ?out|new age|\bdream|ethereal|synthwave|outrun|darksynth|chillwave|vaporwave|hauntology/i, 7],
  [/progressive rock|krautrock|symphonic prog|crossover prog|neo-progressive|avant-prog|canterbury|stoner|desert rock/i, 6],
  [/electronica|idm|folktronica|psychedelic folk|glitch|\bprogressive\b(?! metal)|lounge|\bdub\b|art rock|experimental/i, 4],
  [/\belectronic\b|instrumental|post-metal|downtempo|minimal|math rock|jam band|krautrock|indietronica/i, 2],
];
/** "ambient-ish": the only tags that let classical and soundtrack music in. */
const AMBIENTISH = /ambient|new age|drone|psybient|chill ?out|space|cosmic|dark ambient|minimal|hauntology|ethereal|dungeon synth/i;
/** Families that are in only through an ambient-ish tag, and then at medium weight. */
const MEDIUM_FAMILY = new Set(["classical", "vgm/soundtrack"]);
const MEDIUM_CAP = 4;

export const tagWeight = (tag: string): number => {
  for (const [re, w] of TAG_WEIGHT) if (re.test(tag)) return w;
  return 0;
};

type Scored = Pick<SongInfo, "family" | "genres">;

/** A song's own cosmic weight from its family and tags, before the artist rule. 0 = out. */
export function baseScore(info: Scored): number {
  if (info.family && VETO_FAMILY.has(info.family)) return 0;
  if (info.genres.some((g) => VETO_TAG.test(g))) return 0;
  const famW = info.family ? FAMILY_WEIGHT[info.family] ?? 0 : 0;
  const tags = info.genres.map(tagWeight).sort((a, b) => b - a);
  if (info.family && MEDIUM_FAMILY.has(info.family)) {
    return info.genres.some((g) => AMBIENTISH.test(g)) ? Math.min(MEDIUM_CAP, tags[0] || MEDIUM_CAP) : 0;
  }
  const best = Math.max(famW, tags[0] ?? 0);
  if (best <= 0) return 0;
  return Math.min(12, best + 0.25 * (tags[0] && famW ? Math.min(tags[0], famW) : tags[1] ?? 0));
}

/** How cosmic the song is, 0 (never in the Cosmic pool) to about 12. `affinity` is the
 *  artist rule: 0..1, the share of the artist's OTHER songs that are cosmic. Artists
 *  who are mostly cosmic pull in their songs that carry no genre of their own. */
export function cosmicScore(info: Scored, affinity = 0): number {
  const base = baseScore(info);
  if (info.family && VETO_FAMILY.has(info.family)) return 0;
  if (info.genres.some((g) => VETO_TAG.test(g))) return 0;
  const boost = affinity >= 0.5 ? 1 + 3 * affinity : 0;
  return base + boost;
}

/** A song needs at least this weight to be in the pool: a bare "electronic" or
 *  "instrumental" tag (weight 2) only adds to a song that is cosmic for other reasons. */
export const MIN_POOL = 3;

/** A song counts as cosmic evidence for its artist from this base score up. */
const EVIDENCE = 4;

export interface Candidate { songId: string; artistId: string; weight: number }

export const artistOf = (songId: string): string => songId.split("|")[0];

/** Every song with a cosmic weight above 0, plus each song's weight. Songs need an
 *  artist and a title to be findable at all. */
export function cosmicPool(infos: SongInfo[]): Candidate[] {
  const usable = infos.filter((i): i is SongInfo & { songId: string } => !!i.songId && !!i.artist && !!i.title);
  const byArtist = new Map<string, number[]>();      // artist -> base scores of its songs
  for (const i of usable) {
    const a = artistOf(i.songId);
    const l = byArtist.get(a);
    if (l) l.push(baseScore(i)); else byArtist.set(a, [baseScore(i)]);
  }
  const out: Candidate[] = [];
  for (const i of usable) {
    const a = artistOf(i.songId);
    const mine = baseScore(i);
    const all = byArtist.get(a)!;
    const others = all.length - 1;
    let affinity = 0;
    if (others > 0) {
      const cosmicOthers = all.filter((s) => s >= EVIDENCE).length - (mine >= EVIDENCE ? 1 : 0);
      // one cosmic neighbour is a coincidence, two are a taste
      affinity = cosmicOthers >= 2 ? cosmicOthers / others : 0;
    }
    const w = cosmicScore(i, affinity);
    if (w >= MIN_POOL) out.push({ songId: i.songId, artistId: a, weight: w });
  }
  return out;
}

/** The whole library, every song equally likely. */
export function libraryPool(infos: SongInfo[]): Candidate[] {
  const out: Candidate[] = [];
  for (const i of infos) {
    if (i.songId && i.artist && i.title) out.push({ songId: i.songId, artistId: artistOf(i.songId), weight: 1 });
  }
  return out;
}

/** Equal weights over a list of song ids (a night, an artist, a selection). */
export function listPool(songIds: string[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const id of songIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ songId: id, artistId: artistOf(id), weight: 1 });
  }
  return out;
}

/** Songs played on a night (a song once, twins folded in), in catalogue order. */
export function nightSongIds(cat: Catalog, eventId: string): string[] {
  const ix = catalogIndex(cat);
  const out: string[] = [];
  for (const t of ix.tracksOfEvent.get(eventId) ?? []) {
    if (!t.played) continue;
    const sid = t.songId ?? (t.twinId ? ix.track.get(t.twinId)?.songId : null);
    if (sid) out.push(sid);
  }
  return [...new Set(out)];
}

/** Songs of an artist, in catalogue order. */
export function artistSongIds(cat: Catalog, artistId: string): string[] {
  return cat.songs.filter((s) => artistOf(s.id) === artistId).map((s) => s.id);
}

// ---------------------------------------------------------------- shuffler

/** Small seeded generator (mulberry32): the same seed walks the same road. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ARTIST_MEMORY = 8;

export interface Shuffler {
  /** The next song, or null when the pool is empty. */
  next(): Candidate | null;
  /** Songs not yet played in this lap. */
  remaining(): number;
  size: number;
}

/** Weighted random without replacement: a song is not heard twice until every
 *  song has been (then a new lap starts), and an artist is not heard again within
 *  the last `memory` plays whenever another artist is left to play. */
export function createShuffler(pool: Candidate[], seed = Date.now(), memory = ARTIST_MEMORY): Shuffler {
  const rand = rng(seed);
  const items = pool.filter((c) => c.weight > 0);
  let left = items.slice();
  const recent: string[] = [];
  return {
    size: items.length,
    remaining: () => left.length,
    next() {
      if (!items.length) return null;
      if (!left.length) left = items.slice();
      let eligible = left.filter((c) => !recent.includes(c.artistId));
      if (!eligible.length) eligible = left;                    // a lone artist, or the tail of a lap
      let total = 0;
      for (const c of eligible) total += c.weight;
      let r = rand() * total, pick = eligible[eligible.length - 1];
      for (const c of eligible) { r -= c.weight; if (r < 0) { pick = c; break; } }
      left.splice(left.indexOf(pick), 1);
      recent.push(pick.artistId);
      if (recent.length > memory) recent.shift();
      return pick;
    },
  };
}
