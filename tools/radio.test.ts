/** The cosmic radio's pool and shuffle. Each test is named after the way it could go wrong. */
import assert from "node:assert/strict";
import {
  ARTIST_MEMORY, cosmicPool, cosmicScore, createShuffler, libraryPool, listPool, MIN_POOL, tagWeight,
  type Candidate,
} from "../src/radio.ts";
import type { SongInfo } from "../src/songcols.ts";
import { createKeyMachine } from "../src/keys.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

let n = 0;
const song = (artist: string, family: string | null, genres: string[] = [], over: Partial<SongInfo> = {}): SongInfo => ({
  songId: `${artist.toLowerCase()}|s${++n}`, title: `Song ${n}`, artist, album: null, durationSec: 200, year: null,
  releaseDate: null, datePrecision: null, family, familyLabel: family, genres, nights: 1, spotifyUri: null, ...over,
});
const ids = (c: Candidate[]) => new Set(c.map((x) => x.songId));

test("families: psytrance and ambient outrank post-rock and synthwave, all are in", () => {
  const w = (f: string) => cosmicScore({ family: f, genres: [] });
  assert.ok(w("psytrance/trance") > w("post-rock/prog"));
  assert.ok(w("ambient/downtempo") > w("post-rock/prog"));
  for (const f of ["psytrance/trance", "ambient/downtempo", "synthwave", "post-rock/prog"]) assert.ok(w(f) >= MIN_POOL, f);
});
test("zero-weight families never appear in Cosmic, however they are tagged", () => {
  for (const f of ["hip hop", "punk", "country", "comedy/novelty", "hard dance/hardcore", "dubstep/bass", "j-pop/anime"]) {
    const s = song("X", f, ["psychedelic", "ambient", "trance", "space rock"]);
    assert.equal(cosmicScore(s), 0, f);
    assert.equal(cosmicScore(s, 1), 0, `${f} even with a cosmic artist`);
    assert.equal(cosmicPool([s]).length, 0, f);
  }
});
test("fast and silly tags veto a song even when another tag is cosmic", () => {
  assert.equal(cosmicScore({ family: "rock", genres: ["psychedelic rock", "punk rock"] }), 0);
  assert.equal(cosmicScore({ family: null, genres: ["trance", "hardstyle"] }), 0);
  assert.equal(cosmicScore({ family: "house/techno", genres: ["electronic", "bass house"] }), 0);
});
test("raw tags: psychedelic, goa, space, krautrock, shoegaze, trip hop, dub get in", () => {
  for (const t of ["psychedelic rock", "goa trance", "space rock", "krautrock", "shoegaze", "trip hop", "dream pop", "ambient", "downtempo", "drone", "post-rock", "kosmische", "chillout"]) {
    assert.ok(cosmicScore({ family: null, genres: [t] }) >= MIN_POOL, t);
  }
  assert.ok(tagWeight("dub") > 0);
});
test("a bare 'electronic' tag is not enough, and rock or metal with no space in it stays out", () => {
  assert.ok(cosmicScore({ family: "house/techno", genres: ["electronic"] }) < MIN_POOL);
  assert.equal(cosmicScore({ family: "rock", genres: ["hard rock", "blues rock"] }), 0);
  assert.equal(cosmicScore({ family: "metal", genres: ["progressive metal", "thrash metal"] }), 0);
});
test("classical and soundtrack: out, unless an ambient-ish tag lets them in at medium weight", () => {
  assert.equal(cosmicScore({ family: "classical", genres: ["orchestral"] }), 0);
  assert.equal(cosmicScore({ family: "vgm/soundtrack", genres: ["chiptune"] }), 0);
  const amb = cosmicScore({ family: "classical", genres: ["ambient", "modern classical"] });
  assert.ok(amb >= MIN_POOL && amb < cosmicScore({ family: "ambient/downtempo", genres: [] }));
});
test("unknown genre: out on its own, in through an artist whose other songs are cosmic", () => {
  const blank = song("Sigur Ros", null);
  assert.equal(cosmicPool([blank]).length, 0);
  const pool = cosmicPool([blank, song("Sigur Ros", "post-rock/prog"), song("Sigur Ros", null, ["post-rock"]), song("Nobody", null)]);
  assert.ok(ids(pool).has(blank.songId!));
  assert.equal(pool.length, 3);
});
test("artist rule: one cosmic neighbour is a coincidence, and a vetoed song never rides in on it", () => {
  const blank = song("Duo", null);
  assert.equal(cosmicPool([blank, song("Duo", "psytrance/trance")]).length, 1);          // only the psytrance one
  const punk = song("Trio", "punk");
  const pool = cosmicPool([punk, song("Trio", "psytrance/trance"), song("Trio", "psytrance/trance")]);
  assert.ok(!ids(pool).has(punk.songId!));
});
test("songs without an artist or title are not in any pool (they cannot be looked up)", () => {
  const s = song("", "psytrance/trance", [], { artist: null });
  assert.equal(cosmicPool([s]).length, 0);
  assert.equal(libraryPool([s]).length, 0);
});
test("empty pool: the shuffler returns null, never throws", () => {
  const sh = createShuffler([], 1);
  assert.equal(sh.next(), null);
  assert.equal(sh.size, 0);
  assert.equal(createShuffler(cosmicPool([]), 1).next(), null);
});

const many = (artists: number, per: number): Candidate[] =>
  Array.from({ length: artists * per }, (_, i) => ({ songId: `a${i % artists}|s${i}`, artistId: `a${i % artists}`, weight: 1 + (i % 5) }));

test("no artist repeats within the last 8 plays", () => {
  const sh = createShuffler(many(20, 6), 42);
  const seq: string[] = [];
  for (let i = 0; i < 60; i++) seq.push(sh.next()!.artistId);   // the tail of a lap may have only one artist left: the rule gives way there
  for (let i = 0; i < seq.length; i++) {
    for (let j = Math.max(0, i - ARTIST_MEMORY); j < i; j++) assert.notEqual(seq[i], seq[j], `play ${i} repeats ${seq[i]}`);
  }
});
test("exhausts before repeating: every song once per lap, then a new lap", () => {
  const pool = many(20, 6);
  const sh = createShuffler(pool, 7);
  const lap1 = Array.from({ length: pool.length }, () => sh.next()!.songId);
  assert.equal(new Set(lap1).size, pool.length);
  assert.equal(sh.remaining(), 0);
  const lap2 = Array.from({ length: pool.length }, () => sh.next()!.songId);
  assert.equal(new Set(lap2).size, pool.length);
});
test("a pool of one artist still plays (the artist rule gives way instead of stalling)", () => {
  const sh = createShuffler(listPool(["x|1", "x|2", "x|3"]), 3);
  assert.equal(new Set([sh.next()!.songId, sh.next()!.songId, sh.next()!.songId]).size, 3);
});
test("deterministic with a seed, different with another", () => {
  const run = (seed: number) => { const sh = createShuffler(many(12, 5), seed); return Array.from({ length: 30 }, () => sh.next()!.songId).join(); };
  assert.equal(run(5), run(5));
  assert.notEqual(run(5), run(6));
});
test("weights steer the draw: heavy songs come up earlier on average, zero weights never", () => {
  const pool: Candidate[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ songId: `h${i}|x`, artistId: `h${i}`, weight: 10 })),
    ...Array.from({ length: 30 }, (_, i) => ({ songId: `l${i}|x`, artistId: `l${i}`, weight: 1 })),
    { songId: "z|x", artistId: "z", weight: 0 },
  ];
  let heavyInFirst20 = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const sh = createShuffler(pool, seed);
    for (let i = 0; i < 20; i++) { const c = sh.next()!; assert.notEqual(c.songId, "z|x"); total++; if (c.weight === 10) heavyInFirst20++; }
  }
  assert.ok(heavyInFirst20 / total > 0.7, `heavy share ${heavyInFirst20 / total}`);
});
test("listPool: a song listed twice (a night with a repeat) is one candidate", () => {
  assert.equal(listPool(["a|1", "a|1", "b|2"]).length, 2);
});

test("the r key starts the radio, but never while typing or with a modifier held", () => {
  const k = (key: string, o: object = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, typing: false, ...o });
  const m = createKeyMachine();
  assert.deepEqual(m.feed(k("r")), { type: "radio" });
  assert.equal(m.feed(k("r", { typing: true })), null);
  assert.equal(m.feed(k("r", { ctrlKey: true })), null, "Ctrl+R is the browser's reload");
  assert.equal(m.feed(k("r", { metaKey: true })), null);
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`radio: ${passed} passed`);
