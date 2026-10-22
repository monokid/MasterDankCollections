/** Reads Exportify playlist exports into `data/mdc-spotify.json`.
 *
 *  Some contributors never brought original files -- their night exists only as
 *  a Spotify playlist, or as an anonymised list whose named twin was lost. An
 *  export names those songs. This file does the reading and nothing else: which
 *  track fills which gap is the distiller's decision, as for every other source.
 *
 *  A collaborative playlist is one export per night, and `Added By` says whose
 *  block each row belongs to. Those ids are other people's account handles, so
 *  the mapping to names lives in a local, uncommitted file and the ids never
 *  reach the output.
 *
 *  Usage: npm run spotify -- export.csv [more.csv ...] [--users tools/spotify-users.local.json]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../src/csv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string[];
  album: string | null;
  /** Running time in milliseconds, as Spotify reports it. */
  ms: number;
  year: number | null;
  /** Spotify attaches the artists' genres to the track, not one for the song. */
  genres: string[];
}
export interface SpotifyList { person: string; tracks: SpotifyTrack[] }
export interface SpotifyPlaylist { night: string; file: string; lists: SpotifyList[] }
export interface SpotifyData { schema: "mdc-spotify/1"; playlists: SpotifyPlaylist[] }

// The reader lives in src/ so the Planner page can use it too.
export { parseCsv };

const REQUIRED = ["Track URI", "Track Name", "Artist Name(s)", "Duration (ms)", "Added By"] as const;

/** The night is the date the file name starts with: "20251108-Roll (1).csv". */
export function nightOf(file: string): string | null {
  const m = basename(file).match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export interface Imported {
  playlists: SpotifyPlaylist[];
  /** Account handles with no name yet, and how many rows each holds. */
  unknownUsers: Map<string, number>;
  /** Files that could not be placed on a night, or lack the expected columns. */
  rejected: Array<{ file: string; why: string }>;
  /** Rows dropped because another file already held the same track. */
  repeats: number;
}

export function importExports(
  inputs: Array<{ file: string; text: string }>,
  users: Record<string, string>,
): Imported {
  const out: Imported = { playlists: [], unknownUsers: new Map(), rejected: [], repeats: 0 };
  const byNight = new Map<string, SpotifyPlaylist>();
  const seen = new Set<string>();

  for (const { file, text } of inputs) {
    const night = nightOf(file);
    if (!night) { out.rejected.push({ file, why: "name does not start with a date (YYYYMMDD)" }); continue; }
    const rows = parseCsv(text);
    const head = rows[0] ?? [];
    const col = (n: string) => head.indexOf(n);
    const missing = REQUIRED.filter((n) => col(n) < 0);
    if (missing.length) { out.rejected.push({ file, why: `no ${missing.join(", ")} column` }); continue; }
    const at = (r: string[], n: string) => (col(n) < 0 ? "" : r[col(n)] ?? "").trim();

    let pl = byNight.get(night);
    if (!pl) { pl = { night, file: basename(file), lists: [] }; byNight.set(night, pl); }
    else pl.file += ` + ${basename(file)}`;

    for (const r of rows.slice(1)) {
      const by = at(r, "Added By");
      const ms = Number(at(r, "Duration (ms)"));
      const name = at(r, "Track Name");
      if (!name || !Number.isFinite(ms) || ms <= 0) continue;
      const person = users[by];
      if (!person) { out.unknownUsers.set(by, (out.unknownUsers.get(by) ?? 0) + 1); continue; }
      // The same playlist exported twice must not double its tracks.
      const key = `${night}|${person}|${at(r, "Track URI")}`;
      if (seen.has(key)) { out.repeats++; continue; }
      seen.add(key);
      let list = pl.lists.find((l) => l.person === person);
      if (!list) { list = { person, tracks: [] }; pl.lists.push(list); }
      const year = parseInt(at(r, "Release Date").slice(0, 4), 10);
      list.tracks.push({
        uri: at(r, "Track URI"),
        name,
        artists: at(r, "Artist Name(s)").split(";").map((a) => a.trim()).filter(Boolean),
        album: at(r, "Album Name") || null,
        ms,
        year: Number.isFinite(year) ? year : null,
        genres: at(r, "Genres").split(",").map((g) => g.trim()).filter(Boolean),
      });
    }
  }
  out.playlists = [...byNight.values()].sort((a, b) => a.night.localeCompare(b.night));
  return out;
}

/** A re-import of a night replaces that night; other nights are kept. */
export function mergeInto(existing: SpotifyData | null, fresh: SpotifyPlaylist[]): SpotifyData {
  const nights = new Set(fresh.map((p) => p.night));
  const kept = (existing?.playlists ?? []).filter((p) => !nights.has(p.night));
  return {
    schema: "mdc-spotify/1",
    playlists: [...kept, ...fresh].sort((a, b) => a.night.localeCompare(b.night)),
  };
}

function main() {
  const args = process.argv.slice(2);
  const ui = args.indexOf("--users");
  const usersPath = ui >= 0 ? args[ui + 1] : join(ROOT, "tools", "spotify-users.local.json");
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--users");
  if (!files.length) {
    console.error("Usage: npm run spotify -- export.csv [more.csv ...]");
    process.exit(1);
  }
  if (!existsSync(usersPath)) {
    console.error(`No ${usersPath}. It maps each Spotify account handle to a first name:`);
    console.error(`  { "<Added By value>": "Ada", ... }`);
    process.exit(1);
  }
  const users = JSON.parse(readFileSync(usersPath, "utf8")) as Record<string, string>;
  const res = importExports(files.map((f) => ({ file: f, text: readFileSync(f, "utf8") })), users);

  for (const r of res.rejected) console.error(`skipped  ${basename(r.file)}: ${r.why}`);
  if (res.unknownUsers.size) {
    console.error("These account handles are not in the users file (their rows were left out):");
    for (const [u, n] of res.unknownUsers) console.error(`  ${u}  x${n}`);
    process.exit(1);
  }
  const outPath = join(ROOT, "data", "mdc-spotify.json");
  const existing = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as SpotifyData) : null;
  const data = mergeInto(existing, res.playlists);
  writeFileSync(outPath, JSON.stringify(data, null, 1));
  for (const p of res.playlists) {
    console.log(`${p.night}  ${p.lists.map((l) => `${l.person} ${l.tracks.length}`).join(", ")}`);
  }
  if (res.repeats) console.log(`${res.repeats} repeated rows ignored`);
  console.log(`wrote    data/mdc-spotify.json  (${data.playlists.length} nights)`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
