/** Group-level people views. Each test is named after the way a number could quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Event, Track } from "../src/catalog.ts";
import { peopleIndex } from "../src/peoplestats.ts";
import { attendance, changes, commonRun, groupSize, handing, overlap, shapes, sharedArtists } from "../src/peopleinsights.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

let n = 0;
const ev = (id: string, people: string[] = []) => ({ id, kind: "event", date: id, types: ["roll"], people }) as unknown as Event;
const tr = (eventId: string, personId: string | null, song: string | null) =>
  ({ id: `t${++n}`, eventId, personId, phaseId: null, artist: song?.split("|")[0] ?? null, title: song?.split("|")[1] ?? null,
    songId: song, twinId: null, playOrder: null, variant: null, played: true, flags: [], durationSec: 200 }) as unknown as Track;
const cat = (events: Event[], tracks: Track[], names = ["ann", "bo", "cy"]) =>
  ({ events, tracks, phases: [], songs: [], artists: [],
    people: names.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })) }) as unknown as Catalog;
const D = ["2016-01-01", "2016-02-01", "2017-01-01", "2018-01-01", "2019-01-01"];
const events = D.map((d) => ev(d));
// peopleIndex caches per catalogue object, so every test builds its own.
const build = (tracks: Track[], names?: string[]) => peopleIndex(cat(events, tracks, names));

test("years before someone joined are no data, not 0%", () => {
  const ix = build([tr(D[0], "ann", "a|1"), tr(D[3], "bo", "b|1"), tr(D[4], "bo", "b|2")]);
  const a = attendance(ix, null);
  const bo = a.people.findIndex((p) => p.id === "bo");
  assert.deepEqual(a.years, [2016, 2017, 2018, 2019]);
  assert.deepEqual(a.share[bo].slice(0, 2), [null, null]);
  assert.equal(a.share[bo][2], 1);
});

test("a year after someone's last night is outside their span too", () => {
  const ix = build([tr(D[0], "ann", "a|1"), tr(D[4], "bo", "b|1")]);
  const a = attendance(ix, null);
  assert.equal(a.share[a.people.findIndex((p) => p.id === "ann")][3], null);
});

test("a person with a single night does not crash and gets exactly one cell", () => {
  const ix = build([tr(D[2], "cy", "c|1"), tr(D[0], "ann", "a|1")]);
  const a = attendance(ix, null);
  const cy = a.people.findIndex((p) => p.id === "cy");
  assert.equal(a.share[cy].filter((v) => v !== null).length, 1);
  const sh = shapes(ix, null).shapes.find((s) => s.id === "cy")!;
  assert.equal(sh.songsPerNight.filter((v) => v !== null).length, 1);
  assert.equal(sh.newShare.filter((v) => v !== null).length, 1);
});

test("people are listed by when they joined, not by how much they brought", () => {
  const ix = build([tr(D[0], "cy", "c|1"), tr(D[1], "ann", "a|1"), tr(D[1], "ann", "a|2"), tr(D[1], "ann", "a|3")]);
  assert.deepEqual(attendance(ix, null).people.map((p) => p.id), ["cy", "ann"]);
});

test("an empty range gives empty views instead of dividing by zero", () => {
  const ix = build([tr(D[0], "ann", "a|1")]);
  const none = new Set<string>();
  assert.equal(attendance(ix, none).people.length, 0);
  assert.equal(groupSize(ix, none).common, null);
  assert.equal(groupSize(ix, none).nights, 0);
  assert.equal(changes(ix, none).length, 0);
  assert.equal(overlap(ix, none).split.total, 0);
  assert.equal(handing(ix, none).considered, 0);
  assert.equal(commonRun([0], 0), null);
});

test("group size counts nights per head count and finds the common run", () => {
  const ix = build([tr(D[0], "ann", "a|1"), tr(D[0], "bo", "b|1"), tr(D[1], "ann", "a|2"), tr(D[1], "bo", "b|2"),
    tr(D[2], "ann", "a|3"), tr(D[2], "bo", "b|3"), tr(D[2], "cy", "c|3"), tr(D[3], "ann", "a|4")]);
  const g = groupSize(ix, new Set(D.slice(0, 4)));
  assert.deepEqual(g.sizes, [0, 1, 2, 1]);
  assert.deepEqual(g.common && [g.common.from, g.common.to], [2, 2]);
  assert.equal(g.perYear.find((y) => y.year === 2016)!.avg, 2);
});

test("a joiner is counted once, and a year of absence between two visits is 'away'", () => {
  const ix = build([tr(D[0], "ann", "a|1"), tr(D[0], "bo", "b|1"), tr(D[3], "bo", "b|2"), tr(D[3], "ann", "a|2"), tr(D[4], "ann", "a|3")]);
  const c = changes(ix, null);
  assert.deepEqual(c.find((y) => y.year === 2016)!.joined, ["Ann", "Bo"]);
  assert.deepEqual(c.find((y) => y.year === 2017)!.away, ["Ann", "Bo"]);
  assert.deepEqual(c.find((y) => y.year === 2018)!.back, ["Ann", "Bo"]);
  assert.deepEqual(c.find((y) => y.year === 2018)!.joined, []);
  assert.deepEqual(c.find((y) => y.year === 2019)!.away, []);   // Bo's last year was 2018: not away
});

test("artist overlap is symmetric and the diagonal is blank", () => {
  const ix = build([tr(D[0], "ann", "x|1"), tr(D[0], "ann", "y|1"), tr(D[0], "bo", "x|2"), tr(D[1], "bo", "z|1"), tr(D[1], "bo", "w|1")]);
  const o = overlap(ix, null);
  const [i, j] = [o.people.findIndex((p) => p.id === "ann"), o.people.findIndex((p) => p.id === "bo")];
  assert.equal(o.jaccard[i][j], o.jaccard[j][i]);
  assert.equal(o.jaccard[i][j], 1 / 4);
  assert.equal(o.jaccard[i][i], null);
  assert.deepEqual(sharedArtists(o, i, j).map((a) => a.id), ["x"]);
  assert.deepEqual(sharedArtists(o, i, i), []);
});

test("unattributed tracks never belong to anyone in the artist split", () => {
  const ix = build([tr(D[0], "ann", "x|1"), tr(D[0], null, "ghost|1"), tr(D[1], null, "x|2")]);
  const o = overlap(ix, null);
  assert.equal(o.split.total, 1);
  assert.equal(o.split.one, 1);
});

test("the artist split puts one, two and three-plus bringers in separate buckets", () => {
  const ix = build([tr(D[0], "ann", "x|1"), tr(D[0], "bo", "x|2"), tr(D[0], "cy", "x|3"), tr(D[1], "ann", "y|1"), tr(D[1], "bo", "y|2"), tr(D[2], "ann", "z|1")]);
  const s = overlap(ix, null).split;
  assert.deepEqual([s.one, s.two, s.three, s.total], [1, 1, 1, 3]);
});

test("the opening night has no 'new' share and nothing was first brought there", () => {
  const ix = build([tr(D[0], "ann", "a|1"), tr(D[0], "bo", "a|1"), tr(D[1], "cy", "a|1")]);
  const sh = shapes(ix, null).shapes.find((s) => s.id === "ann")!;
  assert.equal(sh.newShare[0], null);
  assert.equal(handing(ix, null).considered, 0);
});

test("handing on counts a song once per pair however often it comes back, and not to its first bringer", () => {
  const ix = build([tr(D[0], "ann", "o|1"), tr(D[1], "ann", "a|1"), tr(D[2], "bo", "a|1"), tr(D[3], "bo", "a|1"), tr(D[4], "ann", "a|1"),
    tr(D[1], "ann", "a|2")]);
  const h = handing(ix, null);
  const [i, j] = [h.people.findIndex((p) => p.id === "ann"), h.people.findIndex((p) => p.id === "bo")];
  assert.equal(h.counts[i][j], 1);
  assert.equal(h.counts[j][i], 0);
  assert.equal(h.counts[i][i], 0);
  assert.equal(h.considered, 2);
  assert.equal(h.passed, 1);
});

test("a song first heard from an unattributed track is not handed on by anyone", () => {
  const ix = build([tr(D[0], "ann", "o|1"), tr(D[1], null, "a|1"), tr(D[2], "bo", "a|1")]);
  assert.equal(handing(ix, null).considered, 0);
});

test("a range hides later nights from the handing count", () => {
  const ix = build([tr(D[0], "ann", "o|1"), tr(D[1], "ann", "a|1"), tr(D[4], "bo", "a|1")]);
  assert.equal(handing(ix, null).passed, 1);
  const ix2 = build([tr(D[0], "ann", "o|1"), tr(D[1], "ann", "a|1"), tr(D[4], "bo", "a|1")]);
  assert.equal(handing(ix2, new Set(D.slice(0, 4))).passed, 0);
});

test("set shapes: songs per night is a mean over nights they brought, and the max scale is shared", () => {
  const ix = build([tr(D[0], "ann", "a|1"), tr(D[1], "ann", "a|2"), tr(D[1], "ann", "a|3"), tr(D[1], "bo", "b|1")]);
  const s = shapes(ix, null);
  assert.equal(s.shapes.find((x) => x.id === "ann")!.songsPerNight[0], 1.5);
  assert.equal(s.maxSongs, 1.5);
});

if (failures.length) { console.error(`FAIL ${failures.length}\n${failures.join("\n")}`); process.exit(1); }
console.log(`peopleinsights: ${passed} tests passed`);
