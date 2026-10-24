/** Tests for src/trendinsights.ts (the Trends and Nights & sound charts). Each is
 *  named after the way the number would quietly go wrong. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareKpis, compareReading, groupAverages, histogram, kindsByYear, monthCounts, monthYearGrid, neighbourZ,
  nightKind, normalise, pearson, peakReading, skyGroup, tempBand, trailing, weatherInputs, weekdayCounts,
  summariseStructure, moonGroup,
} from "../src/trendinsights.ts";
import { buildKpiReport, weekdayOf } from "../src/insightstats.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

test("weekday off-by-one: dates are read as text, so 2021-03-01 is a Monday in every timezone", () => {
  assert.equal(weekdayOf("2021-03-01"), 0);
  assert.equal(weekdayOf("2021-03-07"), 6);
  assert.deepEqual(weekdayCounts([{ date: "2021-03-01" }, { date: "2021-03-07" }, { date: "2021-03-07" }]), [1, 0, 0, 0, 0, 0, 2]);
  // every real night lands on exactly one weekday
  const cat = JSON.parse(readFileSync(new URL("../public/data/catalog.json", import.meta.url), "utf8"));
  const dates = cat.events.filter((e: { kind: string; date: string | null }) => e.kind !== "collection" && e.date).map((e: { date: string }) => ({ date: e.date }));
  assert.ok(dates.length > 0);
  assert.equal(weekdayCounts(dates).reduce((a, b) => a + b, 0), dates.length);
  assert.equal(monthCounts(dates).reduce((a, b) => a + b, 0), dates.length);
});

test("month off-by-one: 31 December and 1 January land in December and January", () => {
  const c = monthCounts([{ date: "2019-12-31" }, { date: "2020-01-01" }, { date: "2020-01-31" }]);
  assert.equal(c[11], 1); assert.equal(c[0], 2); assert.equal(c.length, 12);
});

test("empty months are zero, not missing: a month with no nights still has a bar", () => {
  assert.deepEqual(monthCounts([]), Array(12).fill(0));
  assert.deepEqual(weekdayCounts([]), Array(7).fill(0));
  assert.match(peakReading(Array(12).fill(0), String, "month"), /No nights/);
});

test("ranges that cut a year: the grid keeps every year it touches, empty ones as zeros", () => {
  const g = monthYearGrid([{ date: "2020-06-01" }, { date: "2022-06-02" }], ["2020", "2021", "2022"]);
  assert.equal(g.length, 3);
  assert.equal(g[0][5], 1); assert.equal(g[2][5], 1);
  assert.equal(g[1].reduce((a, b) => a + b, 0), 0);
  // a night outside the listed years is ignored, not thrown into the wrong row
  assert.equal(monthYearGrid([{ date: "1999-01-01" }], ["2020"])[0].reduce((a, b) => a + b, 0), 0);
});

test("z-score with zero variance is none, not Infinity or NaN", () => {
  const z = neighbourZ([5, 5, 5, 5, 5, 5, 5, 9, 5, 5, 5, 5]);
  assert.equal(z[7], null, "neighbours are all 5: no spread, no z");
  assert.ok(z.every((v) => v === null || Number.isFinite(v)));
  assert.deepEqual(neighbourZ([3, 3, 3, 3, 3, 3]), Array(6).fill(null));
});

test("z-score: the point is left out of its own window, so a big outlier cannot hide itself", () => {
  const v = [10, 11, 9, 10, 12, 10, 11, 9, 10, 60, 10, 11, 9, 10, 12];
  const z = neighbourZ(v);
  assert.ok(z[9]! > 5, `z of the spike was ${z[9]}`);
  assert.equal(z.reduce<number>((b, x, i) => (x !== null && Math.abs(x) > Math.abs(z[b] ?? 0) ? i : b), 0), 9, "the spike has the largest z");
});

test("z-score with too few neighbours or gaps is none", () => {
  assert.deepEqual(neighbourZ([1, 2, 3]), [null, null, null]);
  const z = neighbourZ([1, null, 3, 4, 5, 6, 7, 8]);
  assert.equal(z[1], null);
});

test("normalise: a series of zeros stays zeros, gaps stay gaps, the peak is 1", () => {
  assert.deepEqual(normalise([0, 0, null]), [0, 0, null]);
  assert.deepEqual(normalise([2, null, 4]), [0.5, null, 1]);
  assert.deepEqual(normalise([]), []);
});

test("trailing average skips gaps and is null only where nothing is known", () => {
  assert.deepEqual(trailing([2, null, 4], 2), [2, 2, 4]);
  assert.deepEqual(trailing([null, null], 3), [null, null]);
});

test("pearson: needs 3 shared points and a spread; a flat series has no correlation", () => {
  assert.equal(pearson([1, 2], [1, 2]), null);
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
  assert.equal(pearson([1, null, 3, 4], [2, 9, 6, 8])!.n, 3);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8])!.r - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2])!.r + 1) < 1e-12);
});

test("histogram: a value on a bin edge goes in the bin that starts there, empty bins between are kept", () => {
  const h = histogram([29.9, 30, 90], 30);
  assert.deepEqual(h.map((b) => b.start), [0, 30, 60, 90]);
  assert.deepEqual(h.map((b) => b.items.length), [1, 1, 0, 1]);
  assert.deepEqual(histogram([], 30), []);
  assert.equal(histogram([30], 30).length, 1);
});

test("unknown weather is counted as unknown, never filed under a band", () => {
  assert.equal(tempBand(null), null); assert.equal(tempBand(NaN), null); assert.equal(skyGroup(undefined), null);
  assert.equal(tempBand(9.9), "5-9 °C"); assert.equal(tempBand(10), "10-14 °C"); assert.equal(tempBand(-3), "under 5 °C");
  const nights = [{ id: "a", date: "2020-01-01", songs: 10, minutes: 300 }, { id: "b", date: "2020-02-01", songs: 20, minutes: null }];
  const w = weatherInputs(nights, { "2020-01-01": { code: 0, tmax: 5, tmin: 0, precip: 0, wind: 5, eveningTemp: 2, eveningCode: 61 } });
  assert.equal(w.known, 1);
  assert.equal(w.temp[1].group, null); assert.equal(w.sky[1].group, null);
  assert.equal(w.sky[0].group, "Rain", "the evening code (rain) wins over the day code (clear)");
  const g = groupAverages(w.temp, ["under 5 °C", "5-9 °C"]);
  assert.equal(g.unknown, 1); assert.equal(g.groups[0].n, 1); assert.equal(g.groups[1].n, 0);
});

test("group averages: empty group is null not NaN; missing minutes are left out of the length average only", () => {
  const g = groupAverages([
    { id: "a", songs: 10, minutes: 100, group: "x" }, { id: "b", songs: 20, minutes: null, group: "x" },
  ], ["x", "y"]);
  assert.equal(g.groups[0].songs, 15); assert.equal(g.groups[0].minutes, 100); assert.equal(g.groups[0].n, 2);
  assert.equal(g.groups[1].songs, null); assert.equal(g.groups[1].minutes, null); assert.equal(g.groups[1].n, 0);
});

test("moon phase is worked out from the date text and covers every night", () => {
  assert.equal(moonGroup("2000-01-06"), "New");
  assert.equal(moonGroup("2000-01-21"), "Full");
});

test("night kinds: a candyflip with roll is a candyflip night; unlabelled stays visible", () => {
  assert.equal(nightKind(["roll", "candyflip"]), "Candyflip");
  assert.equal(nightKind(["trip", "roll"]), "Roll + Trip");
  assert.equal(nightKind([]), "Unlabelled");
  const k = kindsByYear([{ date: "2020-01-01", types: ["trip"] }, { date: "2020-02-01", types: [] }, { date: "2021-01-01", types: ["roll"] }], ["2020", "2021", "2022"]);
  assert.deepEqual(k.kinds, ["Trip", "Roll", "Unlabelled"]);
  assert.deepEqual(k.counts, [[1, 0, 1], [0, 1, 0], [0, 0, 0]]);
});

test("set structure: a night with no named list is left out of the averages, not counted as zero", () => {
  const s = summariseStructure([
    { id: "a", date: "2020-01-01", lists: 0, phasedLists: 0, tracks: 0, phasedTracks: 0, phases: 0 },
    { id: "b", date: "2020-02-01", lists: 2, phasedLists: 1, tracks: 20, phasedTracks: 10, phases: 5 },
  ]);
  assert.equal(s.nights, 1); assert.equal(s.listsPerNight, 2); assert.equal(s.phasedListShare, 0.5);
  assert.equal(s.phasedTrackShare, 0.5); assert.equal(s.tracksPerPhase, 2);
  assert.equal(summariseStructure([]).listsPerNight, null);
});

test("compare two measures: the reading states numbers, names no cause, and survives an empty range", () => {
  const ev = (id: string) => ({ id, date: id, kind: "event", people: ["p"], types: [], title: "", durationSec: 3600, playedCount: 0 });
  const cat = { events: [ev("2019-01-01"), ev("2019-02-01"), ev("2021-01-01"), ev("2021-02-01"), ev("2021-03-01")], tracks: [], people: [], songs: [], artists: [], phases: [] } as never;
  const r = buildKpiReport(cat, null, "2030-01-01");
  const text = compareReading(r, "nights", "people");
  assert.match(text, /Nights went from 2 in 2019 to 3 in 2021/);
  assert.doesNotMatch(text, /because|caus|due to|led to/i);
  const c = compareKpis(r, "nights", "people", 0);
  assert.deepEqual(c.years, ["2019", "2020", "2021"]);
  assert.equal(c.a[1], 0, "a year with no nights is a zero count");
  assert.equal(c.b[1], 0);
  assert.match(compareReading(buildKpiReport({ events: [], tracks: [], people: [], songs: [], artists: [], phases: [] } as never, null), "nights", "people"), /no yearly figures/i);
  assert.match(compareReading(r, "nights", "nights"), /different/);
});

if (failures.length) {
  console.error(`trendinsights: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`trendinsights: ${passed} passed`);
