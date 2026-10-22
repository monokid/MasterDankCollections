/** `npm run seal`: encrypt the plaintext catalogue (+ weather, + enrichment) into
 *  public/data/vault.bin, and write the aggregate-only public/data/teaser.json.
 *
 *  Passwords come from MDC_PASSWORDS (comma-separated). Locally `npm run data`
 *  loads them from the gitignored .env.local; in CI they are a repository secret. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog } from "../src/catalog.ts";
import { visibleCatalog } from "../src/config.ts";
import { sealBundle } from "../src/vaultcrypto.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Teaser {
  nights: number; tracks: number; songs: number; artists: number; contributors: number;
  hours: number; yearFrom: number | null; yearTo: number | null;
  /** Each contributor's share of played tracks; sums to 1, descending. No names. */
  weights: number[];
}

/** Aggregates only: nothing here names a person, a song or a date. */
export function teaserOf(full: Catalog): Teaser {
  const cat = visibleCatalog(full);
  const nights = cat.events.filter((e) => e.kind === "event");
  const years = nights.map((e) => Number(e.date?.slice(0, 4))).filter((y) => y > 0);
  const per = new Map<string, number>();
  for (const t of cat.tracks) {
    if (t.played && t.personId) per.set(t.personId, (per.get(t.personId) ?? 0) + 1);
  }
  const total = [...per.values()].reduce((a, b) => a + b, 0);
  const weights = [...per.values()].sort((a, b) => b - a)
    .map((n) => Math.round((n / total) * 1e4) / 1e4);
  return {
    nights: nights.length,
    tracks: cat.events.reduce((a, e) => a + e.playedCount, 0),
    songs: cat.songs.length,
    artists: cat.artists.length,
    contributors: weights.length,
    hours: Math.round(cat.events.reduce((a, e) => a + e.durationSec, 0) / 3600),
    yearFrom: years.length ? Math.min(...years) : null,
    yearTo: years.length ? Math.max(...years) : null,
    weights,
  };
}

export function passwordsFromEnv(env = process.env.MDC_PASSWORDS): string[] {
  const pws = (env ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (pws.length < 1) {
    throw new Error("MDC_PASSWORDS is missing or empty. Set it (comma-separated) in .env.local, or as a GitHub Actions secret.");
  }
  return pws;
}

async function main() {
  const passwords = passwordsFromEnv();
  const read = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  const catPath = "public/data/catalog.json";
  if (!existsSync(join(ROOT, catPath))) throw new Error(`${catPath} is missing: run npm run distill first`);
  const catalog = read(catPath) as Catalog;
  const weather = existsSync(join(ROOT, "data/weather.json")) ? read("data/weather.json") : {};
  const payload: Record<string, unknown> = { catalog, weather };
  if (existsSync(join(ROOT, "data/enrich.json"))) payload.enrich = read("data/enrich.json");

  mkdirSync(join(ROOT, "public/data"), { recursive: true });
  const t0 = Date.now();
  const sealed = await sealBundle(new TextEncoder().encode(JSON.stringify(payload)), passwords);
  writeFileSync(join(ROOT, "public/data/vault.bin"), sealed);
  const teaser = teaserOf(catalog);
  writeFileSync(join(ROOT, "public/data/teaser.json"), JSON.stringify(teaser));
  console.log(`sealed   public/data/vault.bin  ${(sealed.length / 1e6).toFixed(2)} MB  ${passwords.length} password slot(s)  ${Date.now() - t0} ms`);
  console.log("wrote    public/data/teaser.json  (aggregates only)");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(`seal: ${e.message ?? e}`); process.exit(1); });
