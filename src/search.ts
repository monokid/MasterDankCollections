/** Client-side search over the whole catalogue.
 *
 *  At this scale (thousands of tracks, not millions) a purpose-built scorer
 *  beats pulling in an index library: it loads instantly, ships no extra bytes,
 *  and lets the ranking encode what actually matters here -- a title match
 *  outranks an artist match, a whole-word hit outranks a fragment, and an
 *  anonymised track never outranks a named one.
 */
import type { Catalog, Track } from "./catalog.ts";

export interface Indexed {
  track: Track;
  /** How many separate nights this track's song was played on. */
  nights: number;
  title: string;
  artist: string;
  album: string;
  person: string;
  event: string;
  haystack: string;
}

export interface Hit { track: Track; score: number; indexed: Indexed }

const fold = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export function buildIndex(cat: Catalog): Indexed[] {
  const people = new Map(cat.people.map((p) => [p.id, p.name]));
  const events = new Map(cat.events.map((e) => [e.id, e]));
  const songNights = new Map(cat.songs.map((s) => [s.id, s.nights.length]));
  return cat.tracks.map((track) => {
    const ev = events.get(track.eventId);
    const person = track.personId ? people.get(track.personId) ?? "" : "";
    const event = ev ? [ev.date ?? "", ev.title, ev.type ?? "", ev.folder].join(" ") : "";
    const title = track.title ?? "";
    const artist = track.artist ?? "";
    const album = track.album ?? "";
    return {
      track, title, artist, album, person, event,
      nights: track.songId ? songNights.get(track.songId) ?? 1 : 1,
      haystack: fold([title, artist, album, person, event].join("  ")),
    };
  });
}

/** Scores a single record. Returns 0 for "not a match" so callers can filter. */
function score(rec: Indexed, terms: string[]): number {
  let total = 0;
  for (const term of terms) {
    const t = fold(rec.title);
    const a = fold(rec.artist);
    const al = fold(rec.album);
    const p = fold(rec.person);
    const e = fold(rec.event);

    let best = 0;
    // Field weights: what you searched for is usually a song, then an artist.
    const fields: [string, number][] = [[t, 10], [a, 8], [al, 5], [p, 4], [e, 3]];
    for (const [value, weight] of fields) {
      if (!value) continue;
      const i = value.indexOf(term);
      if (i < 0) continue;
      let s = weight;
      if (i === 0) s *= 2.2;                                   // prefix match
      else if (/[\s\-([]/.test(value[i - 1] ?? "")) s *= 1.7;  // word start
      if (value === term) s *= 2.6;                            // exact field
      // Shorter fields matching means the term is a bigger share of it.
      s *= 1 + Math.min(term.length / Math.max(value.length, 1), 1) * 0.5;
      best = Math.max(best, s);
    }
    if (best === 0) return 0;    // every term must appear somewhere
    total += best;
  }
  // Anonymised tracks are noise: findable, but never above a named result.
  if (rec.track.flags.includes("anon")) total *= 0.15;
  // A song that survived a decade of events outranks one played once. This
  // used to be a penalty -- recurrence was mistaken for duplication, which had
  // the ranking exactly backwards.
  total *= 1 + Math.min(rec.nights, 10) * 0.07;
  return total;
}

export interface SearchOptions {
  includeAnon?: boolean;
  limit?: number;
  personId?: string | null;
  eventId?: string | null;
}

export function search(index: Indexed[], query: string, opts: SearchOptions = {}): Hit[] {
  const { includeAnon = false, limit = 200, personId = null, eventId = null } = opts;
  const terms = fold(query).split(/\s+/).filter(Boolean);

  const pool = index.filter((r) =>
    (includeAnon || !r.track.flags.includes("anon")) &&
    (!personId || r.track.personId === personId) &&
    (!eventId || r.track.eventId === eventId));

  if (!terms.length) {
    return pool.slice(0, limit).map((indexed) => ({ track: indexed.track, score: 0, indexed }));
  }

  const hits: Hit[] = [];
  for (const rec of pool) {
    // Cheap reject before the per-field work.
    if (!terms.every((t) => rec.haystack.includes(t))) continue;
    const s = score(rec, terms);
    if (s > 0) hits.push({ track: rec.track, score: s, indexed: rec });
  }
  hits.sort((x, y) => y.score - x.score || (x.indexed.title).localeCompare(y.indexed.title));
  return hits.slice(0, limit);
}

/** Highlights the matched fragments of a field for display. */
export function highlight(value: string, query: string): Array<[string, boolean]> {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length || !value) return [[value, false]];
  const folded = fold(value);
  const marks = new Array<boolean>(value.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const i = folded.indexOf(term, from);
      if (i < 0) break;
      for (let k = i; k < i + term.length && k < marks.length; k++) marks[k] = true;
      from = i + term.length;
    }
  }
  const out: Array<[string, boolean]> = [];
  let cur = "", curMark = marks[0] ?? false;
  for (let i = 0; i < value.length; i++) {
    if (marks[i] === curMark) cur += value[i];
    else { out.push([cur, curMark]); cur = value[i]; curMark = marks[i]; }
  }
  if (cur) out.push([cur, curMark]);
  return out;
}
