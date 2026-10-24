/** Tests for src/musicinsights.ts (the Music tab's figures). Each is named after the
 *  way the number would quietly go wrong. */
import assert from "node:assert/strict";
import {
  ageByYear, bin, collapse, concentrationByYear, decadeOrder, firstSightings, heatTable, keyTable,
  littleExplored, medianLengthByYear, newByYear, nightsLabel, shareSeries, songSeconds, songSpans,
  songsByYear, songsInCell, topShare, yearsBetween, NIGHTS_EDGES, REPEAT_EDGES,
} from "../src/musicinsights.ts";
import type { NightRow } from "../src/insightstats.ts";
import type { EnrichMap } from "../src/enrich.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const night = (date: string, songIds: string[], over: Partial<NightRow> = {}): NightRow => ({
  id: date, date, year: date.slice(0, 4), title: "", plays: songIds.length, songs: songIds.length, minutes: null,
  people: 1, peopleIds: ["p"], songIds, artistIds: [...new Set(songIds.map((s) => s.split("|")[0]))],
  fresh: 0, returning: 0, opening: false, trackSec: 0, timed: 0, ...over,
});
const rec = (songId: string, over: object = {}) =>
  ({ songId, confidence: "high", year: null, genres: [], family: null, country: null, releaseGroup: null, cover: false, ...over });
const en = (...rs: object[]) => Object.fromEntries(rs.map((r) => [(r as { songId: string }).songId, r])) as unknown as EnrichMap;

const fam = (e: EnrichMap | null) => (id: string) => e?.[id]?.confidence === "none" ? null : e?.[id]?.family ?? null;

// ------------------------------------------------------- empty enrichment

test("with no enrichment at all every table is empty and nothing divides by zero", () => {
  const rows = [night("2020-01-01", ["a|1", "b|2"])];
  const t = keyTable(["2020"], songsByYear(rows, ["2020"]), fam(null));
  assert.deepEqual(t.keys, []);
  assert.deepEqual(t.cover, { known: 0, total: 2 });
  assert.deepEqual(shareSeries(t, "rock"), [null]);
  assert.deepEqual(ageByYear(["2020"], songsByYear(rows, ["2020"]), null), [{ median: null, known: 0, total: 2 }]);
  const h = heatTable(new Set(["a|1"]), null);
  assert.equal(h.families.length, 0);
  assert.deepEqual(littleExplored(h), []);
});

// ------------------------------------------------------- partial coverage

test("a year's share is out of the songs with a family, not out of all its songs", () => {
  const e = en(rec("a|1", { family: "rock" }), rec("b|2", { family: "metal" }), rec("c|3"), rec("d|4"));
  const rows = [night("2020-01-01", ["a|1", "b|2", "c|3", "d|4"])];
  const t = keyTable(["2020"], songsByYear(rows, ["2020"]), fam(e));
  assert.deepEqual(t.known, [2]); assert.deepEqual(t.total, [4]);
  assert.equal(shareSeries(t, "rock")[0], 0.5);
  assert.deepEqual(t.cover, { known: 2, total: 4 });
});

test("a match marked 'none' is not a family, even if it carries one", () => {
  const e = en(rec("a|1", { family: "rock", confidence: "none" }));
  const t = keyTable(["2020"], songsByYear([night("2020-01-01", ["a|1"])], ["2020"]), fam(e));
  assert.equal(t.keys.length, 0);
});

test("a song with a release year but no family is in the decades and out of the map", () => {
  const e = en(rec("a|1", { year: 1985 }), rec("b|2", { year: 1985, family: "rock" }));
  const songs = new Set(["a|1", "b|2"]);
  const h = heatTable(songs, e);
  assert.deepEqual(h.cover, { known: 1, total: 2 });
  assert.deepEqual(h.families, ["rock"]); assert.deepEqual(h.decades, ["1980s"]);
  const ages = ageByYear(["2020"], new Map([["2020", songs]]), e);
  assert.equal(ages[0].known, 2);                     // both have a year
});

test("a suspect release year is no year (the decade and the age skip it)", () => {
  const e = en(rec("a|1", { year: 2030, yearSuspect: true }));
  const a = ageByYear(["2020"], new Map([["2020", new Set(["a|1"])]]), e);
  assert.equal(a[0].median, null);
});

test("a release year after the night is left out of the age, not counted as zero", () => {
  const e = en(rec("a|1", { year: 2022 }), rec("b|2", { year: 2010 }));
  const a = ageByYear(["2020"], new Map([["2020", new Set(["a|1", "b|2"])]]), e);
  assert.equal(a[0].median, 10); assert.equal(a[0].known, 1);
});

test("the median age is the middle of the songs, not of the nights they were on", () => {
  const e = en(rec("a|1", { year: 2000 }), rec("b|2", { year: 2010 }), rec("c|3", { year: 2019 }));
  const rows = [night("2020-01-01", ["a|1", "b|2"]), night("2020-02-01", ["a|1", "c|3"])];
  const a = ageByYear(["2020"], songsByYear(rows, ["2020"]), e);
  assert.equal(a[0].median, 10);                      // ages 20, 10, 1
});

// ------------------------------------------------------- years with no nights

test("a year with no nights has empty cells, a null share and a null length, never NaN", () => {
  const e = en(rec("a|1", { family: "rock" }));
  const rows = [night("2019-01-01", ["a|1"]), night("2021-01-01", ["a|1"])];
  const years = ["2019", "2020", "2021"];
  const t = keyTable(years, songsByYear(rows, years), fam(e));
  assert.deepEqual(t.cells[1], [0]); assert.deepEqual(t.total, [1, 0, 1]);
  assert.deepEqual(shareSeries(t, "rock"), [1, null, 1]);
  assert.deepEqual(medianLengthByYear(rows, years, new Map([["a|1", 180]])), [3, null, 3]);
  const c = concentrationByYear(rows, years);
  assert.equal(c[1].song10, null);
});

// ------------------------------------------------------- collapse

test("collapsing to the biggest keys keeps every song: the folded ones land in the last column", () => {
  const e = en(rec("a|1", { family: "x" }), rec("b|2", { family: "x" }), rec("c|3", { family: "y" }), rec("d|4", { family: "z" }));
  const rows = [night("2020-01-01", ["a|1", "b|2", "c|3", "d|4"])];
  const full = keyTable(["2020"], songsByYear(rows, ["2020"]), fam(e));
  const c = collapse(full, 1);
  assert.deepEqual(c.keys, ["x"]); assert.deepEqual(c.rest.sort(), ["y", "z"]);
  assert.deepEqual(c.cells[0], [2, 2]);
  assert.equal(collapse(full, 5).rest.length, 0);
  assert.equal(collapse(full, 5).cells[0].length, 3);   // no empty "rest" column
});

test("decade columns keep chronological order after collapsing, whatever their size", () => {
  const e = en(rec("a|1", { year: 2005 }), rec("b|2", { year: 1985 }), rec("c|3", { year: 1985 }), rec("d|4", { year: 2015 }), rec("e|5", { year: 2015 }), rec("f|6", { year: 2015 }));
  const rows = [night("2020-01-01", ["a|1", "b|2", "c|3", "d|4", "e|5", "f|6"])];
  const dec = (id: string) => (e[id]?.year ? `${Math.floor(e[id].year! / 10) * 10}s` : null);
  const t = collapse(keyTable(["2020"], songsByYear(rows, ["2020"]), dec, decadeOrder), 3, decadeOrder);
  assert.deepEqual(t.keys, ["1980s", "2000s", "2010s"]);
  assert.deepEqual(t.cells[0], [2, 1, 3]);
});

// ------------------------------------------------------- zero division / concentration

test("the top share of nothing is null, not NaN", () => {
  assert.equal(topShare([], 10), null);
  assert.equal(topShare([0, 0], 1), null);
});

test("a year with no more songs than k is not reported as 100% concentrated", () => {
  assert.equal(topShare([3, 2, 1], 3), null);
  assert.equal(topShare([3, 2, 1], 2), 5 / 6);
});

test("concentration counts a song once per night, however many people brought it", () => {
  // song a on 2 nights, b on 1, c on 1: a holds 2 of 4
  const rows = [night("2020-01-01", ["a|1", "b|1"]), night("2020-02-01", ["a|1", "c|1"])];
  const c = concentrationByYear(rows, ["2020"]);
  assert.equal(c[0].song10, null);                    // only 3 songs: not "10 most"
  assert.equal(topShare([2, 1, 1], 1), 0.5);
});

// ------------------------------------------------------- spans and bins

test("nights per song: a song on three nights is in the 3 bin, 10+ nights in the 10-19 bin", () => {
  const rows = [night("2020-01-01", ["a|1"]), night("2020-02-01", ["a|1"]), night("2020-03-01", ["a|1"])];
  const spans = songSpans(rows);
  assert.equal(spans[0].nights, 3);
  const bins = bin(spans, (s) => s.nights, REPEAT_EDGES, nightsLabel);
  assert.deepEqual(bins.map((b) => b.items.length), [0, 0, 1, 0]);
  const wide = bin([{ n: 10 }, { n: 19 }, { n: 20 }, { n: 6 }, { n: 9 }], (x) => x.n, NIGHTS_EDGES, nightsLabel);
  assert.deepEqual(wide.map((b) => `${b.label}:${b.items.length}`), ["1:0", "2:0", "3:0", "4:0", "5:0", "6–9:2", "10–19:2", "20+:1"]);
});

test("a value below the first bin edge is in no bin, and the last bin is open-ended", () => {
  const b = bin([0, 99], (x) => x, [1, 5], nightsLabel);
  assert.deepEqual(b.map((x) => x.items.length), [0, 1]);
});

test("years between first and last night count whole 365.25-day years (a leap year does not tip it)", () => {
  assert.equal(yearsBetween("2020-01-01", "2020-12-31"), 0);
  assert.equal(yearsBetween("2021-01-01", "2022-01-01"), 0);   // 365 days is 0.999 years
  assert.equal(yearsBetween("2019-03-01", "2020-03-01"), 1);   // 366 days (a leap day) still 1
  assert.equal(yearsBetween("2016-01-01", "2020-01-01"), 4);   // 1461 days = 4.0 years
});

test("songSpans keeps first and last night apart even when rows are one night", () => {
  const s = songSpans([night("2020-05-05", ["a|1"])])[0];
  assert.equal(s.first, s.last); assert.equal(s.years, 0);
});

// ------------------------------------------------------- track length

test("a song takes the median of its played tracks, a track without length borrows its twin's, and unplayed copies do not count", () => {
  const tr = (id: string, songId: string | null, d: number | null, over: object = {}) =>
    ({ id, songId, durationSec: d, played: true, twinId: null, ...over });
  const cat = { tracks: [
    tr("1", "a|1", 180), tr("2", "a|1", 240), tr("3", "a|1", 9999, { played: false }),
    tr("4", "b|2", null, { twinId: "5" }), tr("5", null, 300, { twinId: "4" }),
    tr("6", "c|3", null), tr("7", "d|4", 0),
  ] } as never;
  const m = songSeconds(cat);
  assert.equal(m.get("a|1"), 210);
  assert.equal(m.get("b|2"), 300);
  assert.equal(m.has("c|3"), false);                  // no length: unknown, not zero
  assert.equal(m.has("d|4"), false);
  assert.equal(m.size, 2);
});

test("a song with no recorded length is not a 0-minute song in the yearly median", () => {
  const rows = [night("2020-01-01", ["a|1", "b|2"])];
  assert.deepEqual(medianLengthByYear(rows, ["2020"], new Map([["a|1", 240]])), [4]);
});

// ------------------------------------------------------- new music

test("the opening night introduces nothing: its songs are not new in any year", () => {
  const hist = [night("2019-01-01", ["a|1"]), night("2020-01-01", ["a|1", "b|2"])];
  const f = firstSightings(hist);
  const m = newByYear(hist, ["2019", "2020"], f.song, "song");
  assert.equal(m.get("2019")!.size, 0);
  assert.deepEqual([...m.get("2020")!], ["b|2"]);
});

test("new is judged on the whole history: a song first heard before the range is not new in it", () => {
  const hist = [night("2018-01-01", ["x|0"]), night("2019-01-01", ["a|1"]), night("2020-01-01", ["a|1", "b|2"])];
  const f = firstSightings(hist);
  const inRange = hist.slice(2);
  const m = newByYear(inRange, ["2020"], f.song, "song");
  assert.deepEqual([...m.get("2020")!], ["b|2"]);      // a|1 was new in 2019, out of view
  const art = newByYear(inRange, ["2020"], f.artist, "artist");
  assert.deepEqual([...art.get("2020")!], ["b"]);
});

test("a song brought twice on its first night is one new song", () => {
  const hist = [night("2019-01-01", ["x|0"]), night("2020-01-01", ["a|1", "a|1"])];
  const m = newByYear(hist, ["2020"], firstSightings(hist).song, "song");
  assert.equal(m.get("2020")!.size, 1);
});

// ------------------------------------------------------- heat map

test("the map counts each song once and names the biggest empty cells by what the rest predicts", () => {
  const e: Record<string, object> = {};
  const songs = new Set<string>();
  const add = (n: number, family: string, year: number) => { for (let i = 0; i < n; i++) { const id = `${family}${year}${i}|s`; songs.add(id); e[id] = rec(id, { family, year }); } };
  add(10, "rock", 1970); add(10, "rock", 1980); add(10, "rock", 1990); add(10, "metal", 1990); add(1, "metal", 1970);
  const h = heatTable(songs, e as unknown as EnrichMap);
  assert.deepEqual(h.decades, ["1970s", "1980s", "1990s"]);     // contiguous
  assert.deepEqual(h.cover, { known: 41, total: 41 });
  const q = littleExplored(h, 5);
  assert.ok(q.every((c) => h.counts[h.families.indexOf(c.family)][h.decades.indexOf(c.decade)] === 0));
  assert.deepEqual([q[0].family, q[0].decade], ["metal", "1980s"]);   // rock has 10 songs in the 1980s, metal none
  assert.equal(songsInCell(songs, e as unknown as EnrichMap, "metal", "1970s").length, 1);
});

test("cells expected to hold under two songs are not named as little explored", () => {
  const e = en(rec("a|1", { family: "rock", year: 1970 }), rec("b|2", { family: "pop", year: 1990 }));
  assert.deepEqual(littleExplored(heatTable(new Set(["a|1", "b|2"]), e)), []);
});

// ------------------------------------------------------- done

if (failures.length) {
  console.error(`musicinsights: ${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log(`musicinsights: ${passed} passed`);
