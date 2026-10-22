/** What the library says about itself, computed from the catalogue.
 *
 *  Pure functions with no UI in them, so every figure on the Insights page can
 *  be tested on its own. Anything that depends on the selected range takes it
 *  as a parameter; anything that is a fact about history ("who first brought
 *  this song") deliberately ignores it, because a song does not stop having been
 *  first played in 2016 because you are looking at 2021.
 */
import type { Audio, Catalog, Event, Track, Song, ArtistEntry } from "./catalog.ts";

/** An inclusive span of dates, ISO strings. */
export interface Range { from: string; to: string }

export const inRange = (date: string | null | undefined, r: Range | null) =>
  !r || (!!date && date >= r.from && date <= r.to);

/** Dated nights in the range, oldest first. Collections are shelves, not nights. */
export function nightsOf(cat: Catalog, r: Range | null = null): Event[] {
  return cat.events
    .filter((e) => e.kind !== "collection" && e.date && inRange(e.date, r))
    .sort((a, b) => a.date!.localeCompare(b.date!));
}

/** Named tracks played on those nights. Anonymised copies are the same playlist
 *  again, so counting them would count every set twice. */
export function playedOf(cat: Catalog, r: Range | null = null): Track[] {
  const ok = new Set(nightsOf(cat, r).map((e) => e.id));
  return cat.tracks.filter((t) => ok.has(t.eventId) && !t.flags.includes("anon"));
}

const yearOf = (d: string) => d.slice(0, 4);

// ---------------------------------------------------------------- discovery

export interface YearRate { year: string; played: number; fresh: number; rate: number }

/** How much of each year was music the library had never heard before.
 *
 *  "Fresh" is judged against the whole history, not the selected range: a song
 *  first played in 2016 is not new in 2021 just because 2016 is out of view. */
export function discovery(cat: Catalog, r: Range | null = null): YearRate[] {
  const first = new Map(cat.songs.map((s) => [s.id, s.nights[0]]));
  const by = new Map<string, { played: number; fresh: number }>();
  const date = new Map(cat.events.map((e) => [e.id, e.date]));
  for (const t of playedOf(cat, r)) {
    if (!t.songId) continue;
    const y = yearOf(date.get(t.eventId)!);
    const row = by.get(y) ?? { played: 0, fresh: 0 };
    row.played++;
    if (first.get(t.songId) === t.eventId) row.fresh++;
    by.set(y, row);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, v]) => ({ year, ...v, rate: v.played ? v.fresh / v.played : 0 }));
}

// -------------------------------------------------------------- tastemakers

export interface Taste { personId: string; count: number }

/** Who first brings the songs that go on to stick.
 *
 *  A song that recurs on `minNights` nights or more became part of the canon;
 *  whoever had it on the night it first appeared started it. When two people
 *  brought it that same night, both get the credit. */
export function tastemakers(cat: Catalog, minNights = 3): { rows: Taste[]; songs: number } {
  const bySong = new Map<string, Track[]>();
  for (const t of cat.tracks) {
    if (!t.songId || t.flags.includes("anon")) continue;
    if (!bySong.has(t.songId)) bySong.set(t.songId, []);
    bySong.get(t.songId)!.push(t);
  }
  const count = new Map<string, number>();
  let songs = 0;
  for (const s of cat.songs) {
    if (s.nights.length < minNights) continue;
    const starters = new Set((bySong.get(s.id) ?? [])
      .filter((t) => t.eventId === s.nights[0] && t.personId).map((t) => t.personId!));
    if (!starters.size) continue;
    songs++;
    for (const p of starters) count.set(p, (count.get(p) ?? 0) + 1);
  }
  return {
    songs,
    rows: [...count.entries()].map(([personId, n]) => ({ personId, count: n }))
      .sort((a, b) => b.count - a.count),
  };
}

// ----------------------------------------------------------- longevity

export interface Span { song: Song; years: number; from: string; to: string }

/** Songs ranked by how long they stayed in rotation. */
export function lifespans(cat: Catalog): Span[] {
  return cat.songs
    .filter((s) => s.nights.length >= 2 && s.firstPlayed && s.lastPlayed)
    .map((s) => ({
      song: s, from: s.firstPlayed!, to: s.lastPlayed!,
      years: Number(yearOf(s.lastPlayed!)) - Number(yearOf(s.firstPlayed!)),
    }))
    .sort((a, b) => b.years - a.years || b.song.nights.length - a.song.nights.length);
}

export interface Comeback { song: Song; gapYears: number; from: string; to: string }

const YEAR_MS = 365.25 * 86400000;

/** Songs that disappeared for `minGap` years or more and then came back. */
export function comebacks(cat: Catalog, minGap = 5): Comeback[] {
  const date = new Map(cat.events.map((e) => [e.id, e.date]));
  const out: Comeback[] = [];
  for (const s of cat.songs) {
    const ds = s.nights.map((n) => date.get(n)).filter(Boolean).sort() as string[];
    let best: Comeback | null = null;
    for (let i = 1; i < ds.length; i++) {
      const gap = (Date.parse(ds[i]) - Date.parse(ds[i - 1])) / YEAR_MS;
      if (gap >= minGap && (!best || gap > best.gapYears)) {
        best = { song: s, gapYears: gap, from: ds[i - 1], to: ds[i] };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.gapYears - a.gapYears);
}

// ------------------------------------------------------------ loyalty

export interface Loyal { artist: ArtistEntry; years: number }

/** Artists by how many different years they turned up in -- not nights. An
 *  artist played twice a night for two years is less of a fixture than one who
 *  came back every year. */
export function artistYears(cat: Catalog): Loyal[] {
  const date = new Map(cat.events.map((e) => [e.id, e.date]));
  return cat.artists.map((a) => ({
    artist: a,
    years: new Set(a.nights.map((n) => date.get(n)).filter(Boolean).map((d) => yearOf(d!))).size,
  })).sort((a, b) => b.years - a.years || b.artist.nights.length - a.artist.nights.length);
}

// -------------------------------------------------------------- the cast

export interface CastYear { year: string; nights: number; avgPeople: number; people: number }

export function cast(cat: Catalog, r: Range | null = null): CastYear[] {
  const by = new Map<string, { nights: number; sum: number; who: Set<string> }>();
  for (const e of nightsOf(cat, r)) {
    const y = yearOf(e.date!);
    const row = by.get(y) ?? { nights: 0, sum: 0, who: new Set<string>() };
    row.nights++; row.sum += e.people.length;
    e.people.forEach((p) => row.who.add(p));
    by.set(y, row);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, v]) => ({ year, nights: v.nights, avgPeople: v.sum / v.nights, people: v.who.size }));
}

// --------------------------------------------------------------- genres

/** Is this "genre" really the label of the night it was tagged for?
 *
 *  Most genre tags in this library hold the event ("Roll afterglow",
 *  "20251108 Roll"), not a genre, and a chart of them looks informative while
 *  saying nothing. A value is a label only when every word of it is one of the
 *  event vocabulary or a date, so "Trip Hop" stays. */
const LABEL_WORDS = new Set([
  "roll", "trip", "candyflip", "candy", "flip", "afterglow", "peak", "intro",
  "outro", "post", "pre", "main", "mid", "and", "rollenbollen", "flipperen",
]);
export function isEventLabel(genre: string): boolean {
  const words = genre.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return !words.length || words.every((w) => LABEL_WORDS.has(w) || /^\d{6,8}$/.test(w));
}

export function realGenres(tracks: Track[]): Array<{ genre: string; count: number }> {
  const m = new Map<string, number>();
  for (const t of tracks) {
    if (!t.genre || isEventLabel(t.genre)) continue;
    m.set(t.genre, (m.get(t.genre) ?? 0) + 1);
  }
  return [...m.entries()].map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count);
}

/** Share of the range's tracks that carry a real genre -- shown beside the
 *  chart, because a top-20 of a few dozen tracks should not look like a census. */
export function genreCoverage(tracks: Track[]): number {
  if (!tracks.length) return 0;
  return tracks.filter((t) => t.genre && !isEventLabel(t.genre)).length / tracks.length;
}

// ------------------------------------------------------- cumulative history

export interface Cumulative {
  nights: number;
  songs: number;      // distinct songs heard so far
  canon: number;      // of those, played on 3+ nights so far
  people: number;     // distinct contributors seen so far
}

/** The library as it stood after each night, for the playback on the timeline.
 *  Index i is the state once night i (oldest first) had happened. */
export function cumulative(cat: Catalog): { nights: Event[]; at: Cumulative[] } {
  const nights = nightsOf(cat);
  const bySong = new Map<string, Set<string>>();       // eventId -> songs played
  for (const t of cat.tracks) {
    if (!t.songId || t.flags.includes("anon")) continue;
    if (!bySong.has(t.eventId)) bySong.set(t.eventId, new Set());
    bySong.get(t.eventId)!.add(t.songId);
  }
  const seen = new Map<string, number>();              // song -> nights so far
  const who = new Set<string>();
  let canon = 0;
  const at: Cumulative[] = [];
  nights.forEach((e, i) => {
    for (const s of bySong.get(e.id) ?? []) {
      const n = (seen.get(s) ?? 0) + 1;
      seen.set(s, n);
      if (n === 3) canon++;
    }
    e.people.forEach((p) => who.add(p));
    at.push({ nights: i + 1, songs: seen.size, canon, people: who.size });
  });
  return { nights, at };
}

// ------------------------------------------------------------- the unusual

export type TrendKey = "nights" | "hours" | "fresh" | "cast" | "length";

export interface TrendPoint { year: string; value: number; around: number | null; flagged: boolean }
export interface Break { key: TrendKey; year: string; value: number; around: number; strength: number; reading: string }
export interface Trend { key: TrendKey; title: string; points: TrendPoint[]; breaks: Break[] }

/** The middle value of a list: [m, m] for an odd count, the two middle values
 *  for an even one. Their average is not used -- one odd neighbour (a year with
 *  no nights) would drag it and make its normal neighbour look like the outlier. */
const middle = (xs: number[]): [number, number] => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? [s[m], s[m]] : [s[m - 1], s[m]];
};

const times = (x: number) => `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}x`;

/** How each year compares with the years around it.
 *
 *  The rule, chosen because a decade here is only a dozen points and a few
 *  years hold most of the nights: a year is compared with the *median* of up to
 *  four other years -- the two before and the two after, fewer at the ends,
 *  never fewer than two. The median because one huge neighbour (2016) must not
 *  drag the yardstick and hide the quiet year next to it. With an even number
 *  of neighbours there are two middle values, and a year is only a candidate
 *  when it lies beyond both (4 between a 1 and a 10 is nothing unusual). A year
 *  breaks the trend when it is at least twice, or at most half, its surroundings *and* the
 *  gap is big enough to matter in that unit (one night against two is "2x" and
 *  means nothing). Share of new music is a percentage, so there the test is a
 *  gap of 15 points. Years with no night count as zero nights and zero hours;
 *  for the averages they simply have no value.
 *
 *  A standard-deviation rule was rejected: with two or three extreme years in
 *  twelve, the deviation is inflated by those very years, so it flags nothing
 *  or everything. */
export function trendBreaks(cat: Catalog, r: Range | null = null): Trend[] {
  const nights = nightsOf(cat, r);
  if (!nights.length) return [];
  const by = new Map<string, { n: number; sec: number; people: number }>();
  for (const e of nights) {
    const y = yearOf(e.date!);
    const row = by.get(y) ?? { n: 0, sec: 0, people: 0 };
    row.n++; row.sec += e.durationSec; row.people += e.people.length;
    by.set(y, row);
  }
  const fresh = new Map(discovery(cat, r).map((d) => [d.year, d.rate]));
  const first = Number(yearOf(nights[0].date!)), last = Number(yearOf(nights[nights.length - 1].date!));
  const years: string[] = [];
  for (let y = first; y <= last; y++) years.push(String(y));

  interface Spec {
    key: TrendKey; title: string; kind: "ratio" | "points"; minGap: number;
    value: (y: string) => number | null; fmt: (v: number) => string; noun: [string, string];
  }
  const specs: Spec[] = [
    { key: "nights", title: "Nights", kind: "ratio", minGap: 2, noun: ["more nights", "fewer nights"],
      value: (y) => by.get(y)?.n ?? 0, fmt: (v) => `${Math.round(v * 10) / 10}` },
    { key: "hours", title: "Hours of music", kind: "ratio", minGap: 10, noun: ["more music", "less music"],
      value: (y) => (by.get(y)?.sec ?? 0) / 3600, fmt: (v) => `${Math.round(v)} h` },
    { key: "fresh", title: "New music", kind: "points", minGap: 0.15, noun: ["more new music", "less new music"],
      value: (y) => fresh.get(y) ?? null, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: "cast", title: "People per night", kind: "ratio", minGap: 1.5, noun: ["more people per night", "fewer people per night"],
      value: (y) => { const b = by.get(y); return b ? b.people / b.n : null; }, fmt: (v) => v.toFixed(1) },
    { key: "length", title: "Length of a night", kind: "ratio", minGap: 2, noun: ["longer nights", "shorter nights"],
      value: (y) => { const b = by.get(y); return b ? b.sec / 3600 / b.n : null; }, fmt: (v) => `${v.toFixed(1)} h` },
  ];

  return specs.map((sp) => {
    const vals = years.map((y) => ({ year: y, v: sp.value(y) }));
    const points: TrendPoint[] = [];
    const breaks: Break[] = [];
    vals.forEach((cur, i) => {
      if (cur.v === null) return;
      const near = [i - 2, i - 1, i + 1, i + 2]
        .filter((j) => j >= 0 && j < vals.length && vals[j].v !== null).map((j) => vals[j].v!);
      const [lo, hi] = near.length >= 2 ? middle(near) : [0, 0];
      // The yardstick is the middle value nearer to the year, and the year only
      // counts as outside if it is beyond *both* middle values.
      const outside = near.length >= 2 && (cur.v > hi || cur.v < lo);
      const around = near.length < 2 ? null : cur.v > hi ? hi : cur.v < lo ? lo : (lo + hi) / 2;
      let flagged = false;
      if (around !== null && outside) {
        const gap = Math.abs(cur.v - around);
        if (sp.kind === "points") {
          flagged = gap >= sp.minGap;
          if (flagged) breaks.push({
            key: sp.key, year: cur.year, value: cur.v, around, strength: gap,
            reading: `${cur.year}: ${Math.round(gap * 100)} points ${cur.v > around ? "more" : "less"} new music than the years around it (${sp.fmt(cur.v)} against ${sp.fmt(around)})`,
          });
        } else if (gap >= sp.minGap && around > 0 && (cur.v >= 2 * around || cur.v <= around / 2)) {
          flagged = true;
          const up = cur.v > around;
          const ratio = cur.v === 0 ? Infinity : up ? cur.v / around : around / cur.v;
          breaks.push({
            key: sp.key, year: cur.year, value: cur.v, around, strength: ratio,
            reading: cur.v === 0
              ? `${cur.year}: none, where the years around it had ${sp.fmt(around)}`
              : `${cur.year}: ${times(ratio)} ${sp.noun[up ? 0 : 1]} than the years around it (${sp.fmt(cur.v)} against ${sp.fmt(around)})`,
          });
        }
      }
      points.push({ year: cur.year, value: cur.v, around, flagged });
    });
    breaks.sort((a, b) => b.strength - a.strength);
    return { key: sp.key, title: sp.title, points, breaks };
  });
}

export interface Low {
  key: string; title: string; text: string; value: number;
  /** What to open: a year, or one night. */
  at: { kind: "year"; year: string } | { kind: "night"; id: string };
  /** How many others share exactly this value. */
  ties: number;
}

/** The floor of each measure: quietest year, shortest night and so on. A night
 *  with under ten played tracks is skipped for "least new music", where a share
 *  of three songs says nothing. Ties keep the earliest and are counted, so
 *  "the smallest cast" does not pretend to be unique when eight nights share it. */
export function lowest(cat: Catalog, r: Range | null = null): Low[] {
  const nights = nightsOf(cat, r);
  if (!nights.length) return [];
  const out: Low[] = [];
  const pick = <T>(xs: T[], v: (x: T) => number) => {
    let best = xs[0];
    for (const x of xs) if (v(x) < v(best)) best = x;
    return { best, ties: xs.filter((x) => v(x) === v(best)).length - 1 };
  };
  const trends = trendBreaks(cat, r);
  const series = (k: TrendKey) => trends.find((t) => t.key === k)!.points;
  const yearLow = (key: string, title: string, k: TrendKey, text: (v: number) => string) => {
    const pts = series(k);
    if (!pts.length) return;
    const { best, ties } = pick(pts, (p) => p.value);
    out.push({ key, title, value: best.value, text: text(best.value), at: { kind: "year", year: best.year }, ties });
  };
  yearLow("quiet", "Quietest year", "nights", (v) => `${v} night${v === 1 ? "" : "s"}`);
  yearLow("hours", "Least music in a year", "hours", (v) => `${v.toFixed(1)} h`);
  yearLow("fresh", "Least new music in a year", "fresh", (v) => `${Math.round(v * 100)}% new`);

  const night = (key: string, title: string, xs: Event[], v: (e: Event) => number, text: (e: Event) => string) => {
    if (!xs.length) return;
    const { best, ties } = pick(xs, v);
    out.push({ key, title, value: v(best), text: text(best), at: { kind: "night", id: best.id }, ties });
  };
  night("short", "Shortest night", nights.filter((e) => e.durationSec > 0), (e) => e.durationSec,
    (e) => `${(e.durationSec / 3600).toFixed(1)} h`);
  night("stale", "Least new music in a night", nights.filter((e) => e.playedCount >= 10),
    (e) => e.debuts / e.playedCount, (e) => `${Math.round((e.debuts / e.playedCount) * 100)}% new`);
  night("small", "Smallest cast", nights.filter((e) => e.people.length > 0),
    (e) => e.people.length, (e) => `${e.people.length} ${e.people.length === 1 ? "person" : "people"}`);
  return out;
}

export interface Solo { id: string; label: string; sub: string; personId: string; nights: number }

/** Who brought each song or artist on the named tracks of dated nights. `who`
 *  is null when any play has no known contributor or two people brought it,
 *  because "only Dov" cannot be said of something nobody attributed. */
function soleBringers(cat: Catalog, by: (t: Track) => string) {
  const m = new Map<string, { who: string | null; nights: Set<string>; mixed: boolean }>();
  for (const t of playedOf(cat)) {
    if (!t.songId) continue;
    const k = by(t);
    const row = m.get(k) ?? { who: null, nights: new Set<string>(), mixed: false };
    row.nights.add(t.eventId);
    if (!t.personId) row.mixed = true;
    else if (row.who === null) row.who = t.personId;
    else if (row.who !== t.personId) row.mixed = true;
    m.set(k, row);
  }
  return [...m].map(([id, v]) => ({ id, who: v.mixed ? null : v.who, nights: v.nights.size }));
}

/** Artists exactly one person has ever brought, on `minNights` nights or more:
 *  a one-person stronghold. History, not range. */
export function soloArtists(cat: Catalog, minNights = 3): Solo[] {
  const names = new Map(cat.artists.map((a) => [a.id, a.name]));
  return soleBringers(cat, (t) => t.songId!.split("|")[0])
    .filter((v) => v.who && v.nights >= minNights)
    .map((v) => ({ id: v.id, label: names.get(v.id) ?? v.id, sub: "", personId: v.who!, nights: v.nights }))
    .sort((a, b) => b.nights - a.nights || a.label.localeCompare(b.label));
}

/** Songs that came back on `minNights` nights or more and always from the same
 *  person: "only Dov plays this". */
export function soloSongs(cat: Catalog, minNights = 3): Solo[] {
  const songs = new Map(cat.songs.map((s) => [s.id, s]));
  return soleBringers(cat, (t) => t.songId!)
    .filter((v) => v.who && v.nights >= minNights)
    .map((v) => ({
      id: v.id, label: songs.get(v.id)?.title ?? v.id, sub: songs.get(v.id)?.artist ?? "",
      personId: v.who!, nights: v.nights,
    }))
    .sort((a, b) => b.nights - a.nights || a.label.localeCompare(b.label));
}

export interface OneOff { song: Song; date: string; artistNights: number }

/** Songs played exactly once, on one night, and never since. `rows` is the
 *  telling subset: one song per artist, artists with the most nights first, so
 *  "a regular whose other song was a single appearance" rises above the long
 *  tail of names heard once. */
export function oneOffs(cat: Catalog): { total: number; songs: number; rows: OneOff[] } {
  const plays = new Map<string, number>();
  for (const t of playedOf(cat)) if (t.songId) plays.set(t.songId, (plays.get(t.songId) ?? 0) + 1);
  const date = new Map(cat.events.map((e) => [e.id, e.date]));
  const artistNights = new Map(cat.artists.map((a) => [a.id, a.nights.length]));
  const once = cat.songs.filter((s) => s.nights.length === 1 && plays.get(s.id) === 1);
  const best = new Map<string, OneOff>();
  for (const s of once) {
    const aid = s.id.split("|")[0];
    const row = { song: s, date: date.get(s.nights[0])!, artistNights: artistNights.get(aid) ?? 0 };
    const cur = best.get(aid);
    if (!cur || row.date < cur.date) best.set(aid, row);
  }
  return {
    total: once.length, songs: plays.size,
    rows: [...best.values()].sort((a, b) => b.artistNights - a.artistNights || a.date.localeCompare(b.date)),
  };
}

export interface Trajectory { artist: ArtistEntry; early: number; late: number; nights: number }

/** Artists that rose or faded. The range's nights are split in two halves by
 *  count -- not by calendar, since 2016 alone holds a third of all nights -- and
 *  an artist is scored by the share of each half's nights it appeared on. The
 *  gap between the two shares ranks it. Needs `minNights` appearances in all,
 *  or a pair of lucky nights would look like a movement. */
export function evolutions(cat: Catalog, r: Range | null = null, minNights = 5, top = 10):
  { rising: Trajectory[]; fading: Trajectory[]; split: string | null } {
  const nights = nightsOf(cat, r);
  if (nights.length < 4) return { rising: [], fading: [], split: null };
  const half = nights.length >> 1;
  const earlyIds = new Set(nights.slice(0, half).map((e) => e.id));
  const lateIds = new Set(nights.slice(nights.length - half).map((e) => e.id));
  const seen = new Map<string, { early: Set<string>; late: Set<string>; all: Set<string> }>();
  for (const t of playedOf(cat, r)) {
    if (!t.songId) continue;
    const id = t.songId.split("|")[0];
    const row = seen.get(id) ?? { early: new Set(), late: new Set(), all: new Set() };
    row.all.add(t.eventId);
    if (earlyIds.has(t.eventId)) row.early.add(t.eventId);
    if (lateIds.has(t.eventId)) row.late.add(t.eventId);
    seen.set(id, row);
  }
  const known = new Map(cat.artists.map((a) => [a.id, a]));
  const rows: Trajectory[] = [];
  for (const [id, v] of seen) {
    const artist = known.get(id);
    if (!artist || v.all.size < minNights) continue;
    rows.push({ artist, early: v.early.size / half, late: v.late.size / half, nights: v.all.size });
  }
  const gap = (t: Trajectory) => t.late - t.early;
  return {
    rising: rows.filter((t) => gap(t) > 0).sort((a, b) => gap(b) - gap(a) || b.nights - a.nights).slice(0, top),
    fading: rows.filter((t) => gap(t) < 0).sort((a, b) => gap(a) - gap(b) || b.nights - a.nights).slice(0, top),
    split: nights[half].date,
  };
}

// ------------------------------------------------------------------ sound quality

/** How good a file is, in four rungs. 128 kbps and below is the tier a
 *  YouTube rip lands on, which is why the line sits at 160. Lossless is its own
 *  rung because bitrate says nothing about it. */
export type Band = "lossless" | "high" | "mid" | "low";
export const BANDS: Band[] = ["lossless", "high", "mid", "low"];

export function bandOf(a: Audio | undefined): Band | null {
  if (!a) return null;
  if (a.lossless) return "lossless";
  if (a.kbps === null) return null;
  return a.kbps >= 256 ? "high" : a.kbps >= 160 ? "mid" : "low";
}

/** Every audio file on a dated night: each copy is a file in the library, so an
 *  anonymised copy counts -- unlike a played track, where it would be the same
 *  playlist again. Videos are left out; their bitrate is the picture's. */
export function nightFiles(cat: Catalog, r: Range | null = null): Track[] {
  const ok = new Set(nightsOf(cat, r).map((e) => e.id));
  return cat.tracks.filter((t) => ok.has(t.eventId) && t.source !== "spotify" && !t.flags.includes("video"));
}

/** How much of the library these figures rest on. A track that exists only in a
 *  Spotify playlist has no file, so it cannot be measured and is said so. */
export function qualityCoverage(cat: Catalog): { files: number; known: number; noFile: number } {
  const files = nightFiles(cat);
  const nights = new Set(nightsOf(cat).map((e) => e.id));
  return {
    files: files.length,
    known: files.filter((t) => bandOf(t.audio) !== null).length,
    noFile: cat.tracks.filter((t) => nights.has(t.eventId) && t.source === "spotify").length,
  };
}

export interface QualityYear {
  year: string; files: number; lossless: number; high: number; mid: number; low: number;
  /** Median bitrate of the lossy files, kbps. */
  medianKbps: number | null;
}

export function qualityByYear(cat: Catalog, r: Range | null = null): QualityYear[] {
  const date = new Map(cat.events.map((e) => [e.id, e.date]));
  const by = new Map<string, QualityYear & { kb: number[] }>();
  for (const t of nightFiles(cat, r)) {
    const b = bandOf(t.audio);
    if (!b) continue;
    const y = date.get(t.eventId)!.slice(0, 4);
    if (!by.has(y)) by.set(y, { year: y, files: 0, lossless: 0, high: 0, mid: 0, low: 0, medianKbps: null, kb: [] });
    const q = by.get(y)!;
    q.files++; q[b]++;
    if (b !== "lossless") q.kb.push(t.audio!.kbps!);
  }
  return [...by.values()].sort((a, b) => a.year.localeCompare(b.year)).map(({ kb, ...q }) => {
    kb.sort((a, b) => a - b);
    return { ...q, medianKbps: kb.length ? kb[Math.floor(kb.length / 2)] : null };
  });
}

export interface WeakNight { event: Event; files: number; low: number; share: number }

/** Nights whose files are most often in the lowest rung. A night needs ten
 *  measured files, or one rip would make a small night look terrible. */
export function weakestNights(cat: Catalog, r: Range | null = null, top = 10, minFiles = 10): WeakNight[] {
  const ev = new Map(cat.events.map((e) => [e.id, e]));
  const by = new Map<string, { files: number; low: number }>();
  for (const t of nightFiles(cat, r)) {
    const b = bandOf(t.audio);
    if (!b) continue;
    const a = by.get(t.eventId) ?? { files: 0, low: 0 };
    a.files++; if (b === "low") a.low++;
    by.set(t.eventId, a);
  }
  return [...by.entries()].filter(([, a]) => a.files >= minFiles && a.low > 0)
    .map(([id, a]) => ({ event: ev.get(id)!, ...a, share: a.low / a.files }))
    .sort((x, y) => y.share - x.share || y.files - x.files).slice(0, top);
}

export interface PersonQuality { personId: string; files: number; lossless: number; low: number }

export function qualityByPerson(cat: Catalog, r: Range | null = null, minFiles = 30): PersonQuality[] {
  const by = new Map<string, PersonQuality>();
  for (const t of nightFiles(cat, r)) {
    const b = bandOf(t.audio);
    if (!b || !t.personId) continue;
    const a = by.get(t.personId) ?? { personId: t.personId, files: 0, lossless: 0, low: 0 };
    a.files++; if (b === "lossless") a.lossless++; if (b === "low") a.low++;
    by.set(t.personId, a);
  }
  return [...by.values()].filter((p) => p.files >= minFiles).sort((a, b) => b.files - a.files);
}

export interface Upgrade { song: Song; kbps: number; nights: number }

/** Songs whose best copy anywhere in the library is in the lowest rung -- the
 *  ones worth replacing, most-played first. A song's copies include the
 *  anonymised ones, which take their identity from the named twin. */
export function upgradeCandidates(cat: Catalog, top = 20): { total: number; known: number; rows: Upgrade[] } {
  const byId = new Map(cat.tracks.map((t) => [t.id, t]));
  const songs = new Map(cat.songs.map((s) => [s.id, s]));
  const best = new Map<string, number>();       // song -> best kbps (Infinity for lossless)
  for (const t of nightFiles(cat)) {
    const id = t.songId ?? (t.twinId ? byId.get(t.twinId)?.songId : null);
    const b = bandOf(t.audio);
    if (!id || !b) continue;
    const q = b === "lossless" ? Infinity : t.audio!.kbps!;
    best.set(id, Math.max(best.get(id) ?? 0, q));
  }
  const weak = [...best.entries()].filter(([, q]) => q < 160);
  const rows = weak.map(([id, q]) => ({ song: songs.get(id)!, kbps: q, nights: songs.get(id)?.nights.length ?? 0 }))
    .filter((u) => u.song)
    .sort((a, b) => b.nights - a.nights || a.kbps - b.kbps);
  return { total: weak.length, known: best.size, rows: rows.slice(0, top) };
}
