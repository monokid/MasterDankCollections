/** Prints what the Music page would show for public/data/catalog.json (plaintext,
 *  local, read-only): wall size, letter buckets, one artist, and a cross-check of
 *  every artist against songstats. Run: npx tsx tools/musicwall.ts */
import { readFileSync } from "node:fs";
import type { Catalog } from "../src/catalog.ts";
import { buildWall, LETTERS, letterCounts } from "../src/musicstats.ts";
import { artistHistory } from "../src/songstats.ts";

const cat = JSON.parse(readFileSync("public/data/catalog.json", "utf8")) as Catalog;
const t0 = performance.now();
const w = buildWall(cat);
console.log(`built in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`songs on the wall ${w.songs.length} (identified ${w.songs.filter((s) => !s.loose).length}, ` +
  `loose ${w.songs.filter((s) => s.loose).length}, no artist ${w.songs.filter((s) => !s.artist).length}); ` +
  `anonymised leftovers with no name (not songs): ${w.unnamed}; years ${w.minYear}-${w.maxYear}`);
const lc = letterCounts(w.songs);
console.log("buckets", LETTERS.map((l) => `${l}:${lc.get(l) ?? 0}`).join(" "));
console.log("first 10", w.songs.slice(0, 10).map((s) => s.title).join(" ; "));
const top = [...w.artists.values()].sort((a, b) => b.songs - a.songs)[0];
const h = artistHistory(cat, top.id);
console.log("biggest artist", top, `songstats: ${h.songCount} songs, ${h.nights} nights`);
const ev = new Map(cat.events.map((e) => [e.id, e]));
const onNight = cat.songs.filter((s) => s.nights.some((n) => ev.get(n)?.kind === "event"));
console.log(`raw catalogue: ${onNight.length} songs sit on a non-collection night; ` +
  `${onNight.filter((s) => !w.byId.has(s.id)).length} of them have no played track (unmatched Spotify list entries)`);
