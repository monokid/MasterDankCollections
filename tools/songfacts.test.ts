/** The facts a song page adds from the public databases. Each test is named
 *  after the way the number could quietly go wrong. */
import assert from "node:assert/strict";
import type { EnrichRecord } from "../src/enrich.ts";
import {
  countryName, coverSourceOf, gapSentence, moreFromArtist, neighbours, notFoundLine, poolOf, songFacts,
  sourceNote, type PoolSong,
} from "../src/songfacts.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const rec = (over: Partial<EnrichRecord> = {}): EnrichRecord => ({
  songId: "a|b", confidence: "high", year: 1994, genres: [], family: "rock", country: "JP",
  releaseGroup: "rg1", cover: true, ...over,
});
const song = (id: string, nights: number, year: number | null, family: string | null, over: Partial<PoolSong> = {}): PoolSong =>
  ({ songId: id, title: id, artist: "x", artistId: "x", nights, year, family, ...over });
const self = { songId: "me", year: 1994 as number | null, family: "rock" as string | null };

test("a gap is never negative: a song 'released' after it was first brought is a wrong match", () => {
  assert.equal(gapSentence(2020, 2016), null);
});
test("a gap is silent for an absurd release year instead of printing a century", () => {
  assert.equal(gapSentence(1066, 2016), null);
});
test("a missing year gives no gap sentence (not 'released null')", () => {
  assert.equal(gapSentence(null, 2016), null);
  assert.equal(gapSentence(2011, null), null);
});
test("the gap reads right at 0, 1 and many years", () => {
  assert.equal(gapSentence(2011, 2016), "released 2011, first brought in 2016: 5 years later");
  assert.equal(gapSentence(2015, 2016), "released 2015, first brought in 2016: 1 year later");
  assert.equal(gapSentence(2016, 2016), "released 2016, first brought the same year");
});
test("a suspect year is not shown as a fact", () => {
  assert.equal(songFacts(rec({ yearSuspect: true })).year, null);
});
test("an unmatched record yields no facts at all, even if it carries stray fields", () => {
  const f = songFacts(rec({ confidence: "none" }));
  assert.deepEqual([f.year, f.family, f.country], [null, null, null]);
});
test("a country code becomes a name, and an unnameable code is dropped, not shown raw", () => {
  assert.equal(countryName("JP"), "Japan");
  assert.equal(countryName("jp"), "Japan");
  assert.equal(countryName("ZZ"), null);
  assert.equal(countryName(null), null);
  assert.equal(countryName("Scotland"), "Scotland");
});

test("the song itself is excluded from its own neighbours", () => {
  const n = neighbours(self, [song("me", 1, 1994, "rock"), song("a", 2, 1994, "rock"), song("b", 2, 1990, "rock"), song("c", 3, 1991, "rock")]);
  assert.ok(n && !n.songs.some((s) => s.songId === "me"));
  assert.equal(n.basis, "family+decade");
});
test("songs without a page (loose) are never offered", () => {
  const n = neighbours(self, [song("a", 1, 1994, "rock", { loose: true }), song("b", 1, 1994, "rock")], 8, 1);
  assert.deepEqual(n!.songs.map((s) => s.songId), ["b"]);
});
test("a thin family+decade widens to the family, and says so", () => {
  const pool = [song("a", 1, 1994, "rock"), song("b", 1, 1975, "rock"), song("c", 1, 2005, "rock"), song("d", 1, 1996, "pop")];
  const n = neighbours(self, pool)!;
  assert.equal(n.basis, "family");
  assert.deepEqual(n.songs.map((s) => s.songId).sort(), ["a", "b", "c"]);
  assert.match(n.label, /any decade/);
});
test("no same-family songs falls back to the decade", () => {
  const n = neighbours(self, [song("a", 1, 1991, "pop"), song("b", 1, 1992, "pop"), song("c", 1, 1999, null), song("z", 1, 1970, "pop")])!;
  assert.equal(n.basis, "decade");
  assert.equal(n.songs.length, 3);
});
test("a family with a single song (the song itself) has no neighbours, not an empty panel", () => {
  assert.equal(neighbours(self, [song("me", 1, 1994, "rock")]), null);
});
test("empty pool and unknown song give null", () => {
  assert.equal(neighbours(self, []), null);
  assert.equal(neighbours({ songId: "me", year: null, family: null }, [song("a", 1, 1994, "rock")]), null);
});
test("one other song in the family is still shown (thin beats nothing)", () => {
  const n = neighbours(self, [song("a", 1, 1950, "rock")])!;
  assert.deepEqual(n.songs.map((s) => s.songId), ["a"]);
});
test("neighbours are fewest-nights first with a stable tie-break, whatever the input order", () => {
  const pool = [song("d", 5, 1994, "rock"), song("b", 1, 1994, "rock"), song("a", 1, 1994, "rock"), song("c", 2, 1994, "rock")];
  const want = ["a", "b", "c", "d"];
  assert.deepEqual(neighbours(self, pool)!.songs.map((s) => s.songId), want);
  assert.deepEqual(neighbours(self, [...pool].reverse())!.songs.map((s) => s.songId), want);
});
test("neighbours stop at the limit", () => {
  const pool = Array.from({ length: 20 }, (_, i) => song(`s${String(i).padStart(2, "0")}`, i, 1994, "rock"));
  assert.equal(neighbours(self, pool, 8)!.songs.length, 8);
});
test("a song with no enrichment record keeps null year/family in the pool", () => {
  const [p] = poolOf([{ songId: "q", title: "q", artist: "", artistId: null, nights: 1 }], {});
  assert.deepEqual([p.year, p.family], [null, null]);
  const [p2] = poolOf([{ songId: "q", title: "q", artist: "", artistId: null, nights: 1 }], null);
  assert.deepEqual([p2.year, p2.family], [null, null]);
});
test("more-from-artist leaves out the song itself and orders most-brought first", () => {
  const l = moreFromArtist("me", [song("me", 9, null, null), song("a", 1, null, null), song("b", 4, null, null)]);
  assert.deepEqual(l.map((s) => s.songId), ["b", "a"]);
});

test("not-found is said only when enrichment loaded and this song did not match", () => {
  assert.equal(notFoundLine(null, undefined), null);
  assert.equal(notFoundLine({}, undefined), "Not found in the public music databases");
  assert.equal(notFoundLine({}, rec({ confidence: "none" })), "Not found in the public music databases");
  assert.equal(notFoundLine({}, rec()), null);
});
test("the source note names Deezer/iTunes for a hotlinked cover, MusicBrainz+CAA otherwise", () => {
  assert.equal(coverSourceOf(rec({ coverUrl: "https://cdn-images.dzcdn.net/x.jpg" })), "Deezer");
  assert.equal(coverSourceOf(rec({ coverUrl: "https://is1-ssl.mzstatic.com/x.jpg" })), "iTunes");
  assert.equal(coverSourceOf(rec({ coverUrl: "https://example.com/x.jpg" })), null);
  assert.equal(sourceNote(rec()), "Cover art, year and genre come from MusicBrainz and the Cover Art Archive.");
  assert.equal(sourceNote(rec({ coverUrl: "https://cdn-images.dzcdn.net/x.jpg" })), "Cover art, year and genre come from Deezer.");
});
test("no source note for what is not shown: no cover means no Cover Art Archive claim", () => {
  assert.equal(sourceNote(rec({ cover: false })), "Year and genre come from MusicBrainz.");
  assert.equal(sourceNote(rec({ confidence: "none" })), null);
  assert.equal(sourceNote(null), null);
  assert.equal(sourceNote(rec({ cover: false, year: null, family: null })), null);
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`songfacts: ${passed} passed`);
