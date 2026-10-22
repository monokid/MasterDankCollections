/** Vault tests. Throwaway passwords only: the real ones never appear here. */
import assert from "node:assert/strict";
import { sealBundle, openBundle, openBundleWithKey, openWithDataKey, exportDataKey, importDataKey } from "../src/vaultcrypto.ts";
import { sealInputs, openInputs } from "./inputs.ts";
import { passwordsFromEnv, teaserOf } from "./seal.ts";
import { violations } from "./guard.ts";
import type { Catalog } from "../src/catalog.ts";

const A = "throwaway-alpha", B = "throwaway-bravo";
const MARKER = "ZXQ-UNIQUE-PLAINTEXT-MARKER-7731";
const payload = new TextEncoder().encode(JSON.stringify({ catalog: { note: MARKER, pad: "x".repeat(2000) } }));
const text = (u: Uint8Array) => new TextDecoder().decode(u);

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n${(e as Error).stack}`); process.exit(1); }
}
const rejects = async (p: Promise<unknown>) => { await assert.rejects(p); };

const t0 = Date.now();
const sealed = await sealBundle(payload, [A, B]);
console.log(`sealed in ${Date.now() - t0} ms`);
const idx = (hay: Uint8Array, needle: string) => Buffer.from(hay).indexOf(needle);

await test("roundtrip with each of two passwords", async () => {
  assert.equal(text((await openBundle(sealed, A))!), text(payload));
  assert.equal(text((await openBundle(sealed, B))!), text(payload));
});
await test("surrounding whitespace on a password is ignored, nothing else is", async () => {
  assert.ok(await openBundle(sealed, `  ${A}\n`));
  assert.equal(await openBundle(sealed, A.toUpperCase()), null);
});
await test("wrong password returns null, never throws", async () => {
  assert.equal(await openBundle(sealed, "nope"), null);
  assert.equal(await openBundle(sealed, ""), null);
  assert.equal(await openBundle(sealed, A + B), null);
});
await test("sealed bytes do not contain the plaintext marker or either password", () => {
  assert.equal(idx(sealed, MARKER), -1);
  assert.equal(idx(sealed, A), -1);
  assert.equal(idx(sealed, B), -1);
});
await test("flipped ciphertext byte fails authentication", async () => {
  const bad = sealed.slice();
  bad[bad.length - 40] ^= 1;
  await rejects(openBundle(bad, A));
  await rejects(openBundle(bad, B));
});
await test("flipped slot byte fails: that slot cannot unwrap and the header is authenticated", async () => {
  const header = JSON.parse(Buffer.from(sealed.slice(8, 8 + new DataView(sealed.buffer).getUint32(4))).toString());
  const wk: string = header.slots[0].wrappedKey;
  const at = idx(sealed, wk) + 4;
  const bad = sealed.slice();
  bad[at] = bad[at] === 0x41 ? 0x42 : 0x41; // swap one base64 char
  assert.notEqual(bad[at], sealed[at]);
  assert.equal(await openBundle(bad, A).catch(() => null), null);
  // slot 1 still unwraps, but the edited header no longer authenticates the data
  await rejects(openBundle(bad, B));
});
await test("slots are independent: distinct salts and wrapped keys; one password never opens the other's vault", async () => {
  const header = JSON.parse(Buffer.from(sealed.slice(8, 8 + new DataView(sealed.buffer).getUint32(4))).toString());
  assert.equal(header.slots.length, 2);
  assert.notEqual(header.slots[0].salt, header.slots[1].salt);
  assert.notEqual(header.slots[0].wrappedKey, header.slots[1].wrappedKey);
  const onlyA = await sealBundle(payload, [A]);
  assert.ok(await openBundle(onlyA, A));
  assert.equal(await openBundle(onlyA, B), null);
});
await test("session resume: the exported data key reopens the vault, a wrong key does not", async () => {
  const opened = (await openBundleWithKey(sealed, A))!;
  const saved = exportDataKey(opened.key);
  assert.equal(text(await openWithDataKey(sealed, importDataKey(saved))), text(payload));
  await rejects(openWithDataKey(sealed, new Uint8Array(32)));
});
await test("sealing needs a password", async () => { await rejects(sealBundle(payload, ["  ", ""])); });

await test("inputs seal/open roundtrip; wrong key and tampering fail", async () => {
  const key = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const other = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const files = { "mdc-crawl-x.json": `{"a":"${MARKER}"}`, "weather.json": "{}" };
  const enc = await sealInputs(files, key);
  assert.equal(idx(enc, MARKER), -1);
  assert.deepEqual(await openInputs(enc, key), files);
  await rejects(openInputs(enc, other));
  const bad = enc.slice(); bad[bad.length - 5] ^= 1;
  await rejects(openInputs(bad, key));
  await rejects(sealInputs(files, undefined));
});

await test("seal fails loudly without passwords", () => {
  assert.throws(() => passwordsFromEnv(""), /MDC_PASSWORDS/);
  assert.throws(() => passwordsFromEnv(" , "), /MDC_PASSWORDS/);
  assert.deepEqual(passwordsFromEnv(" a , b "), ["a", "b"]);
});

await test("guard flags tracked plaintext and env files", () => {
  assert.deepEqual(violations(["data/inputs.enc", "src/App.tsx", "tools/rules.json"]), []);
  assert.deepEqual(violations(["data/mdc-spotify.json", "public/data/catalog.json", ".env.local", "public/data/teaser.json"]).length, 4);
});

await test("teaser holds aggregates only: no names, no dates", () => {
  const ev = (id: string, date: string) => ({ id, kind: "event", date, playedCount: 2, durationSec: 7200, people: [] });
  const cat = {
    events: [ev("2018-01-01", "2018-01-01"), ev("2020-05-05", "2020-05-05")],
    songs: [{}, {}, {}], artists: [{}, {}],
    tracks: [
      { played: true, personId: "dov" }, { played: true, personId: "dov" }, { played: true, personId: "dov" },
      { played: true, personId: "ann" }, { played: false, personId: "ann" }, { played: true, personId: null },
    ],
  } as unknown as Catalog;
  const t = teaserOf(cat);
  assert.deepEqual([t.nights, t.tracks, t.songs, t.artists, t.contributors, t.hours, t.yearFrom, t.yearTo], [2, 4, 3, 2, 2, 4, 2018, 2020]);
  assert.deepEqual(t.weights, [0.75, 0.25]);
  const json = JSON.stringify(t);
  assert.ok(!/dov|ann|2018-01|2020-05/.test(json));
});

console.log(`vault: ${passed} tests passed`);
