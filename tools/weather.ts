/** Fetches the weather for each night in the catalogue and writes
 *  data/weather.json (sealed into data/inputs.enc, not committed in the clear; `npm run seal` puts it in the vault).
 *
 *  Assumption: every night happened in the Limburg area, so the weather is for
 *  Hasselt, Belgium (50.93 N 5.34 E). The source is Open-Meteo's free historical
 *  archive (no key). The "evening" is the 21:00 Europe/Brussels hour.
 *
 *  Idempotent: dates already in the file are not asked for again (--refresh to
 *  redo them). Polite: one request per year that has nights, a second apart.
 *
 *    npm run distill   (to know the dates)
 *    npm run weather
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog } from "../src/catalog.ts";
import type { DayWeather, WeatherMap } from "../src/weather.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://archive-api.open-meteo.com/v1/archive";
const LAT = 50.93, LON = 5.34, TZ = "Europe/Brussels", EVENING = "21:00";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Reply {
  daily: {
    time: string[]; weather_code: (number | null)[]; temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[]; precipitation_sum: (number | null)[];
    wind_speed_10m_max: (number | null)[];
  };
  hourly: { time: string[]; temperature_2m: (number | null)[]; weather_code: (number | null)[] };
}

async function fetchRange(start: string, end: string): Promise<Reply> {
  const q = new URLSearchParams({
    latitude: String(LAT), longitude: String(LON), start_date: start, end_date: end,
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
    hourly: "temperature_2m,weather_code", timezone: TZ,
  });
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${API}?${q}`);
    if (r.ok) return await r.json() as Reply;
    if (attempt >= 4 || (r.status !== 429 && r.status < 500)) {
      throw new Error(`Open-Meteo ${r.status} for ${start}..${end}: ${(await r.text()).slice(0, 200)}`);
    }
    await sleep(5000 * attempt);
  }
}

const num = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? null : Math.round(v * 10 ** digits) / 10 ** digits;

async function main() {
  const catPath = join(ROOT, "public", "data", "catalog.json");
  if (!existsSync(catPath)) throw new Error("no catalogue yet; run `npm run distill` first");
  const cat = JSON.parse(readFileSync(catPath, "utf8")) as Catalog;
  const dates = cat.events.filter((e) => e.kind !== "collection" && e.date).map((e) => e.date!).sort();

  const outPath = join(ROOT, "data", "weather.json");
  const have: WeatherMap = existsSync(outPath) && !process.argv.includes("--refresh")
    ? JSON.parse(readFileSync(outPath, "utf8")) : {};
  const missing = dates.filter((d) => !have[d]);
  console.log(`${dates.length} nights, ${dates.length - missing.length} already cached, ${missing.length} to fetch`);

  const byYear = new Map<string, string[]>();
  for (const d of missing) {
    const y = d.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(d);
  }

  const out: WeatherMap = { ...have };
  let first = true;
  for (const [year, list] of byYear) {
    if (!first) await sleep(1000);
    first = false;
    const reply = await fetchRange(list[0], list[list.length - 1]);
    for (const d of list) {
      const i = reply.daily.time.indexOf(d);
      if (i < 0 || reply.daily.weather_code[i] === null) {
        console.warn(`  ${d}: no data returned, skipped`);
        continue;
      }
      const h = reply.hourly.time.indexOf(`${d}T${EVENING}`);
      const day: DayWeather = {
        code: reply.daily.weather_code[i]!,
        tmax: num(reply.daily.temperature_2m_max[i])!,
        tmin: num(reply.daily.temperature_2m_min[i])!,
        precip: num(reply.daily.precipitation_sum[i]) ?? 0,
        wind: num(reply.daily.wind_speed_10m_max[i]) ?? 0,
        eveningTemp: h < 0 ? null : num(reply.hourly.temperature_2m[h]),
        eveningCode: h < 0 ? null : reply.hourly.weather_code[h],
      };
      out[d] = day;
    }
    console.log(`  ${year}: ${list.length} night${list.length === 1 ? "" : "s"}`);
  }

  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(outPath, JSON.stringify(sorted, null, 1) + "\n");
  console.log(`wrote    data/weather.json (${Object.keys(sorted).length} nights)`);
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
