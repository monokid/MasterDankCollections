/** The "About this song" block. Each test is named after the way it could quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Track } from "../src/catalog.ts";
import type { EnrichMap, EnrichRecord } from "../src/enrich.ts";
import { aboutRows, releasedWords } from "../src/songabout.ts";
import { songFactsFor, spotifyHref, youtubeHref } from "../src/songcols.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const trk = (over: Partial<Track> = {}): Track => ({
  id: "t1", eventId: "e1", personId: "p1", phaseId: null, artist: "Aphex Twin", title: "Xtal", album: null, genre: null,
  songId: "aphex|xtal", twinId: null, playOrder: null, variant: null, durationSec: 290, ext: "mp3",
  sizeBytes: 1, path: [], source: "s", played: true, flags: [], provenance: {}, ...over,
});
const catOf = (tracks: Track[], nights = ["e1", "e2"]): Catalog => ({
  events: [], people: [], phases: [], artists: [], tracks,
  songs: [{ id: "aphex|xtal", artist: "Aphex Twin", title: "Xtal", variants: [], plays: tracks.length, nights,
    people: [], firstPlayed: null, lastPlayed: null }],
} as unknown as Catalog);
const rec = (over: Partial<EnrichRecord> = {}): EnrichRecord => ({
  songId: "aphex|xtal", confidence: "high", year: 2013, genres: [], family: "ambient/downtempo", country: null,
  releaseGroup: null, cover: false, ...over,
});
const infoOf = (r?: EnrichRecord, t: Partial<Track> = {}, nights?: string[]) => {
  const map: EnrichMap | null = r ? { "aphex|xtal": r } : null;
  return songFactsFor(catOf([trk(t)], nights), map, "aphex|xtal");
};
const keys = (rows: ReturnType<typeof aboutRows>) => rows.map((r) => r.key);

test("date precision wording: day, month and year each read at their own precision", () => {
  assert.equal(releasedWords("2013-03-14", "day"), "14 March 2013");
  assert.equal(releasedWords("2013-03", "month"), "March 2013");
  assert.equal(releasedWords("2013", "year"), "2013");
});
test("a month-precision date never invents a day, and a year never invents a month", () => {
  assert.equal(releasedWords("2013-03", "day"), "2013");
  assert.equal(releasedWords("2013", "month"), "2013");
});
test("month names come from the string, not Date(): first and last days of a month and year do not shift", () => {
  assert.equal(releasedWords("2013-01-01", "day"), "1 January 2013");
  assert.equal(releasedWords("2013-12-31", "day"), "31 December 2013");
  assert.equal(releasedWords("2013-03-01", "day"), "1 March 2013");
  const tz = process.env.TZ;
  for (const z of ["America/Los_Angeles", "Pacific/Auckland"]) {
    process.env.TZ = z;
    assert.equal(releasedWords("2013-01-01", "day"), "1 January 2013", z);
  }
  if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
});
test("garbage or impossible dates fall back to the year or to nothing, never 'Invalid Date'", () => {
  assert.equal(releasedWords("2013-13-40", "day"), "2013");
  assert.equal(releasedWords("2013-00", "month"), "2013");
  assert.equal(releasedWords("March 2013", "month"), null);
  assert.equal(releasedWords(null, null), null);
  assert.equal(releasedWords("", "year"), null);
});

test("unknown rows are omitted entirely: a bare file shows only what it knows, no dashes", () => {
  const info = songFactsFor(catOf([]), null, trk({ songId: null, twinId: null, artist: null, durationSec: 0 }));
  const rows = aboutRows(info);
  assert.deepEqual(keys(rows), ["title"]);
  for (const r of rows) assert.ok(!/^[—–-]$/.test(r.text));
});
test("a full record shows every row in the fixed order", () => {
  const info = infoOf(rec({ releaseDate: "2013-03-14", album: "Syro", genres: ["IDM", "Electronic"] }));
  const rows = aboutRows(info, "United Kingdom");
  assert.deepEqual(keys(rows), ["title", "artist", "album", "length", "released", "genre", "country", "nights"]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.released.text, "14 March 2013");
  assert.equal(by.length.text, "4:50");
  assert.equal(by.nights.label, "Brought on");
  assert.equal(by.nights.text, "2 nights");
  assert.deepEqual(by.genre.chips, ["IDM", "Electronic"]);
});
test("one night reads '1 night' and a shelf-only song has no nights row", () => {
  assert.equal(aboutRows(infoOf(rec(), {}, ["e1"])).find((r) => r.key === "nights")?.text, "1 night");
  assert.ok(!keys(aboutRows(infoOf(rec(), {}, []))).includes("nights"));
});
test("album precedence: the match's album beats the file tag; the tag is used otherwise; neither omits the row", () => {
  assert.equal(aboutRows(infoOf(rec({ album: "Syro" }), { album: "Tag Album" })).find((r) => r.key === "album")?.text, "Syro");
  assert.equal(aboutRows(infoOf(rec(), { album: "Tag Album" })).find((r) => r.key === "album")?.text, "Tag Album");
  assert.equal(aboutRows(infoOf(undefined, { album: "Tag Album" })).find((r) => r.key === "album")?.text, "Tag Album");
  assert.ok(!keys(aboutRows(infoOf(rec(), { album: null }))).includes("album"));
});
test("a night label in the album tag is not an album", () => {
  assert.ok(!keys(aboutRows(infoOf(undefined, { album: "Roll" }))).includes("album"));
});
test("release with only a year (no releaseDate yet) still shows a Released row", () => {
  assert.equal(aboutRows(infoOf(rec())).find((r) => r.key === "released")?.text, "2013");
});
test("a suspect year hides the Released row instead of printing a wrong one", () => {
  assert.ok(!keys(aboutRows(infoOf(rec({ yearSuspect: true, releaseDate: "2013-03-14" })))).includes("released"));
});
test("genre chips do not repeat the family name, and a genre-only song keeps its chips", () => {
  const same = aboutRows(infoOf(rec({ family: "metal", genres: ["Metal", "Doom"] })));
  assert.deepEqual(same.find((r) => r.key === "genre")?.chips, ["Doom"]);
  const tagsOnly = aboutRows(infoOf(undefined, { genre: "Shoegaze" })).find((r) => r.key === "genre");
  assert.equal(tagsOnly?.text, "");
  assert.deepEqual(tagsOnly?.chips, ["Shoegaze"]);
});
test("no country means no Country row", () => {
  assert.ok(!keys(aboutRows(infoOf(rec()), null)).includes("country"));
  assert.ok(!keys(aboutRows(infoOf(rec()), "  ")).includes("country"));
});

test("links for a song with no artist search by title alone, with no stray space or 'null'", () => {
  const src = { artist: null, title: "Xtal", spotifyUri: null };
  assert.equal(spotifyHref(src).href, "https://open.spotify.com/search/Xtal");
  assert.equal(youtubeHref(src).href, "https://www.youtube.com/results?search_query=Xtal");
  assert.ok(!spotifyHref(src).exact);
});
test("an exact Spotify track URI gives the track page; a malformed one falls back to search", () => {
  assert.deepEqual(spotifyHref({ artist: "A", title: "B", spotifyUri: "spotify:track:abc123" }),
    { href: "https://open.spotify.com/track/abc123", exact: true });
  assert.equal(spotifyHref({ artist: "A", title: "B", spotifyUri: "spotify:album:abc" }).exact, false);
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`songabout: ${passed} passed`);
