/** Picking the right iTunes result. Each test is named after the way a match could go wrong. */
import assert from "node:assert/strict";
import { findPreview, forgetPreviews, pickBest, searchUrl, type ItunesResult } from "../src/previews.ts";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const hit = (artistName: string, trackName: string, secs = 300, over: Partial<ItunesResult> = {}): ItunesResult => ({
  artistName, trackName, trackTimeMillis: secs * 1000, previewUrl: `https://a/${trackName}.m4a`, collectionName: "Album", ...over,
});
const want = (artist: string | null, title: string, durationSec: number | null = 300) => ({ artist, title, durationSec });

await test("cover versions: a karaoke or tribute act with the same title is not the song", () => {
  const got = pickBest(want("Ozric Tentacles", "Ping"), [
    hit("Karaoke Heroes", "Ping (Karaoke Version)"), hit("Ozric Tentacles Tribute Band", "Ping"),
    hit("Lullaby Versions", "Ping", 300, { collectionName: "Lullaby Versions of Ozric Tentacles" }),
  ]);
  assert.equal(got, null);
});
await test("cover versions: the real artist wins over a cover that is listed first", () => {
  const real = hit("Ozric Tentacles", "Ping");
  assert.equal(pickBest(want("Ozric Tentacles", "Ping"), [hit("Someone Else", "Ping"), real]), real);
});
await test("remasters: '(2012 Remaster)' and '- Remastered 2009' are the same recording", () => {
  const r1 = hit("Deep Purple", "Smoke on the Water (2012 Remaster)", 340);
  const r2 = hit("Deep Purple", "Smoke on the Water - Remastered 2009", 340);
  assert.equal(pickBest(want("Deep Purple", "Smoke On The Water", 337), [r1]), r1);
  assert.equal(pickBest(want("Deep Purple", "Smoke On The Water", 337), [r2]), r2);
});
await test("remasters: our title carrying the tag still matches the plain release", () => {
  const r = hit("Deep Purple", "Smoke on the Water", 340);
  assert.equal(pickBest(want("Deep Purple", "Smoke On The Water (Remastered)", 337), [r]), r);
});
await test("feat. tags: theirs has a featured artist, ours does not (and the other way round)", () => {
  const r = hit("M83", "Go! (feat. Mai Lan)", 205);
  assert.equal(pickBest(want("M83", "Go!", 203), [r]), r);
  const r2 = hit("Saudade", "Shadows & Light", 259);
  assert.equal(pickBest(want("Saudade, chelsea wolfe, Chino Moreno", "Shadows & Light (feat. Chelsea Wolfe)", 259), [r2]), r2);
});
await test("feat. tags: our artist is a credited co-artist on their side", () => {
  const r = hit("Pharrell Williams & Daft Punk", "Get Lucky", 369);
  assert.equal(pickBest(want("Daft Punk", "Get Lucky", 369), [r]), r);
});
await test("artist names: 'Air' is not 'Air Supply'", () => {
  assert.equal(pickBest(want("Air", "All Out of Love", 240), [hit("Air Supply", "All Out of Love", 240)]), null);
});
await test("accents and 'The': Bjork/Bjork and The War On Drugs fold together", () => {
  const r = hit("Bjork", "It's Oh So Quiet", 219);
  assert.equal(pickBest(want("Björk", "It’s Oh So Quiet", 219), [r]), r);
  const r2 = hit("War on Drugs", "Pain", 300);
  assert.equal(pickBest(want("The War On Drugs", "Pain", 300), [r2]), r2);
});
await test("non-Latin: Japanese and Cyrillic names match themselves and nothing else", () => {
  const r = hit("岸田教団&THE明星ロケッツ", "Highschool Of The Dead", 250);
  assert.equal(pickBest(want("岸田教団&THE明星ロケッツ", "Highschool Of The Dead", 250), [r])?.trackName, "Highschool Of The Dead");
  const ru = hit("Кино", "Группа крови", 280);
  assert.equal(pickBest(want("Кино", "Группа крови", 280), [ru]), ru);
  assert.equal(pickBest(want("Кино", "Группа крови", 280), [hit("ДДТ", "Осень", 280)]), null);
});
await test("duration mismatch: the same name at twice the length is a different edit and is skipped", () => {
  assert.equal(pickBest(want("Tipper", "Sunrise", 600), [hit("Tipper", "Sunrise", 240)]), null);
  const near = hit("Tipper", "Sunrise", 620);
  assert.equal(pickBest(want("Tipper", "Sunrise", 600), [near]), near);
});
await test("duration unknown on either side: the check is skipped, not failed", () => {
  const r = hit("Tipper", "Sunrise", 240);
  assert.equal(pickBest(want("Tipper", "Sunrise", null), [r]), r);
  assert.equal(pickBest(want("Tipper", "Sunrise", 240), [{ ...r, trackTimeMillis: undefined }])?.trackName, "Sunrise");
});
await test("live and remix takes are not the studio song we hold", () => {
  assert.equal(pickBest(want("Yes", "The Prophet", 398), [hit("Yes", "The Prophet (Live)", 400)]), null);
  assert.equal(pickBest(want("Kenji Kawai", "Utai IV: Reawakening", 270), [hit("Kenji Kawai", "Utai IV: Reawakening (Steve Aoki Remix)", 270)]), null);
});
await test("a longer title that merely starts like ours is another song", () => {
  assert.equal(pickBest(want("Opeth", "Windowpane", 460), [hit("Opeth", "Windowpane Part Two Reprise Of The Reprise", 460)]), null);
});
await test("no result: an empty list, a result without a preview, and nothing close all give null", () => {
  assert.equal(pickBest(want("A", "B"), []), null);
  assert.equal(pickBest(want("Ozric Tentacles", "Ping"), [{ ...hit("Ozric Tentacles", "Ping"), previewUrl: undefined }]), null);
  assert.equal(pickBest(want("Ozric Tentacles", "Ping"), [hit("Pink Floyd", "Time")]), null);
});
await test("search url: lead artist and base title, encoded, entity=song, limit 8", () => {
  const u = searchUrl(want("Saudade, Chino Moreno", "Shadows & Light (feat. X) - 2011 Remaster"));
  assert.equal(u, "https://itunes.apple.com/search?term=Saudade%20Shadows%20%26%20Light&entity=song&limit=8");
});

const reply = (results: ItunesResult[]) => async () => ({ ok: true, json: async () => ({ results }) });
await test("cache: a found preview and a 'none' are both asked once", async () => {
  forgetPreviews();
  let calls = 0;
  const f = (r: ItunesResult[]) => async () => { calls++; return reply(r)(); };
  const w = want("Ozric Tentacles", "Ping");
  assert.equal((await findPreview(w, f([hit("Ozric Tentacles", "Ping")])))?.previewUrl, "https://a/Ping.m4a");
  assert.equal((await findPreview(w, f([])))?.trackName, "Ping");
  const none = want("Nobody", "Nothing");
  assert.equal(await findPreview(none, f([])), null);
  assert.equal(await findPreview(none, f([hit("Nobody", "Nothing")])), null);   // the negative stuck
  assert.equal(calls, 2);
});
await test("cache: a failed request is not remembered as 'no preview'", async () => {
  forgetPreviews();
  const w = want("Ozric Tentacles", "Erpsongs");
  assert.equal(await findPreview(w, async () => { throw new Error("offline"); }), null);
  assert.equal(await findPreview(w, async () => ({ ok: false, json: async () => ({}) })), null);
  assert.ok(await findPreview(w, reply([hit("Ozric Tentacles", "Erpsongs")])));
});
await test("cache: two asks at once share one request", async () => {
  forgetPreviews();
  let calls = 0;
  const f = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return reply([hit("A Band", "A Song")])(); };
  const w = want("A Band", "A Song");
  await Promise.all([findPreview(w, f), findPreview(w, f)]);
  assert.equal(calls, 1);
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`previews: ${passed} passed`);
