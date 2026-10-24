/** Music / People song-row helpers. Each test is named after the way a row could quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Track } from "../src/catalog.ts";
import { songColumns, isOn, NO_CHOICE } from "../src/songcols.ts";
import { arrangeColumns, linkable, makeWallInfo, nextSort, tileQuiet, type SongLike } from "../src/songrows.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const trk = (over: Partial<Track> = {}): Track => ({
  id: "t1", eventId: "e1", personId: "p1", phaseId: null, artist: "Aphex Twin", title: "Xtal", album: "SAW", genre: null,
  songId: "aphex|xtal", twinId: null, playOrder: null, variant: null, durationSec: 275, ext: "mp3",
  sizeBytes: 1, path: [], source: "s", played: true, flags: [], provenance: {}, ...over,
});
const cat = {
  events: [], people: [], phases: [], artists: [], tracks: [trk()],
  songs: [{ id: "aphex|xtal", artist: "Aphex Twin", title: "Xtal", variants: [], plays: 1, nights: ["e1"], people: [], firstPlayed: null, lastPlayed: null }],
} as unknown as Catalog;
const song = (o: Partial<SongLike> = {}): SongLike => ({ songId: "aphex|xtal", title: "Xtal", artist: "Aphex Twin", loose: false, nights: 9, ...o });

test("wall info carries the wall's own night count, not the catalogue's", () => {
  assert.equal(makeWallInfo(cat, null)(song()).nights, 9);
});
test("wall info takes duration and album from the song's tracks", () => {
  const i = makeWallInfo(cat, null)(song());
  assert.equal(i.durationSec, 275); assert.equal(i.album, "SAW");
});
test("a loose song gets no facts and no song id, only its title and artist", () => {
  const i = makeWallInfo(cat, null)(song({ songId: "?aphex|xtal", loose: true }));
  assert.equal(i.songId, null); assert.equal(i.durationSec, null); assert.equal(i.album, null);
  assert.equal(i.title, "Xtal"); assert.equal(i.artist, "Aphex Twin");
});
test("a song with no artist has a null artist, not an empty string", () => {
  assert.equal(makeWallInfo(cat, null)(song({ artist: "" })).artist, null);
});
test("the same wall song gives the same info object", () => {
  const f = makeWallInfo(cat, null), s = song();
  assert.equal(f(s), f(s));
});

test("links need an artist or a real title", () => {
  assert.equal(linkable({ artist: null, title: "(untitled)" }), false);
  assert.equal(linkable({ artist: null, title: "  " }), false);
  assert.equal(linkable({ artist: null, title: "Xtal" }), true);
  assert.equal(linkable({ artist: "Aphex Twin", title: "" }), true);
});

test("tile quiet line leads with length and year when known", () => {
  assert.equal(tileQuiet({ durationSec: 275, year: 2017 }, "9 nights", "2015–2026"), "4:35 · 2017 · 9 nights · 2015–2026");
});
test("tile quiet line drops unknown length and year instead of showing a dash", () => {
  assert.equal(tileQuiet({ durationSec: null, year: null }, "9 nights", "2015–2026"), "9 nights · 2015–2026");
  assert.equal(tileQuiet({ durationSec: 0, year: 2017 }, "1 night", "2017"), "2017 · 1 night · 2017");
});

test("header click cycles asc, desc, off", () => {
  const a = nextSort(null, "album");
  assert.deepEqual(a, { id: "album", dir: "asc" });
  const d = nextSort(a, "album");
  assert.deepEqual(d, { id: "album", dir: "desc" });
  assert.equal(nextSort(d, "album"), null);
});
test("clicking another header starts it at ascending", () => {
  assert.deepEqual(nextSort({ id: "album", dir: "desc" }, "genre"), { id: "genre", dir: "asc" });
});

const std = songColumns<number>(() => makeWallInfo(cat, null)(song()));
const ids = (cs: Array<{ id: string }>) => cs.map((c) => c.id);
test("arrange drops, switches off, patches and inserts without touching the input", () => {
  const before = ids(std).join();
  const extra = { id: "strip", label: "T", width: "1fr", align: "left" as const, sortKey: null, text: () => null };
  const out = arrangeColumns(std, { drop: ["artist"], off: ["cover"], patch: { nights: { width: "150px" } }, extra: [{ col: extra, before: "nights" }] });
  assert.ok(!ids(out).includes("artist"));
  assert.equal(ids(out).indexOf("strip"), ids(out).indexOf("nights") - 1);
  assert.equal(out.find((c) => c.id === "nights")!.width, "150px");
  assert.equal(isOn(out.find((c) => c.id === "cover")!, NO_CHOICE), false);
  assert.equal(ids(std).join(), before);
  assert.equal(std.find((c) => c.id === "nights")!.width, "64px");
});
test("an extra column whose anchor is missing goes last, not nowhere", () => {
  const extra = { id: "x", label: "X", width: "1fr", align: "left" as const, sortKey: null, text: () => null };
  assert.equal(ids(arrangeColumns(std, { extra: [{ col: extra, before: "nope" }] })).at(-1), "x");
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`songrows: ${passed} passed`);
