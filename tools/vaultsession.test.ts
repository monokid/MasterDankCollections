/** The browser-side vault session (src/vault.ts) against the real crypto, with
 *  fake network and storage. Throwaway passwords only. */
import assert from "node:assert/strict";
import { sealBundle } from "../src/vaultcrypto.ts";
import { createVault, parseBundle, VaultError } from "../src/vault.ts";

const PW = "throwaway-session";
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const cat = { tracks: [], events: [], people: [], songs: [], artists: [], phases: [] };
const good = await sealBundle(enc({ catalog: cat, weather: { "2020-01-01": 1 } }), [PW]);
const enriched = await sealBundle(enc({ catalog: cat, enrich: { schema: 1, songs: { "a|b": { year: 1999 } } } }), [PW]);
const other = await sealBundle(enc({ catalog: cat }), ["throwaway-other"]);
const hollow = await sealBundle(enc({ nothing: true }), [PW]);

class Mem implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
function make(bytes: () => Promise<Uint8Array>, mem = new Mem()) {
  let fetches = 0;
  const slept: number[] = [];
  const v = createVault({
    fetchBytes: () => { fetches++; return bytes(); },
    storage: () => mem as unknown as Storage,
    sleep: async (ms) => { slept.push(ms); },
  });
  return { v, mem, slept, fetches: () => fetches };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n${(e as Error).stack}`); process.exit(1); }
}

await test("wrong word resolves false, right word opens and holds the session", async () => {
  const { v, mem } = make(async () => good);
  assert.equal(await v.unlock("nope"), false);
  assert.equal(v.getBundle(), null);
  assert.equal(await v.unlock(PW), true);
  assert.deepEqual(v.getBundle()!.weather, { "2020-01-01": 1 });
  assert.ok(mem.getItem("mdc.vk"));
  assert.ok(v.hasSession());
});

await test("the bundle exposes enrich when sealed in, and null when absent", async () => {
  const withIt = make(async () => enriched);
  await withIt.v.unlock(PW);
  assert.deepEqual(withIt.v.getBundle()!.enrich, { songs: { "a|b": { year: 1999 } } });
  const without = make(async () => good);
  await without.v.unlock(PW);
  assert.equal(without.v.getBundle()!.enrich, null);
});

await test("two quick submits are queued: both settle, the right one wins, ciphertext fetched once", async () => {
  const { v, fetches } = make(async () => good);
  const [a, b] = await Promise.all([v.unlock("wrong"), v.unlock(PW)]);
  assert.deepEqual([a, b], [false, true]);
  assert.equal(fetches(), 1);
});

await test("after three misses the next attempt is slowed, and a hit resets it", async () => {
  const { v, slept } = make(async () => good);
  for (let i = 0; i < 3; i++) await v.unlock("x");
  assert.deepEqual(slept, []);
  await v.unlock(PW);
  assert.deepEqual(slept, [1000]);
  await v.unlock(PW);
  assert.deepEqual(slept, [1000]);
});

await test("a failed download is typed, not cached, and retried", async () => {
  let n = 0;
  const { v } = make(async () => {
    if (++n === 1) throw new VaultError("network", "down");
    return good;
  });
  await assert.rejects(v.unlock(PW), (e: unknown) => e instanceof VaultError && e.code === "network");
  assert.equal(await v.unlock(PW), true);
});

await test("a damaged vault file is a 'corrupt' VaultError", async () => {
  const bad = good.slice(); bad[bad.length - 40] ^= 1;
  await assert.rejects(make(async () => bad).v.unlock(PW), (e: unknown) => e instanceof VaultError && e.code === "corrupt");
  await assert.rejects(make(async () => new Uint8Array(20)).v.unlock(PW), (e: unknown) => e instanceof VaultError && e.code === "corrupt");
});

await test("a vault that opens but has no catalogue is an 'empty' VaultError", async () => {
  await assert.rejects(make(async () => hollow).v.unlock(PW), (e: unknown) => e instanceof VaultError && e.code === "empty");
  assert.throws(() => parseBundle(enc({ catalog: { tracks: [] } })), (e: unknown) => (e as VaultError).code === "empty");
  assert.throws(() => parseBundle(new TextEncoder().encode("not json")), (e: unknown) => (e as VaultError).code === "corrupt");
});

await test("resume reopens from the held key, sharing one download between callers", async () => {
  const first = make(async () => good);
  await first.v.unlock(PW);
  const second = make(async () => good, first.mem);
  const [a, b] = await Promise.all([second.v.resume(), second.v.resume()]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(second.fetches(), 1);
  assert.ok(second.v.getBundle());
});

await test("resume with a stale key (vault re-sealed) forgets the key", async () => {
  const first = make(async () => good);
  await first.v.unlock(PW);
  const stale = make(async () => other, first.mem);
  assert.equal(await stale.v.resume(), false);
  assert.equal(first.mem.getItem("mdc.vk"), null);
});

await test("resume while offline keeps the key for the next try", async () => {
  const first = make(async () => good);
  await first.v.unlock(PW);
  const offline = make(async () => { throw new VaultError("network", "down"); }, first.mem);
  assert.equal(await offline.v.resume(), false);
  assert.ok(first.mem.getItem("mdc.vk"));
  assert.equal(await make(async () => good, first.mem).v.resume(), true);
});

await test("blocked storage never breaks an unlock", async () => {
  const v = createVault({ fetchBytes: async () => good, storage: () => { throw new Error("denied"); } });
  assert.equal(v.hasSession(), false);
  assert.equal(await v.unlock(PW), true);
  assert.equal(await v.resume(), true);
});

await test("a garbage key in storage is dropped, not thrown", async () => {
  const mem = new Mem(); mem.setItem("mdc.vk", "!!!not-base64!!!");
  assert.equal(await make(async () => good, mem).v.resume(), false);
  assert.equal(mem.getItem("mdc.vk"), null);
});

console.log(`vaultsession: ${passed} passed`);
