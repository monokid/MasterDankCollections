/** The night playlists' own logic. Each test is named after the way a row could go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Track } from "../src/catalog.ts";
import { nightColumns, playNumber, rowView } from "../src/nightlist.ts";
import { songFactsFor, sortRows, visibleColumns, NO_CHOICE } from "../src/songcols.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const trk = (id: string, over: Partial<Track> = {}): Track => ({
  id, eventId: "e1", personId: "p1", phaseId: null, artist: "Aphex Twin", title: "Xtal", album: null, genre: null,
  songId: "aphex|xtal", twinId: null, playOrder: null, variant: null, durationSec: 290, ext: "mp3",
  sizeBytes: 1, path: [], source: "s", played: true, flags: [], provenance: {}, ...over,
});
const catOf = (tracks: Track[]): Catalog => ({
  events: [], people: [], phases: [], artists: [], tracks,
  songs: [{ id: "aphex|xtal", artist: "Aphex Twin", title: "Xtal", variants: [], plays: 1, nights: ["e1"],
    people: [], firstPlayed: null, lastPlayed: null }],
} as unknown as Catalog);

const cols = (cat: Catalog) => nightColumns((t) => songFactsFor(cat, null, t));
const col = (cat: Catalog, id: string) => cols(cat).find((c) => c.id === id)!;

test("play order: a missing place is unknown, not 0 or NaN", () => {
  assert.equal(playNumber({ playOrder: null }), null);
  assert.equal(playNumber({ playOrder: NaN }), null);
  assert.equal(playNumber({ playOrder: 0 }), 0);
});
test("play order: sorting the order column with ties and nulls is stable and nulls stay last both ways", () => {
  const key = col(catOf([]), "order").sortKey!;
  const rows = [trk("a", { playOrder: 2 }), trk("b"), trk("c", { playOrder: 2 }), trk("d", { playOrder: 1 }), trk("e")];
  assert.deepEqual(sortRows(rows, key, "asc").map((t) => t.id), ["d", "a", "c", "b", "e"]);
  assert.deepEqual(sortRows(rows, key, "desc").map((t) => t.id), ["a", "c", "d", "b", "e"]);
});
test("columns: order first, links last, no nights column", () => {
  assert.deepEqual(cols(catOf([])).map((c) => c.id),
    ["order", "cover", "title", "artist", "album", "duration", "released", "genre", "links"]);
});
test("columns: album and genre drop below 1100px, order stays", () => {
  const c = cols(catOf([]));
  const at = (w: number) => visibleColumns(c, NO_CHOICE, w).map((x) => x.id);
  assert.ok(!at(1099).includes("album") && !at(1099).includes("genre") && at(1099).includes("order"));
  assert.ok(at(1100).includes("album") && at(1100).includes("genre"));
});
test("nameless track: title is the file name, unknown cells are null (em-dash)", () => {
  const t = trk("n", { songId: null, artist: null, title: "track 07.mp3", durationSec: null });
  const cat = catOf([t]);
  assert.equal(col(cat, "title").text(t), "track 07.mp3");
  for (const id of ["artist", "album", "duration", "released", "genre"]) assert.equal(col(cat, id).text(t), null, id);
});
test("nameless track with no title at all reads (untitled), never blank", () => {
  const t = trk("n", { songId: null, artist: null, title: null });
  assert.equal(col(catOf([t]), "title").text(t), "(untitled)");
});
test("nameless track: no links, but a Spotify-only track keeps its link", () => {
  const cat = catOf([]);
  const t = trk("n", { songId: null, artist: null, title: "track 07.mp3" });
  assert.equal(rowView(t, songFactsFor(cat, null, t)).linkable, false);
  const s = trk("s", { songId: null, artist: null, title: "x", spotifyUri: "spotify:track:abc123" });
  const v = rowView(s, songFactsFor(cat, null, s));
  assert.equal(v.linkable, true);
  assert.equal(v.linkSource.spotifyUri, "spotify:track:abc123");
});
test("twin resolution: an anonymised copy takes its named twin's song, so it gets artist, title and links", () => {
  const named = trk("named");
  const anon = trk("anon", { songId: null, artist: null, title: null, twinId: "named", flags: ["anon"] });
  const cat = catOf([named, anon]);
  const info = songFactsFor(cat, null, anon);
  assert.equal(info.songId, "aphex|xtal");
  assert.equal(col(cat, "artist").text(anon), "Aphex Twin");
  assert.equal(rowView(anon, info, named).linkable, true);
  assert.equal(rowView(anon, info, named).twinHint, null);
});
test("twin hint: an unnamed copy whose twin has no song still says what it is", () => {
  const named = trk("named", { songId: null, title: "Loose", artist: "Someone" });
  const anon = trk("anon", { songId: null, artist: null, title: null, twinId: "named" });
  const cat = catOf([named, anon]);
  assert.equal(rowView(anon, songFactsFor(cat, null, anon), named).twinHint, "= Someone — Loose");
});
test("sorting by title puts nameless files by their file name; unknown artists stay last descending", () => {
  const a = trk("a", { title: "Beta" }), b = trk("b", { songId: null, artist: null, title: "Alpha.mp3" });
  const cat = catOf([a, b]);
  assert.deepEqual(sortRows([a, b], col(cat, "title").sortKey!, "asc").map((t) => t.id), ["b", "a"]);
  assert.deepEqual(sortRows([b, a], col(cat, "artist").sortKey!, "desc").map((t) => t.id), ["a", "b"]);
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`nightlist: ${passed} passed`);
