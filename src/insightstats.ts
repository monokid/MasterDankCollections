/** The headline numbers (KPIs) of the Insights page, and the per-night rows they
 *  are made of. Pure: no React, no DOM, so tools/insightstats.test.ts runs it.
 *
 *  What counts as "a play" follows src/songstats.ts:
 *   - only tracks marked `played`, on a dated night (collections are shelves);
 *   - a person's anonymised list and its named twin are one playlist: a song is
 *     one play per person per night, however many copies carry it;
 *   - two people bringing the same song to the same night is 2 plays, 1 song;
 *   - an anonymised track with no tags takes its identity from its twin; one that
 *     nothing could name still counts as a play (and a song of its own on that
 *     night), but not as a distinct song or an artist, because it has no identity.
 *
 *  "New music" is judged against the whole history, never the range: a song first
 *  played in 2016 is not new in 2021 because 2016 is out of view. The library's
 *  opening night has no "before", so it is left out of that share entirely.
 *
 *  "Full year": a calendar year the range covers end to end and that is over
 *  (earlier than the year of the newest night in the library). The change shown
 *  beside each figure compares the last full year with the one before it, and
 *  is absent when either is not a full year or had no nights.
 */
import type { Catalog, Track } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { nightsOf, type Range } from "./analytics.ts";
import { fmtCount } from "./format.ts";

// ------------------------------------------------------------------ small maths

export const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** Middle value; the mean of the two middle values for an even count. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 0 = Monday ... 6 = Sunday, for an ISO date. Read as UTC so no timezone moves a date. */
export const weekdayOf = (date: string): number => (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

// -------------------------------------------------------------------- per night

/** Everything about one night that does not depend on the range. */
interface Facts {
  id: string; date: string; title: string;
  plays: number;          // one per person per song
  songKeys: number;       // distinct songs on the night, unnamed ones included
  songIds: string[];      // distinct songs with an identity
  artistIds: string[];
  trackSec: number;       // running time of the plays that have a length
  timed: number;          // how many plays have a length
}

interface Ix {
  facts: Map<string, Facts>;
  /** songId -> the night it was first played on (by date, then id). */
  first: Map<string, string>;
  openingId: string | null;
  asOf: string | null;
}
const ixCache = new WeakMap<Catalog, Ix>();

const artistKey = (songId: string) => songId.split("|")[0];

function index(cat: Catalog): Ix {
  let ix = ixCache.get(cat);
  if (ix) return ix;
  const cix = catalogIndex(cat);
  const nights = nightsOf(cat, null);
  const facts = new Map<string, Facts>();
  for (const e of nights) {
    const kept = new Map<string, Track>();           // per person+song: the named copy beats the anonymised one
    for (const t of cix.tracksOfEvent.get(e.id) ?? []) {
      if (!t.played) continue;
      const sid = t.songId ?? (t.twinId ? cix.track.get(t.twinId)?.songId ?? null : null);
      const k = `${t.personId ?? "?"}|${sid ?? `u:${t.id}`}`;
      const have = kept.get(k);
      if (!have || (have.flags.includes("anon") && !t.flags.includes("anon"))) kept.set(k, t);
    }
    const songIds = new Set<string>(), keys = new Set<string>();
    let trackSec = 0, timed = 0;
    for (const [k, t] of kept) {
      const sid = k.slice(k.indexOf("|") + 1);
      keys.add(sid);
      if (!sid.startsWith("u:")) songIds.add(sid);
      const d = t.durationSec ?? (t.twinId ? cix.track.get(t.twinId)?.durationSec : null) ?? 0;
      if (d > 0) { trackSec += d; timed++; }
    }
    facts.set(e.id, {
      id: e.id, date: e.date!, title: e.title || e.types.join(" + "),
      plays: kept.size, songKeys: keys.size, songIds: [...songIds],
      artistIds: [...new Set([...songIds].map(artistKey))], trackSec, timed,
    });
  }
  const first = new Map<string, string>();
  for (const e of nights) {                          // oldest first, so the first sighting wins
    for (const s of facts.get(e.id)!.songIds) if (!first.has(s)) first.set(s, e.id);
  }
  ix = {
    facts, first, openingId: nights[0]?.id ?? null,
    asOf: nights.length ? nights[nights.length - 1].date : null,
  };
  ixCache.set(cat, ix);
  return ix;
}

export interface NightRow {
  id: string; date: string; year: string; title: string;
  plays: number; songs: number;
  /** Running time of the night in minutes, null when the catalogue has none. */
  minutes: number | null;
  people: number; peopleIds: string[];
  songIds: string[]; artistIds: string[];
  /** Songs on the night never heard on an earlier night / heard before. */
  fresh: number; returning: number;
  /** The library's first night: it has no "before", so it is left out of the new-music share. */
  opening: boolean;
  trackSec: number; timed: number;
}

// ------------------------------------------------------------------------ KPIs

export type KpiId =
  | "nights" | "songs" | "plays" | "people" | "artists" | "songsPerNight"
  | "nightLength" | "newShare" | "peoplePerNight" | "trackLength";
export const KPI_IDS: readonly KpiId[] = [
  "nights", "songs", "plays", "people", "artists", "songsPerNight",
  "nightLength", "newShare", "peoplePerNight", "trackLength",
];
export type KpiFormat = "int" | "dec1" | "pct" | "min";

export interface YearPoint { year: string; value: number | null; nights: number }

export interface Delta {
  fromYear: string; toYear: string; prev: number; last: number;
  diff: number; pct: number | null;
  /** Compact for a tile: "+3 vs 2023". */
  short: string;
  /** Neutral: states both figures and the difference, never judges it. */
  text: string;
}

export interface Kpi {
  id: KpiId; label: string; format: KpiFormat;
  /** Across the whole range; null when there is nothing to average. */
  value: number | null;
  /** Only for songs per night. */
  median?: number | null;
  yearSeries: YearPoint[];
  deltaVsPrev: Delta | null;
  sentence: string;
}

export interface NewReturning { year: string; fresh: number; returning: number; share: number | null }

export interface KpiReport {
  range: Range | null;
  years: string[];
  nights: NightRow[];
  kpis: Kpi[];
  byId: Record<KpiId, Kpi>;
  newVsReturning: NewReturning[];
  /** The latest year that counts as full, or null. */
  lastFullYear: string | null;
  asOf: string | null;
}

export function formatKpi(format: KpiFormat, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  switch (format) {
    case "int": return fmtCount(Math.round(v));
    case "dec1": return v.toFixed(1);
    case "pct": return `${Math.round(v * 100)}%`;
    case "min": return `${Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1)} min`;
  }
}

const META: Record<KpiId, { label: string; format: KpiFormat }> = {
  nights: { label: "Nights", format: "int" },
  songs: { label: "Different songs", format: "int" },
  plays: { label: "Plays", format: "int" },
  people: { label: "People", format: "int" },
  artists: { label: "Artists", format: "int" },
  songsPerNight: { label: "Songs per night", format: "dec1" },
  nightLength: { label: "Night length", format: "min" },
  newShare: { label: "New music", format: "pct" },
  peoplePerNight: { label: "People per night", format: "dec1" },
  trackLength: { label: "Track length", format: "min" },
};

export const kpiLabel = (id: KpiId) => META[id].label;

const sumOf = (xs: NightRow[], f: (r: NightRow) => number) => xs.reduce((a, r) => a + f(r), 0);
const unionSize = (xs: NightRow[], f: (r: NightRow) => string[]) => new Set(xs.flatMap(f)).size;

/** One KPI over a set of nights. Counts of nothing are 0; averages of nothing are null. */
export function measure(id: KpiId, rows: NightRow[]): number | null {
  switch (id) {
    case "nights": return rows.length;
    case "plays": return sumOf(rows, (r) => r.plays);
    case "songs": return unionSize(rows, (r) => r.songIds);
    case "people": return unionSize(rows, (r) => r.peopleIds);
    case "artists": return unionSize(rows, (r) => r.artistIds);
    case "songsPerNight": return mean(rows.map((r) => r.songs));
    case "peoplePerNight": return mean(rows.map((r) => r.people));
    case "nightLength": return mean(rows.flatMap((r) => (r.minutes === null ? [] : [r.minutes])));
    case "newShare": {
      const ok = rows.filter((r) => !r.opening);
      const fresh = sumOf(ok, (r) => r.fresh), all = fresh + sumOf(ok, (r) => r.returning);
      return all ? fresh / all : null;
    }
    case "trackLength": {
      const n = sumOf(rows, (r) => r.timed);
      return n ? sumOf(rows, (r) => r.trackSec) / n / 60 : null;
    }
  }
}

/** The per-night value behind a KPI, for tables of the nights under a number. */
export function nightValue(id: KpiId, r: NightRow): number | null {
  return measure(id, [r]);
}

function rowsOf(cat: Catalog, range: Range | null): NightRow[] {
  const ix = index(cat);
  return nightsOf(cat, range).map((e) => {
    const f = ix.facts.get(e.id)!;
    const fresh = f.songIds.filter((s) => ix.first.get(s) === e.id).length;
    const peopleIds = [...new Set(e.people)];
    return {
      id: e.id, date: e.date!, year: e.date!.slice(0, 4), title: f.title,
      plays: f.plays, songs: f.songKeys,
      minutes: e.durationSec > 0 ? e.durationSec / 60 : null,
      people: peopleIds.length, peopleIds,
      songIds: f.songIds, artistIds: f.artistIds,
      fresh, returning: f.songIds.length - fresh, opening: e.id === ix.openingId,
      trackSec: f.trackSec, timed: f.timed,
    };
  });
}

/** Every calendar year from the first to the last night, gaps included. */
function yearsOf(rows: NightRow[]): string[] {
  if (!rows.length) return [];
  const lo = +rows[0].year, hi = +rows[rows.length - 1].year, out: string[] = [];
  for (let y = lo; y <= hi; y++) out.push(String(y));
  return out;
}

/** Does the range hold this whole calendar year? */
const coversYear = (range: Range | null, y: string) =>
  !range || (range.from <= `${y}-01-01` && range.to >= `${y}-12-31`);

const signed = (n: number, digits: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(digits);

function deltaOf(format: KpiFormat, series: YearPoint[], fullYear: (y: string) => boolean): Delta | null {
  const full = series.filter((p) => fullYear(p.year));
  const last = full[full.length - 1];
  if (!last) return null;
  const prev = series.find((p) => +p.year === +last.year - 1);
  if (!prev || !fullYear(prev.year)) return null;
  if (!last.nights || !prev.nights || last.value === null || prev.value === null) return null;
  const diff = last.value - prev.value;
  const pct = format !== "pct" && prev.value !== 0 ? diff / prev.value : null;
  const show = (v: number) => formatKpi(format, v);
  const unit = format === "min" ? " min" : format === "pct" ? " pts" : "";
  const num = format === "pct" ? signed(diff * 100, 0) : format === "int" ? signed(diff, 0) : signed(diff, 1);
  const change = format === "pct"
    ? `${signed(diff * 100, 0)} points`
    : `${format === "int" ? signed(diff, 0) : signed(diff, 1)}${pct === null ? "" : ` (${signed(pct * 100, 0)}%)`}`;
  return {
    fromYear: prev.year, toYear: last.year, prev: prev.value, last: last.value, diff, pct,
    short: `${num}${unit} vs ${prev.year}`,
    text: `${last.year}: ${show(last.value)} · ${prev.year}: ${show(prev.value)} · change ${change}`,
  };
}

function sentenceOf(id: KpiId, value: number | null, rows: NightRow[], median: number | null): string {
  if (!rows.length) return "No nights in this range.";
  const f = (k: KpiId) => formatKpi(META[k].format, value);
  switch (id) {
    case "nights": return `${f(id)} nights between ${rows[0].date.slice(0, 4)} and ${rows[rows.length - 1].date.slice(0, 4)}.`;
    case "songs": return `${f(id)} different songs; one played on several nights counts once.`;
    case "plays": return `${f(id)} plays: each song once per person per night, anonymised copies not counted again.`;
    case "people": return `${f(id)} different people were at one or more of these nights.`;
    case "artists": return `${f(id)} different artists across the songs that have an identity.`;
    case "songsPerNight": return `${f(id)} different songs on an average night; the middle night had ${formatKpi("dec1", median)}.`;
    case "nightLength": return value === null ? "No running times recorded." : `An average night ran ${f(id)} of music.`;
    case "newShare": return value === null
      ? "Nothing to compare: the first night in the library has no earlier nights to be new against."
      : `${f(id)} of the songs on a night had not been heard on any earlier night (the first night is left out).`;
    case "peoplePerNight": return `${f(id)} people on an average night.`;
    case "trackLength": return value === null ? "No track lengths recorded." : `An average track ran ${f(id)}.`;
  }
}

/** All the KPIs for a range. `asOf` (the newest night, by default) decides which years are over. */
export function buildKpiReport(cat: Catalog, range: Range | null, asOfOverride?: string | null): KpiReport {
  const ix = index(cat);
  const asOf = asOfOverride === undefined ? ix.asOf : asOfOverride;
  const rows = rowsOf(cat, range);
  const years = yearsOf(rows);
  const byYear = new Map<string, NightRow[]>(years.map((y) => [y, []]));
  for (const r of rows) byYear.get(r.year)!.push(r);
  const fullYear = (y: string) => !!asOf && y < asOf.slice(0, 4) && coversYear(range, y);

  const kpis = KPI_IDS.map((id): Kpi => {
    const meta = META[id];
    const value = measure(id, rows);
    const med = id === "songsPerNight" ? median(rows.map((r) => r.songs)) : undefined;
    const yearSeries = years.map((year): YearPoint => {
      const ys = byYear.get(year)!;
      return { year, value: measure(id, ys), nights: ys.length };
    });
    return {
      id, label: meta.label, format: meta.format, value,
      ...(med === undefined ? {} : { median: med }),
      yearSeries, deltaVsPrev: deltaOf(meta.format, yearSeries, fullYear),
      sentence: sentenceOf(id, value, rows, med ?? null),
    };
  });
  const lastFull = [...years].reverse().find((y) => fullYear(y) && byYear.get(y)!.length) ?? null;
  return {
    range, years, nights: rows, kpis, byId: Object.fromEntries(kpis.map((k) => [k.id, k])) as Record<KpiId, Kpi>,
    newVsReturning: years.map((year) => {
      const ok = byYear.get(year)!.filter((r) => !r.opening);
      const fresh = sumOf(ok, (r) => r.fresh), returning = sumOf(ok, (r) => r.returning);
      return { year, fresh, returning, share: fresh + returning ? fresh / (fresh + returning) : null };
    }),
    lastFullYear: lastFull, asOf,
  };
}

const reportCache = new WeakMap<Catalog, Map<string, KpiReport>>();

/** `buildKpiReport`, remembered per catalogue and range (a handful of ranges at most). */
export function kpiReport(cat: Catalog, range: Range | null): KpiReport {
  let m = reportCache.get(cat);
  if (!m) { m = new Map(); reportCache.set(cat, m); }
  const key = range ? `${range.from}_${range.to}` : "all";
  let r = m.get(key);
  if (!r) {
    if (m.size >= 12) m.delete(m.keys().next().value!);
    r = buildKpiReport(cat, range);
    m.set(key, r);
  }
  return r;
}
