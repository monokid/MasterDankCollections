/** The arithmetic behind the new Trends and Nights & sound charts. Pure: no
 *  React, no DOM, so tools/trendinsights.test.ts runs it.
 *
 *  Rules that keep the numbers honest:
 *   - dates are read as text ("2021-03-01"), never through the local timezone;
 *     weekday and month come from insightstats (UTC) and the string itself;
 *   - an empty month, band or year is a zero count and a null average, never NaN;
 *   - a z-score needs a spread: with zero variance there is nothing to be far
 *     from, so the answer is "none", not Infinity;
 *   - weather that was never fetched is "unknown" and is counted as such, not
 *     dropped silently and not filed under a band;
 *   - nothing here says why something happened. */
import type { Event, Phase, Track } from "./catalog.ts";
import { MONTHS, WEEKDAYS, mean, weekdayOf, formatKpi, kpiLabel, type KpiId, type KpiReport } from "./insightstats.ts";
import { nightStats } from "./nightstats.ts";
import { moonOnNight } from "./moon.ts";
import { CONDITION_LABEL, conditionOf, eveningOf, type WeatherMap } from "./weather.ts";

// ------------------------------------------------------------------- small maths

/** Each value as a share of the series' own largest value (0-1); gaps stay gaps.
 *  A series of only zeros stays zeros rather than dividing by nothing. */
export function normalise(values: Array<number | null>): Array<number | null> {
  const top = Math.max(0, ...values.map((v) => v ?? 0));
  return values.map((v) => (v === null ? null : top > 0 ? v / top : 0));
}

/** Trailing mean over `w` points, skipping gaps (same rule as charts.rolling). */
export function trailing(values: Array<number | null>, w: number): Array<number | null> {
  return values.map((_, i) => {
    const win = values.slice(Math.max(0, i - w + 1), i + 1).filter((v): v is number => v !== null);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
}

/** Pearson r over the points where both series have a value; null under 3 pairs or no spread. */
export function pearson(a: Array<number | null>, b: Array<number | null>): { r: number; n: number } | null {
  const xs: number[] = [], ys: number[] = [];
  a.forEach((v, i) => { const w = b[i]; if (v !== null && w !== null && w !== undefined) { xs.push(v); ys.push(w); } });
  if (xs.length < 3) return null;
  const mx = mean(xs)!, my = mean(ys)!;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return { r: sxy / Math.sqrt(sxx * syy), n: xs.length };
}

/** How far each point sits from the nights around it, in standard deviations.
 *  The window is up to `half` points either side, the point itself left out, so
 *  an outlier does not hide in its own average. Null where fewer than `min`
 *  neighbours have a value, and where the neighbours are all equal (no spread). */
export function neighbourZ(values: Array<number | null>, half = 4, min = 4): Array<number | null> {
  return values.map((v, i) => {
    if (v === null) return null;
    const nb: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      if (j !== i && values[j] !== null) nb.push(values[j]!);
    }
    if (nb.length < min) return null;
    const m = mean(nb)!;
    const sd = Math.sqrt(nb.reduce((a, x) => a + (x - m) ** 2, 0) / nb.length);
    return sd > 1e-9 ? (v - m) / sd : null;
  });
}

export const isOutlier = (z: number | null, limit = 2) => z !== null && Math.abs(z) > limit;

// --------------------------------------------------------------- compare two KPIs

export interface Compared {
  years: string[];
  a: Array<number | null>;
  b: Array<number | null>;
  /** Shown on the chart: each against its own peak (0-1), smoothed when asked. */
  na: Array<number | null>;
  nb: Array<number | null>;
  /** The values behind `na` / `nb`, as plotted (smoothed when asked). */
  ra: Array<number | null>;
  rb: Array<number | null>;
}

export function compareKpis(report: KpiReport, idA: KpiId, idB: KpiId, smooth: number): Compared {
  const years = report.years;
  const pick = (id: KpiId) => report.byId[id].yearSeries.map((p) => p.value);
  const a = pick(idA), b = pick(idB);
  const ra = smooth > 1 ? trailing(a, smooth) : a, rb = smooth > 1 ? trailing(b, smooth) : b;
  return { years, a, b, ra, rb, na: normalise(ra), nb: normalise(rb) };
}

/** One sentence of what the two series did, in numbers only. */
export function compareReading(report: KpiReport, idA: KpiId, idB: KpiId): string {
  const A = kpiLabel(idA), B = kpiLabel(idB);
  if (idA === idB) return `${A} against itself: pick two different measures.`;
  const { years, a, b } = compareKpis(report, idA, idB, 0);
  const first = (v: Array<number | null>) => v.findIndex((x) => x !== null);
  const last = (v: Array<number | null>) => v.reduce<number>((k, x, i) => (x !== null ? i : k), -1);
  const fa = first(a), la = last(a), fb = first(b), lb = last(b);
  if (fa < 0 || fb < 0) return "One of these has no yearly figures in this range.";
  const fmt = (id: KpiId, v: number | null) => formatKpi(report.byId[id].format, v);
  const move = (id: KpiId, v: Array<number | null>, f: number, l: number) =>
    f === l ? `${kpiLabel(id)}: ${fmt(id, v[f])} in ${years[f]} only`
      : `${kpiLabel(id)} went from ${fmt(id, v[f])} in ${years[f]} to ${fmt(id, v[l])} in ${years[l]}`;
  const dir = (v: Array<number | null>, f: number, l: number) =>
    f === l ? 0 : Math.sign((v[l] as number) - (v[f] as number));
  const da = dir(a, fa, la), db = dir(b, fb, lb);
  const together = da !== 0 && da === db ? ` Both ${da > 0 ? "are higher" : "are lower"} in the last year than in the first.` : "";
  const r = pearson(a, b);
  const rText = r ? ` Across ${r.n} years the two yearly series have r = ${r.r.toFixed(2)}${r.n < 8 ? " (few years: weak evidence either way)" : ""}.` : "";
  const open = report.lastFullYear && Math.max(la, lb) >= 0 && years[Math.max(la, lb)] > report.lastFullYear
    ? ` ${years[Math.max(la, lb)]} is not a full year, so its figures cover only part of it.` : "";
  return `${move(idA, a, fa, la)}; ${move(idB, b, fb, lb)}.${together}${open}${rText}`;
}

// ---------------------------------------------------------------------- seasons

export interface Dated { date: string }
const monthOf = (date: string) => +date.slice(5, 7);

/** Nights per calendar month, January first; months with none are 0. */
export function monthCounts(rows: Dated[]): number[] {
  const out = Array<number>(12).fill(0);
  for (const r of rows) { const m = monthOf(r.date); if (m >= 1 && m <= 12) out[m - 1]++; }
  return out;
}

/** Nights per weekday, Monday first. */
export function weekdayCounts(rows: Dated[]): number[] {
  const out = Array<number>(7).fill(0);
  for (const r of rows) out[weekdayOf(r.date)]++;
  return out;
}

/** years x 12 grid of night counts. A year with no nights is a row of zeros,
 *  so a range that cuts a year still shows every year it touches. */
export function monthYearGrid(rows: Dated[], years: string[]): number[][] {
  const at = new Map(years.map((y, i) => [y, i]));
  const grid = years.map(() => Array<number>(12).fill(0));
  for (const r of rows) {
    const i = at.get(r.date.slice(0, 4)), m = monthOf(r.date);
    if (i !== undefined && m >= 1 && m <= 12) grid[i][m - 1]++;
  }
  return grid;
}

export const monthName = (m: number) => MONTHS[m] ?? `Month ${m + 1}`;
export const weekdayName = (d: number) => WEEKDAYS[d] ?? `Day ${d}`;

/** "Most nights fell in October (6 of 35); none in March." */
export function peakReading(counts: number[], names: (i: number) => string, noun: string, prep = "on"): string {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return "No nights in this range.";
  const top = Math.max(...counts);
  const tops = counts.flatMap((c, i) => (c === top ? [names(i)] : []));
  const none = counts.flatMap((c, i) => (c === 0 ? [names(i)] : []));
  return `${total} nights in total. Most fell ${prep} ${tops.join(" and ")} (${top} of ${total})${none.length ? `; none ${prep} ${none.length > 3 ? `${none.length} ${noun}s` : none.join(", ")}` : ""}.`;
}

// -------------------------------------------------------------------- night kinds

/** The kind of night from its normalised `types`: one word, or "Roll + Trip";
 *  anything with a candyflip in it is a candyflip night. */
export function nightKind(types: string[]): string {
  const t = new Set(types.map((x) => x.toLowerCase()));
  if (t.has("candyflip")) return "Candyflip";
  if (t.has("roll") && t.has("trip")) return "Roll + Trip";
  if (t.has("roll")) return "Roll";
  if (t.has("trip")) return "Trip";
  const other = [...t][0];
  return other ? other[0].toUpperCase() + other.slice(1) : "Unlabelled";
}

export interface KindsByYear { kinds: string[]; years: string[]; counts: number[][] }

/** counts[year][kind]. Kinds in the order Trip, Roll, Roll + Trip, Candyflip, the rest. */
export function kindsByYear(nights: Array<Pick<Event, "date" | "types">>, years: string[]): KindsByYear {
  const order = ["Trip", "Roll", "Roll + Trip", "Candyflip"];
  const seen = new Set(nights.map((e) => nightKind(e.types)));
  const kinds = [...order.filter((k) => seen.has(k)), ...[...seen].filter((k) => !order.includes(k)).sort()];
  const counts = years.map(() => kinds.map(() => 0));
  for (const e of nights) {
    const yi = years.indexOf(e.date!.slice(0, 4));
    if (yi >= 0) counts[yi][kinds.indexOf(nightKind(e.types))]++;
  }
  return { kinds, years, counts };
}

// ---------------------------------------------------------------------- histogram

export interface Bin { start: number; end: number; items: number[] }

/** Bins of `width` from the lowest value's bin to the highest, empty ones between included.
 *  A value on an edge goes in the bin that starts there. `items` are indexes into `values`. */
export function histogram(values: number[], width: number): Bin[] {
  if (!values.length || !(width > 0)) return [];
  const lo = Math.floor(Math.min(...values) / width), hi = Math.floor(Math.max(...values) / width);
  const bins: Bin[] = [];
  for (let b = lo; b <= hi; b++) bins.push({ start: b * width, end: (b + 1) * width, items: [] });
  values.forEach((v, i) => bins[Math.floor(v / width) - lo].items.push(i));
  return bins;
}

export const hoursLabel = (min: number) => {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
};

// ------------------------------------------------------- groups: weather and moon

export interface Group { key: string; n: number; songs: number | null; minutes: number | null; ids: string[] }
export interface GroupInput { id: string; songs: number; minutes: number | null; group: string | null }

/** Average songs and length per group, in the order of `order`. A group with no
 *  nights is kept (n = 0, averages null) so the gap is visible. Inputs whose
 *  group is null are returned apart as `unknown`. */
export function groupAverages(rows: GroupInput[], order: string[]): { groups: Group[]; unknown: number } {
  const groups = order.map((key): Group => ({ key, n: 0, songs: null, minutes: null, ids: [] }));
  let unknown = 0;
  const by = new Map(groups.map((g) => [g.key, [] as GroupInput[]]));
  for (const r of rows) {
    if (r.group === null || !by.has(r.group)) { unknown++; continue; }
    by.get(r.group)!.push(r);
  }
  for (const g of groups) {
    const rs = by.get(g.key)!;
    g.n = rs.length; g.ids = rs.map((r) => r.id);
    g.songs = mean(rs.map((r) => r.songs));
    g.minutes = mean(rs.flatMap((r) => (r.minutes === null ? [] : [r.minutes])));
  }
  return { groups, unknown };
}

export const TEMP_BANDS = ["under 5 °C", "5-9 °C", "10-14 °C", "15-19 °C", "20 °C and over"] as const;
export function tempBand(t: number | null | undefined): string | null {
  if (t === null || t === undefined || !Number.isFinite(t)) return null;
  return t < 5 ? TEMP_BANDS[0] : t < 10 ? TEMP_BANDS[1] : t < 15 ? TEMP_BANDS[2] : t < 20 ? TEMP_BANDS[3] : TEMP_BANDS[4];
}

export const SKY_GROUPS = ["Clear", "Cloudy", "Rain", "Snow"] as const;
/** Evening sky in four groups: clear/partly, overcast/fog, drizzle/rain/thunder, snow. */
export function skyGroup(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const c = conditionOf(code);
  return c === "clear" || c === "partly" ? "Clear" : c === "cloudy" || c === "fog" ? "Cloudy" : c === "snow" ? "Snow" : "Rain";
}
export const skyDetail = (code: number) => CONDITION_LABEL[conditionOf(code)];

export const MOON_SHORT = ["New", "Waxing crescent", "First quarter", "Waxing gibbous", "Full", "Waning gibbous", "Last quarter", "Waning crescent"] as const;
export const moonGroup = (date: string) => MOON_SHORT[moonOnNight(date).phase];

/** The three groupings of nights by evening weather and moon, plus how many nights had weather. */
export function weatherInputs(nights: Array<{ id: string; date: string; songs: number; minutes: number | null }>, weather: WeatherMap) {
  const known = nights.filter((n) => weather[n.date]).length;
  const base = (n: (typeof nights)[number]) => ({ id: n.id, songs: n.songs, minutes: n.minutes });
  return {
    known,
    temp: nights.map((n): GroupInput => ({ ...base(n), group: weather[n.date] ? tempBand(eveningOf(weather[n.date]).temp) : null })),
    sky: nights.map((n): GroupInput => ({ ...base(n), group: weather[n.date] ? skyGroup(eveningOf(weather[n.date]).code) : null })),
    moon: nights.map((n): GroupInput => ({ ...base(n), group: moonGroup(n.date) })),
  };
}

// -------------------------------------------------------------------- set structure

export interface NightStructure {
  id: string; date: string;
  /** Named contributors' lists with at least one played track. */
  lists: number;
  /** Of those, lists with at least one phase. */
  phasedLists: number;
  /** Played tracks of those lists, and how many sit in a phase. */
  tracks: number; phasedTracks: number;
  /** Phases that have a played track. */
  phases: number;
}

/** Per night, from the played tracks only (a list and its anonymised twin are one list). */
export function nightStructure(ev: { id: string; date: string }, tracks: Track[], phases: Phase[]): NightStructure {
  const st = nightStats(tracks, phases);
  const named = st.persons.filter((p) => p.personId);
  return {
    id: ev.id, date: ev.date, lists: named.length,
    phasedLists: named.filter((p) => p.phases > 0).length,
    tracks: named.reduce((a, p) => a + p.songs, 0),
    phasedTracks: named.reduce((a, p) => a + p.byPhase.filter((b) => b.phase).reduce((x, b) => x + b.songs, 0), 0),
    phases: named.reduce((a, p) => a + p.phases, 0),
  };
}

export interface StructureSummary {
  nights: number;
  listsPerNight: number | null;
  /** Mean over nights of (lists with phases / lists). */
  phasedListShare: number | null;
  /** Played tracks in a phase / all played tracks of named lists. */
  phasedTrackShare: number | null;
  tracksPerPhase: number | null;
}

export function summariseStructure(rows: NightStructure[]): StructureSummary {
  const withLists = rows.filter((r) => r.lists > 0);
  const tracks = withLists.reduce((a, r) => a + r.tracks, 0), phased = withLists.reduce((a, r) => a + r.phasedTracks, 0);
  const phases = withLists.reduce((a, r) => a + r.phases, 0);
  return {
    nights: withLists.length,
    listsPerNight: mean(withLists.map((r) => r.lists)),
    phasedListShare: mean(withLists.map((r) => r.phasedLists / r.lists)),
    phasedTrackShare: tracks ? phased / tracks : null,
    tracksPerPhase: phases ? phased / phases : null,
  };
}
