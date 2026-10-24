/** Milestones of the decade: the notable "firsts" and "passed" moments, derived
 *  from the catalogue and stated as plain facts. Pure: no React, no DOM, so
 *  tools/milestones.test.ts runs it.
 *
 *  Everything is computed over the WHOLE library, never the visible range or zoom:
 *  a person does not stop having joined in 2016 because you are looking at 2021.
 *
 *  Counting follows src/insightstats.ts (via kpiReport): played tracks only; a song
 *  is one play per person per night; a person's anonymised list and its named twin
 *  are one playlist, so copies and twins never count twice. "Nights" here are the
 *  dated, non-collection nights, oldest first.
 *
 *  The library's opening night has no "before", so nothing on it is "new":
 *  no joins, pioneers, records, years or kinds of night. (Running totals still
 *  count it, and can cross a threshold on it.)
 *
 *  Priority, when a night has more than MAX_PER_NIGHT candidates (best first):
 *    1 joins and returns      2 records (group size, longest night)
 *    3 cumulative thresholds (hours, different songs, plays)
 *    4 pioneers and seeds     5 new year and new kind of night
 *  Ties inside a priority go to the heavier one (e.g. the artist with the most
 *  nights), then to the text, so the same catalogue always gives the same list.
 */
import type { Catalog } from "./catalog.ts";
import { kpiReport } from "./insightstats.ts";

export type MilestoneKind =
  | "join" | "return" | "group" | "longest" | "hours" | "songs" | "plays"
  | "pioneer" | "seed" | "year" | "nighttype";

export interface MilestoneLink { type: "person" | "artist" | "song" | "night"; id: string }

export interface Milestone {
  id: string;
  date: string;
  eventId: string;
  kind: MilestoneKind;
  text: string;
  detail?: string;
  link?: MilestoneLink;
}

export const MAX_PER_NIGHT = 4;
export const MAX_ARTISTS_PER_NIGHT = 2;
export const MAX_SEEDS_PER_NIGHT = 1;
/** A break counts as "away" from a year (365 days) up. A single missed night is far shorter. */
export const RETURN_GAP_DAYS = 365;
export const STAPLE_ARTIST_NIGHTS = 5;     // nights overall, first one included
export const SEED_SONG_NIGHTS = 6;
export const HOURS_STEP = 100;
export const SONGS_STEP = 500;
export const PLAYS_STEP = 1000;
export const GROUP_RECORD_MIN = 4;         // "most people so far" is not news at 2 or 3
export const LONGEST_MARGIN_SEC = 30 * 60;

const PRIORITY: Record<MilestoneKind, number> = {
  join: 1, return: 1, group: 2, longest: 2, hours: 3, songs: 3, plays: 3,
  pioneer: 4, seed: 4, year: 5, nighttype: 5,
};
export const KIND_LABEL: Record<MilestoneKind, string> = {
  join: "Joined", return: "Returned", group: "Biggest group", longest: "Longest night",
  hours: "Hours of music", songs: "Different songs", plays: "Plays",
  pioneer: "Artist first brought", seed: "Song first brought", year: "New year", nighttype: "New kind of night",
};

const DAY = 86400000;
const num = (n: number) => n.toLocaleString("en-US");
const dayNum = (d: string) => Date.parse(d + "T00:00:00Z") / DAY;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "2 years" from a break of this many days; months while under two years. */
export function gapWords(days: number): string {
  const months = Math.round(days / 30.44);
  return months < 24 ? plural(Math.max(months, 12), "month") : plural(Math.round(days / 365.25), "year");
}

interface Cand { m: Milestone; pri: number; weight: number }

export function buildMilestones(cat: Catalog): Milestone[] {
  const rows = kpiReport(cat, null).nights;
  if (!rows.length) return [];
  const personName = new Map(cat.people.map((p) => [p.id, p.name]));
  const artistName = new Map(cat.artists.map((a) => [a.id, a.name]));
  const songInfo = new Map(cat.songs.map((s) => [s.id, s]));
  const eventOf = new Map(cat.events.map((e) => [e.id, e]));

  // How many distinct nights each artist / song / person was on, over the whole library.
  const artistNights = new Map<string, number>(), songNights = new Map<string, number>();
  for (const r of rows) {
    for (const a of r.artistIds) artistNights.set(a, (artistNights.get(a) ?? 0) + 1);
    for (const s of r.songIds) songNights.set(s, (songNights.get(s) ?? 0) + 1);
  }
  const personNights = new Map<string, number>();
  for (const r of rows) for (const p of r.peopleIds) personNights.set(p, (personNights.get(p) ?? 0) + 1);

  const lastSeen = new Map<string, string>();      // person -> date of their latest night so far
  const seenArtist = new Set<string>(), seenSong = new Set<string>(), seenType = new Set<string>();
  const seenSongsAll = new Set<string>();
  let hoursSec = 0, plays = 0, bestGroup = 0, bestLen = 0, announcedLen = 0;
  let prevYear = "";
  const out: Milestone[] = [];

  rows.forEach((r, i) => {
    const opening = i === 0;
    const ev = eventOf.get(r.id);
    const cands: Cand[] = [];
    const add = (kind: MilestoneKind, key: string, weight: number, text: string, detail?: string, link?: MilestoneLink) =>
      cands.push({ pri: PRIORITY[kind], weight, m: { id: `${r.id}:${kind}:${key}`, date: r.date, eventId: r.id, kind, text, detail, link } });
    const nameOf = (p: string) => personName.get(p) ?? p;

    // ---- people: first night, or back after a break. Their latest night to date is not one.
    if (!opening) {
      for (const p of [...r.peopleIds].sort()) {
        const last = lastSeen.get(p);
        const total = personNights.get(p) ?? 1;
        if (last === undefined) {
          add("join", p, total, `${nameOf(p)} joins`,
            total === 1 ? "their only night so far" : `on ${total} nights in all`, { type: "person", id: p });
        } else {
          const gap = dayNum(r.date) - dayNum(last);
          if (gap >= RETURN_GAP_DAYS) {
            add("return", p, gap, `${nameOf(p)} is back after ${gapWords(gap)}`,
              `last there ${last}`, { type: "person", id: p });
          }
        }
      }
    }
    for (const p of r.peopleIds) lastSeen.set(p, r.date);

    // ---- records
    if (!opening && r.peopleIds.length > bestGroup && r.peopleIds.length >= GROUP_RECORD_MIN) {
      add("group", String(r.peopleIds.length), r.peopleIds.length,
        `most people at one night so far: ${r.peopleIds.length}`, `the previous most was ${bestGroup}`, { type: "night", id: r.id });
    }
    bestGroup = Math.max(bestGroup, r.peopleIds.length);
    const len = ev?.durationSec ?? 0;
    if (opening) { bestLen = len; announcedLen = len; }
    else if (len > bestLen) {
      if (len - announcedLen >= LONGEST_MARGIN_SEC) {
        const h = Math.floor(len / 3600), m = Math.round((len % 3600) / 60);
        add("longest", "len", len, "longest night so far",
          `${h}h ${String(m).padStart(2, "0")}m, ${Math.round((len - announcedLen) / 60)} min more than the last record`,
          { type: "night", id: r.id });
        announcedLen = len;
      }
      bestLen = len;
    }

    // ---- running totals: a threshold crossed inside this night is reported once, at its highest
    const hoursBefore = Math.floor(hoursSec / 3600 / HOURS_STEP);
    hoursSec += r.trackSec;
    const hoursNow = Math.floor(hoursSec / 3600 / HOURS_STEP);
    if (hoursNow > hoursBefore) {
      add("hours", String(hoursNow), 3, `passed ${num(hoursNow * HOURS_STEP)} hours of music`,
        "of played tracks, counted once per person per night", { type: "night", id: r.id });
    }
    const songsBefore = Math.floor(seenSongsAll.size / SONGS_STEP);
    for (const s of r.songIds) seenSongsAll.add(s);
    const songsNow = Math.floor(seenSongsAll.size / SONGS_STEP);
    if (songsNow > songsBefore) {
      add("songs", String(songsNow), 2, `the ${num(songsNow * SONGS_STEP)}th different song`,
        `${num(seenSongsAll.size)} different songs by the end of this night`, { type: "night", id: r.id });
    }
    const playsBefore = Math.floor(plays / PLAYS_STEP);
    plays += r.plays;
    const playsNow = Math.floor(plays / PLAYS_STEP);
    if (playsNow > playsBefore) {
      add("plays", String(playsNow), 1, `passed ${num(playsNow * PLAYS_STEP)} plays`,
        `${num(plays)} by the end of this night`, { type: "night", id: r.id });
    }

    // ---- pioneers: first appearance of an artist / song that later became a staple
    const newArtists = r.artistIds.filter((a) => !seenArtist.has(a));
    const newSongs = r.songIds.filter((s) => !seenSong.has(s));
    r.artistIds.forEach((a) => seenArtist.add(a));
    r.songIds.forEach((s) => seenSong.add(s));
    if (!opening) {
      const staples = newArtists
        .filter((a) => (artistNights.get(a) ?? 0) >= STAPLE_ARTIST_NIGHTS)
        .sort((a, b) => (artistNights.get(b)! - artistNights.get(a)!) || a.localeCompare(b))
        .slice(0, MAX_ARTISTS_PER_NIGHT);
      for (const a of staples) {
        const later = artistNights.get(a)! - 1;
        add("pioneer", a, artistNights.get(a)!, `${artistName.get(a) ?? a} brought for the first time`,
          `later on ${plural(later, "night")}`, { type: "artist", id: a });
      }
      const seeds = newSongs
        .filter((s) => (songNights.get(s) ?? 0) >= SEED_SONG_NIGHTS)
        .sort((a, b) => (songNights.get(b)! - songNights.get(a)!) || a.localeCompare(b))
        .slice(0, MAX_SEEDS_PER_NIGHT);
      for (const s of seeds) {
        const info = songInfo.get(s);
        const title = info?.title ?? s.split("|").slice(1).join("|") ?? s;
        const artist = info?.artist ?? artistName.get(s.split("|")[0]) ?? s.split("|")[0];
        add("seed", s, songNights.get(s)! * 0.5, `“${title}” by ${artist} brought for the first time`,
          `later on ${plural(songNights.get(s)! - 1, "night")}`, { type: "song", id: s });
      }
    }

    // ---- calendar and kinds of night
    const year = r.date.slice(0, 4);
    if (!opening && year !== prevYear) add("year", year, 2, `${year} begins`, undefined, { type: "night", id: r.id });
    prevYear = year;
    for (const t of ev?.types ?? []) {
      if (!seenType.has(t) && !opening) {
        add("nighttype", t, 1, `first ${t[0].toUpperCase()}${t.slice(1)} night`, "a new kind of night", { type: "night", id: r.id });
      }
      seenType.add(t);
    }

    cands.sort((a, b) => a.pri - b.pri || b.weight - a.weight || a.m.text.localeCompare(b.m.text));
    for (const c of cands.slice(0, MAX_PER_NIGHT)) out.push(c.m);
  });
  return out;
}

const cache = new WeakMap<Catalog, Milestone[]>();
/** `buildMilestones`, remembered per catalogue. */
export function milestonesOf(cat: Catalog): Milestone[] {
  let m = cache.get(cat);
  if (!m) { m = buildMilestones(cat); cache.set(cat, m); }
  return m;
}

/** Glyph shape per kind, so the axis markers differ by more than colour. */
export type Shape = "circle" | "ring" | "diamond" | "triangle" | "square" | "plus" | "bar" | "star";
export const SHAPE: Record<MilestoneKind, Shape> = {
  join: "circle", return: "ring", group: "triangle", longest: "bar",
  hours: "square", songs: "square", plays: "square",
  pioneer: "diamond", seed: "star", year: "plus", nighttype: "plus",
};
