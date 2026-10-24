/** The numbers behind "the sound of this night". */
import assert from "node:assert/strict";
import { coverageLine, factLines, pickCovers, soundOf, worthShowing } from "../src/nightsound.ts";
import type { Track } from "../src/catalog.ts";
import type { EnrichMap, EnrichRecord } from "../src/enrich.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

let n = 0;
const tr = (songId: string | null, over: Partial<Track> = {}) =>
  ({ id: `t${n++}`, songId, title: `Song ${songId}`, artist: `Artist ${songId}`, played: true, ...over }) as Track;
const rec = (songId: string, over: Partial<EnrichRecord> = {}): EnrichRecord =>
  ({ songId, confidence: "high", year: 2000, genres: [], family: "rock", country: null, releaseGroup: null, cover: false, ...over });
const map = (...rs: EnrichRecord[]): EnrichMap => Object.fromEntries(rs.map((r) => [r.songId, r]));

test("a named list, its anonymised twin and a repeated song count once", () => {
  const tracks = [tr("a"), tr("a", { played: false }), tr("a", { played: false, flags: ["anon"] }), tr("b")];
  const s = soundOf(tracks, map(rec("a"), rec("b")));
  assert.equal(s.songs, 2);
  assert.equal(s.known, 2);
  assert.equal(s.families[0].count, 2);
});

test("the same song played twice in a night is one song", () => {
  const s = soundOf([tr("a"), tr("a")], map(rec("a", { year: 1999 })));
  assert.equal(s.songs, 1);
  assert.equal(s.yearKnown, 1);
});

test("partial coverage: the denominator is every song, the mix only the known ones", () => {
  const tracks = [tr("a"), tr("b"), tr("c"), tr("d")];
  const s = soundOf(tracks, map(rec("a"), rec("b", { confidence: "none", family: "metal" })));
  assert.equal(s.songs, 4);
  assert.equal(s.known, 1, "a no-match record is not known");
  assert.deepEqual(s.families, [{ family: "rock", count: 1 }], "a no-match record's family is not read");
  assert.equal(coverageLine(s), "known for 1 of 4 songs");
  assert.ok(!worthShowing(s), "25% is under the line");
});

test("tracks without a songId are left out of the songs and named in the line", () => {
  const s = soundOf([tr("a"), tr(null), tr(null)], map(rec("a")));
  assert.equal(s.songs, 1);
  assert.equal(s.noSong, 2);
  assert.match(coverageLine(s), /known for 1 of 1 songs · 2 more tracks have no song match/);
});

test("a suspect year is ignored but the song is still known and keeps its family", () => {
  const s = soundOf([tr("a"), tr("b")], map(rec("a", { year: 2024, yearSuspect: true }), rec("b", { year: 1990 })));
  assert.equal(s.known, 2);
  assert.equal(s.yearKnown, 1);
  assert.equal(s.median, 1990);
  assert.equal(s.newest!.songId, "b");
  assert.equal(s.familyKnown, 2);
});

test("a night with no known songs gives empty, honest output", () => {
  const s = soundOf([tr("a"), tr("b")], map());
  assert.equal(s.known, 0);
  assert.equal(s.median, null);
  assert.deepEqual(s.decades, []);
  assert.deepEqual(factLines(s), []);
  assert.ok(!worthShowing(s));
  const none = soundOf([tr("a")], null);
  assert.equal(none.known, 0, "no enrichment at all is not a crash");
  assert.ok(!worthShowing(soundOf([], map())), "an empty night has no coverage");
});

test("a one-song night: median is that year, no oldest/newest pair", () => {
  const s = soundOf([tr("a")], map(rec("a", { year: 2008 })));
  assert.equal(s.median, 2008);
  assert.equal(s.oldest!.songId, s.newest!.songId);
  const f = factLines(s);
  assert.equal(f.length, 1);
  assert.match(f[0], /2008/);
});

test("median of an even count is the lower middle year, so 'half is this or earlier' holds", () => {
  const s = soundOf([tr("a"), tr("b"), tr("c"), tr("d")],
    map(rec("a", { year: 1990 }), rec("b", { year: 2000 }), rec("c", { year: 2010 }), rec("d", { year: 2020 })));
  assert.equal(s.median, 2000);
  const odd = soundOf([tr("a"), tr("b"), tr("c")], map(rec("a", { year: 1990 }), rec("b", { year: 2000 }), rec("c", { year: 2010 })));
  assert.equal(odd.median, 2000);
});

test("decades run unbroken from earliest to latest, gaps as zero", () => {
  const s = soundOf([tr("a"), tr("b"), tr("c")], map(rec("a", { year: 1985 }), rec("b", { year: 1989 }), rec("c", { year: 2012 })));
  assert.deepEqual(s.decades, [
    { decade: "1980s", count: 2 }, { decade: "1990s", count: 0 }, { decade: "2000s", count: 0 }, { decade: "2010s", count: 1 },
  ]);
});

test("oldest and newest are the extremes, and equal years do not invent a range", () => {
  const s = soundOf([tr("a"), tr("b"), tr("c")], map(rec("a", { year: 2005 }), rec("b", { year: 1971 }), rec("c", { year: 2019 })));
  assert.equal(s.oldest!.title, "Song b");
  assert.equal(s.newest!.title, "Song c");
  const same = soundOf([tr("a"), tr("b")], map(rec("a", { year: 2005 }), rec("b", { year: 2005 })));
  assert.ok(factLines(same).some((l) => /Every song with a known year is from 2005/.test(l)));
});

test("families are most-common first and add up to the songs with a family", () => {
  const s = soundOf([tr("a"), tr("b"), tr("c"), tr("d")], map(
    rec("a", { family: "metal" }), rec("b", { family: "pop" }), rec("c", { family: "pop" }), rec("d", { family: null })));
  assert.deepEqual(s.families.map((f) => f.family), ["pop", "metal"]);
  assert.equal(s.familyKnown, 3);
  assert.equal(s.known, 4);
});

test("the mosaic spreads over artists, is deterministic, and skips songs without a cover", () => {
  const cov = (id: string, artist: string | null) => ({ songId: id, title: id, artist, url: "u", track: tr(id) });
  const all = [cov("1", "X"), cov("2", "X"), cov("3", "X"), cov("4", "Y"), cov("5", "Z"), cov("6", null), cov("7", null)];
  const a = pickCovers(all, 5);
  assert.deepEqual(a.map((c) => c.songId), pickCovers([...all].reverse(), 5).map((c) => c.songId));
  assert.equal(new Set(a.map((c) => c.artist)).size >= 4 || a.filter((c) => c.artist === "X").length === 1, true);
  assert.equal(a.filter((c) => c.artist === "X").length, 1, "one X before any second X");
  const s = soundOf([tr("a"), tr("b")], map(rec("a", { cover: true, coverUrl: "http://c/a.jpg" }), rec("b")));
  assert.deepEqual(s.covers.map((c) => c.songId), ["a"]);
  const many = Array.from({ length: 30 }, (_, i) => cov(`s${i}`, `A${i}`));
  assert.equal(pickCovers(many).length, 12);
});

console.log(`nightsound: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
