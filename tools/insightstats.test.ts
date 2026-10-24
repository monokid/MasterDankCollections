/** Tests for src/insightstats.ts (the Insights KPIs) and the pure helpers in
 *  src/charts.tsx. Each is named after the way the number would quietly go wrong,
 *  because a wrong figure looks exactly like a right one. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildKpiReport, formatKpi, kpiReport, mean, median, nightValue, weekdayOf, measure,
} from "../src/insightstats.ts";
import { contrast, inkOn, luminance, niceScale, rampColour, rolling, SERIES } from "../src/charts.tsx";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

// ------------------------------------------------------------------ fixtures

const ev = (id: string, people: string[], over: object = {}) =>
  ({ id, date: id, kind: "event", people, types: [], title: "", durationSec: 3600, playedCount: 0, ...over });
let n = 0;
const tr = (eventId: string, songId: string | null, personId: string | null, over: object = {}) =>
  ({ id: `t${++n}`, eventId, songId, personId, flags: [], played: true, durationSec: 240, twinId: null, ...over });
const mk = (events: object[], tracks: object[]) =>
  ({ events, tracks, people: [], songs: [], artists: [], phases: [] }) as never;

const near = (a: number | null, b: number, eps = 1e-9) => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} !== ${b}`);
};

// ------------------------------------------------------------------- counting

test("a song two people bring to one night is two plays but one song", () => {
  const cat = mk([ev("2020-01-01", ["a", "b"])], [tr("2020-01-01", "x|s", "a"), tr("2020-01-01", "x|s", "b")]);
  const r = buildKpiReport(cat, null);
  assert.equal(r.byId.plays.value, 2);
  assert.equal(r.byId.songsPerNight.value, 1);
  assert.equal(r.byId.songs.value, 1);
});

test("the same file filed twice in one person's list is one play", () => {
  const cat = mk([ev("2020-01-01", ["a"])], [
    tr("2020-01-01", "x|s", "a"), tr("2020-01-01", "x|s", "a", { flags: ["copy"] }),
  ]);
  assert.equal(buildKpiReport(cat, null).byId.plays.value, 1);
});

test("an anonymised list and its named twin are one playlist, never two plays", () => {
  const named = tr("2020-01-01", "x|s", "a", { id: "N" , twinId: "A" });
  const anon = tr("2020-01-01", null, "a", { id: "A", twinId: "N", flags: ["anon"] });   // no tags: identity comes from its twin
  const r = buildKpiReport(mk([ev("2020-01-01", ["a"])], [named, anon]), null);
  assert.equal(r.byId.plays.value, 1);
  assert.equal(r.byId.songs.value, 1);
});

test("an anonymised track nothing could name still counts as a play, but not as a song or artist", () => {
  const cat = mk([ev("2020-01-01", ["a"])], [tr("2020-01-01", null, "a", { flags: ["anon"] }), tr("2020-01-01", "x|s", "a")]);
  const r = buildKpiReport(cat, null);
  assert.equal(r.byId.plays.value, 2);
  assert.equal(r.byId.songsPerNight.value, 2);
  assert.equal(r.byId.songs.value, 1);
  assert.equal(r.byId.artists.value, 1);
});

test("tracks that were not played, and shelves, are not on any night", () => {
  const cat = mk(
    [ev("2020-01-01", ["a"]), { ...ev("shelf", []), date: null, kind: "collection" }],
    [tr("2020-01-01", "x|s", "a"), tr("2020-01-01", "y|s", "a", { played: false }), tr("shelf", "z|s", null)]);
  const r = buildKpiReport(cat, null);
  assert.equal(r.byId.plays.value, 1);
  assert.equal(r.byId.nights.value, 1);
});

test("a song heard on three nights is one different song, three plays", () => {
  const cat = mk(
    [ev("2020-01-01", ["a"]), ev("2020-02-01", ["a"]), ev("2020-03-01", ["a"])],
    ["2020-01-01", "2020-02-01", "2020-03-01"].map((e) => tr(e, "x|s", "a")));
  const r = buildKpiReport(cat, null);
  assert.equal(r.byId.songs.value, 1);
  assert.equal(r.byId.plays.value, 3);
});

test("people and artists are distinct across the range, counted again per year, not summed", () => {
  const cat = mk(
    [ev("2020-01-01", ["a", "b"]), ev("2021-01-01", ["a", "c"])],
    [tr("2020-01-01", "x|1", "a"), tr("2020-01-01", "y|1", "b"), tr("2021-01-01", "x|2", "a")]);
  const r = buildKpiReport(cat, null);
  assert.equal(r.byId.people.value, 3);
  assert.deepEqual(r.byId.people.yearSeries.map((p) => p.value), [2, 2]);
  assert.equal(r.byId.artists.value, 2);
  assert.deepEqual(r.byId.artists.yearSeries.map((p) => p.value), [2, 1]);
});

// -------------------------------------------------------------------- maths

test("the median of an even count is the mean of the middle two", () => {
  assert.equal(median([3, 1, 2, 10]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([]), null);
  const cat = mk([ev("2020-01-01", ["a"]), ev("2020-02-01", ["a"])], [
    tr("2020-01-01", "x|1", "a"), tr("2020-01-01", "x|2", "a"),
    tr("2020-02-01", "x|1", "a"), tr("2020-02-01", "x|2", "a"), tr("2020-02-01", "x|3", "a"),
  ]);
  const k = buildKpiReport(cat, null).byId.songsPerNight;
  assert.equal(k.value, 2.5);
  assert.equal(k.median, 2.5, "two nights of 2 and 3 songs: the middle is their mean");
});

test("an average of nothing is null, never NaN or zero", () => {
  assert.equal(mean([]), null);
  assert.equal(measure("songsPerNight", []), null);
  assert.equal(measure("newShare", []), null);
  assert.equal(measure("trackLength", []), null);
  assert.equal(formatKpi("dec1", null), "–");
  assert.equal(formatKpi("pct", Number.NaN), "–");
});

test("night length ignores nights with no recorded running time instead of averaging in zeros", () => {
  const cat = mk([ev("2020-01-01", ["a"], { durationSec: 3600 }), ev("2020-02-01", ["a"], { durationSec: 0 })], []);
  near(buildKpiReport(cat, null).byId.nightLength.value, 60);
});

test("track length is total running time over the tracks that have one", () => {
  const cat = mk([ev("2020-01-01", ["a"])], [
    tr("2020-01-01", "x|1", "a", { durationSec: 120 }), tr("2020-01-01", "x|2", "a", { durationSec: 240 }),
    tr("2020-01-01", "x|3", "a", { durationSec: null }),
  ]);
  near(buildKpiReport(cat, null).byId.trackLength.value, 3);
});

// ----------------------------------------------------------- empty and gaps

test("an empty range divides by nothing: counts are 0, averages are null, no change is shown", () => {
  const cat = mk([ev("2020-01-01", ["a"])], [tr("2020-01-01", "x|s", "a")]);
  const r = buildKpiReport(cat, { from: "2030-01-01", to: "2030-12-31" });
  assert.deepEqual(r.years, []);
  for (const k of r.kpis) {
    assert.ok(k.value === 0 || k.value === null, `${k.id} = ${k.value}`);
    assert.equal(k.deltaVsPrev, null);
    assert.deepEqual(k.yearSeries, []);
    assert.ok(!/NaN|Infinity/.test(k.sentence));
  }
  assert.equal(r.byId.nights.sentence, "No nights in this range.");
  assert.deepEqual(r.newVsReturning, []);
});

test("a library with no nights at all does not throw", () => {
  const r = buildKpiReport(mk([], []), null);
  assert.equal(r.byId.nights.value, 0);
  assert.equal(r.lastFullYear, null);
});

test("a year with no nights is a gap in the series (0 nights, no average), and no change is drawn across it", () => {
  const cat = mk([ev("2018-05-01", ["a"]), ev("2020-05-01", ["a"])], [tr("2018-05-01", "x|s", "a"), tr("2020-05-01", "y|s", "a")]);
  const r = buildKpiReport(cat, null, "2025-01-01");
  assert.deepEqual(r.years, ["2018", "2019", "2020"]);
  assert.deepEqual(r.byId.nights.yearSeries.map((p) => p.value), [1, 0, 1]);
  assert.equal(r.byId.songsPerNight.yearSeries[1].value, null);
  assert.equal(r.byId.nights.deltaVsPrev, null, "2020 vs an empty 2019 is not a comparison");
});

// ----------------------------------------------------- ranges that cut a year

const cutLib = () => mk(
  [ev("2018-03-01", ["a"]), ev("2019-03-01", ["a"]), ev("2020-03-01", ["a", "b"]), ev("2021-03-01", ["a", "b", "c"])],
  [tr("2018-03-01", "x|1", "a"), tr("2019-03-01", "x|1", "a"), tr("2019-03-01", "x|2", "a"),
   tr("2020-03-01", "x|1", "a"), tr("2020-03-01", "x|3", "a"), tr("2021-03-01", "x|4", "a")]);

test("the last full year is compared with the one before; a range that cuts a year makes it not full", () => {
  const whole = buildKpiReport(cutLib(), null, "2021-03-01");
  assert.equal(whole.lastFullYear, "2020", "2021 is the year of the newest night: not over");
  assert.equal(whole.byId.nights.deltaVsPrev?.fromYear, "2019");
  assert.equal(whole.byId.nights.deltaVsPrev?.toYear, "2020");
  const cut = buildKpiReport(cutLib(), { from: "2019-06-01", to: "2021-12-31" }, "2021-03-01");
  assert.equal(cut.lastFullYear, "2020");
  assert.equal(cut.byId.nights.deltaVsPrev, null, "2019 is cut at June: not a full year, so no comparison");
  const clean = buildKpiReport(cutLib(), { from: "2019-01-01", to: "2021-12-31" }, "2021-03-01");
  assert.equal(clean.byId.nights.deltaVsPrev?.fromYear, "2019");
});

test("the change is stated in neutral words with both figures", () => {
  const d = buildKpiReport(cutLib(), null, "2021-03-01").byId.people.deltaVsPrev!;
  assert.equal(d.prev, 1); assert.equal(d.last, 2);
  assert.equal(d.diff, 1); assert.equal(d.pct, 1);
  assert.equal(d.short, "+1 vs 2019");
  assert.match(d.text, /^2020: 2 · 2019: 1 · change \+1 \(\+100%\)$/);
  assert.ok(!/better|worse|up|down|grew|fell/i.test(d.text));
});

test("a percentage figure changes in points, and a previous value of 0 gives no percentage", () => {
  const d = buildKpiReport(cutLib(), null, "2021-03-01").byId.newShare.deltaVsPrev!;
  assert.match(d.short, /pts vs 2019$/);
  assert.equal(d.pct, null);
  const z = mk([ev("2019-01-01", []), ev("2020-01-01", ["a"]), ev("2020-06-01", ["a"])], []);
  const dz = buildKpiReport(z, null, "2021-01-01").byId.peoplePerNight.deltaVsPrev!;
  assert.equal(dz.prev, 0);
  assert.equal(dz.pct, null, "no division by a zero year");
});

test("new music is judged against the whole history, not the range", () => {
  // x|1 first played 2018 (out of range); x|3 is new in 2020; x|2 new in 2019.
  const r = buildKpiReport(cutLib(), { from: "2020-01-01", to: "2021-12-31" }, "2022-01-01");
  const y2020 = r.newVsReturning.find((y) => y.year === "2020")!;
  assert.deepEqual([y2020.fresh, y2020.returning], [1, 1], "x|1 was heard in 2018: returning, though 2018 is out of view");
  assert.equal(r.byId.songs.value, 3, "but the different-songs count is of the range");
});

// --------------------------------------------------------------- opening night

test("the opening night has no 'before': it is left out of the new-music share", () => {
  const cat = mk([ev("2020-01-01", ["a"]), ev("2020-02-01", ["a"])], [
    tr("2020-01-01", "x|1", "a"), tr("2020-01-01", "x|2", "a"),
    tr("2020-02-01", "x|1", "a"), tr("2020-02-01", "x|3", "a"),
  ]);
  const r = buildKpiReport(cat, null);
  near(r.byId.newShare.value, 0.5, 1e-12);           // x|3 new, x|1 returning; the opening night's two songs do not count
  assert.deepEqual([r.newVsReturning[0].fresh, r.newVsReturning[0].returning], [1, 1]);
  assert.equal(r.nights[0].opening, true);
  assert.equal(r.nights[1].opening, false);
});

test("a range holding only the opening night has no new-music share, not 100% and not a crash", () => {
  const cat = mk([ev("2020-01-01", ["a"]), ev("2020-02-01", ["a"])], [tr("2020-01-01", "x|1", "a"), tr("2020-02-01", "x|1", "a")]);
  const r = buildKpiReport(cat, { from: "2020-01-01", to: "2020-01-15" });
  assert.equal(r.byId.newShare.value, null);
  assert.equal(r.newVsReturning[0].share, null);
  assert.match(r.byId.newShare.sentence, /first night/);
});

test("the opening night is the library's first, even when the range starts later", () => {
  const r = buildKpiReport(cutLib(), { from: "2019-01-01", to: "2021-12-31" });
  assert.ok(r.nights.every((x) => !x.opening), "2018 is out of the range, but 2019 is not the opening night");
});

// -------------------------------------------------------------------- misc

test("per-night values behind a KPI are the KPI of that one night", () => {
  const r = buildKpiReport(cutLib(), null);
  const night = r.nights.find((x) => x.id === "2019-03-01")!;
  assert.equal(nightValue("songsPerNight", night), 2);
  assert.equal(nightValue("people", night), 1);
});

test("the report is remembered per catalogue and range, and a new range is a new report", () => {
  const cat = cutLib();
  assert.equal(kpiReport(cat, null), kpiReport(cat, null));
  assert.notEqual(kpiReport(cat, null), kpiReport(cat, { from: "2019-01-01", to: "2019-12-31" }));
});

test("weekdays count from Monday and months from 1", () => {
  assert.equal(weekdayOf("2024-01-01"), 0);
  assert.equal(weekdayOf("2024-01-07"), 6);
  assert.equal(weekdayOf("2023-12-31"), 6);
});

test("whole numbers, one decimal, percentages and minutes read as they should", () => {
  assert.equal(formatKpi("int", 1234.4), (1234).toLocaleString(), "thousands follow the reader's locale");
  assert.equal(formatKpi("dec1", 3.04), "3.0");
  assert.equal(formatKpi("pct", 0.456), "46%");
  assert.equal(formatKpi("min", 4.26), "4.3 min");
  assert.equal(formatKpi("min", 312.4), "312 min");
});

// ------------------------------------------------------------- chart helpers

test("axis ticks are round numbers that reach the data", () => {
  for (const max of [0.7, 3, 7, 12, 99, 1234, 56789]) {
    const s = niceScale(max);
    assert.ok(s.max >= max, `${max} -> ${s.max}`);
    assert.equal(s.ticks[0], 0);
    assert.equal(s.ticks[s.ticks.length - 1], s.max);
    assert.ok(s.ticks.length <= 8);
  }
  assert.deepEqual(niceScale(0).ticks, [0, 1], "an empty chart still has an axis");
});

test("a rolling average skips gaps and never averages a zero in for them", () => {
  assert.deepEqual(rolling([2, 4, null, 6], 2), [2, 3, 4, 6]);
  assert.deepEqual(rolling([null, null], 3), [null, null]);
});

test("chart colours: every series reads on the panel (3:1), and the heatmap ramp rises in lightness", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const tok = (name: string) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
    assert.ok(m, `token ${name} not found as #rrggbb in styles.css`);
    return m![1];
  };
  const panel = tok("--panel-solid");
  for (const s of SERIES) assert.ok(contrast(tok(s.hex), panel) >= 3, `${s.hex} vs the panel: ${contrast(tok(s.hex), panel).toFixed(2)}`);
  assert.ok(contrast(tok("--ink-dim"), panel) >= 4.5, "tick labels");
  let prev = -1;
  for (let i = 0; i <= 10; i++) {
    const l = luminance(rampColour(i / 10));
    assert.ok(l > prev, `ramp step ${i} is not lighter than the last`);
    prev = l;
  }
  assert.ok(contrast(rampColour(0), rampColour(1)) >= 3, "ends of the ramp are told apart without hue");
  for (let i = 0; i <= 10; i++) {
    const bg = rampColour(i / 10);
    assert.ok(contrast(bg, inkOn(bg)) >= 4.5, `cell text on ramp step ${i}`);
  }
});

if (failures.length) {
  console.error(`insightstats: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`insightstats: ${passed} passed`);
