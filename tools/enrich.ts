/** Looks songs up and keeps what it learns in `data/enrich.json`.
 *
 *  This is a separate layer. The catalogue is built from the files and playlists
 *  and is never changed by it; the dashboards that want a year, a genre or a
 *  cover read this file and say how much of the library it covers. A weak match
 *  is recorded as weak -- not dropped, not trusted.
 *
 *  Sources, in order, and each field records which one supplied it:
 *    1. MusicBrainz (recording search, several fallbacks). The year is the
 *       earliest release over all matching recordings; the genres are the artist's.
 *    2. Only for songs MusicBrainz leaves unmatched: Deezer, then iTunes. Their
 *       year is an album/track release date, which can be a reissue or a
 *       compilation, so it is recorded as yearTier "fallback", never "earliest".
 *    3. Spotify's own genre (already in the catalogue) as an independent opinion,
 *       and as the genre when nothing else has one.
 *  A second source never overwrites a MusicBrainz match.
 *
 *  Results are cached by song, so a run can stop and resume. A lookup that fails
 *  on the network is NOT cached; the next run tries it again.
 *
 *  Usage: npm run enrich -- [--n 200] [--seed 1] [--all] [--crosscheck]
 *         npm run enrich -- --fill-album   (second pass: album + full release date, matched songs only)
 *         npm run enrich -- --report [--compare --n 200 --seed 1]
 *
 *  MusicBrainz asks for at most one request a second and an identifying
 *  User-Agent; this keeps to both, and to modest rates for Deezer and iTunes.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fold } from "./distill.ts";
import type { Catalog, Song } from "../src/catalog.ts";
import { pickRelease, dateForYear } from "./enrich-album.ts";
import {
  titleKeys, artistCandidates, artistNames, titleMatch, artistMatch, yearImpossible,
  yearsDisagree, looksClassical, familyOf, genreAgrees,
} from "./enrich-match.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "enrich.json");
const PILOT1 = join(ROOT, "data", "enrich-pilot1.json");
const UA = "MasterDankCollections/0.1 ( https://github.com/monokid/MasterDankCollections )";
const MB = "https://musicbrainz.org/ws/2";
const VERSION = 2;
/** Stamped by the album pass (--fill-album) on a record it completed. The main
 *  pass treats any v >= VERSION as current, so this never triggers a re-lookup. */
const ALBUM_VERSION = 3;

export type Confidence = "high" | "medium" | "none";
export type Source = "musicbrainz" | "deezer" | "itunes" | "spotify" | "heuristic";

export interface Enriched {
  songId: string;
  /** high: title and artist both match exactly. medium (weak): one only loosely. */
  confidence: Confidence;
  /** Which source matched the song; null when none did. */
  source?: Source | null;
  /** Which strategy found it, e.g. "lead+title", "title-only", "alias", "deezer". */
  via?: string | null;
  /** earliest: the minimum over every matching MusicBrainz recording.
   *  fallback: a single album/track date from Deezer or iTunes (may be a reissue). */
  year: number | null;
  yearTier?: "earliest" | "fallback" | null;
  /** Released after it was first played: the match is wrong, so the year is not counted. */
  yearSuspect?: boolean;
  genres: string[];
  /** Where the genres came from. */
  genreSource: "genre" | "tag" | "album" | "spotify" | "title" | null;
  /** low when the match was weak, the artist was matched loosely, Spotify disagrees, or the tags are thin. */
  genreConfidence?: "ok" | "low" | null;
  /** Votes behind the top MusicBrainz genre/tag; 1 is an opinion, not a consensus. */
  genreVotes?: number | null;
  /** One of ~25 families (see enrich-match.ts FAMILIES). */
  family?: string | null;
  country: string | null;
  recordings: number;
  mbid: string | null;
  /** MusicBrainz release group the cover is taken from; `cover` says whether one exists. */
  releaseGroup: string | null;
  cover: boolean;
  coverSource?: "caa" | "deezer" | "itunes" | null;
  coverUrl?: string | null;
  /** Per field, which source supplied it. */
  sources?: { year: Source | null; genre: Source | null; cover: Source | null };
  /** Set by --crosscheck: what Deezer says for a song MusicBrainz matched. */
  check?: { deezerYear: number | null; disagrees: boolean } | null;
  /** What was asked, so a wrong match can be traced. */
  query: string;
  matched: string | null;
  v?: number;
  /** Album pass: title of the release the year/cover came from (null: matched but none found). */
  album?: string | null;
  /** 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY'; its year always equals `year`. */
  releaseDate?: string | null;
  albumSource?: Source | null;
}

interface Store { schema: "mdc-enrich/2"; songs: Record<string, Enriched> }

// ------------------------------------------------------------------- network

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock: Record<string, number> = {};
async function polite<T>(service: string, gap: number, fn: () => Promise<T>): Promise<T> {
  const wait = (clock[service] ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  clock[service] = Date.now();
  return fn();
}

const GAPS = { mb: 1100, caa: 700, deezer: 450, itunes: 3200 } as const;
export const stats = { requests: { mb: 0, caa: 0, deezer: 0, itunes: 0 } as Record<string, number>, retries: 0 };

/** GET JSON with backoff on 429/5xx/network errors (2,4,8,16,32s; Retry-After honoured).
 *  Returns null on 404. Throws after the last attempt, so the caller leaves the song uncached. */
async function getJson(service: keyof typeof GAPS, url: string, attempts = 6): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      stats.requests[service]++;
      const res = await polite(service, GAPS[service], () =>
        fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(25000) }));
      if (res.ok) {
        const j = await res.json();
        // Deezer reports quota as a 200 with an error body.
        if (service === "deezer" && j?.error) { lastErr = `deezer error ${j.error.code}`; }
        else return j;
      } else if (res.status === 404) return null;
      else if (res.status === 429 || res.status >= 500 || res.status === 403) {
        lastErr = `${res.status}`;
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0) { stats.retries++; await sleep(Math.min(ra, 90) * 1000); continue; }
      } else throw new Error(`${res.status} ${url}`);
    } catch (e) {
      if ((e as Error).message.startsWith("4")) throw e;
      lastErr = (e as Error).message;
    }
    stats.retries++;
    await sleep(Math.min(2000 * 2 ** attempt, 60000));
  }
  throw new Error(`gave up after ${attempts} tries (${lastErr}) on ${url}`);
}

const lucene = (s: string) => s.replace(/["\\]/g, " ").trim();
const yearOf = (d: string | undefined | null) => {
  const y = d ? parseInt(d.slice(0, 4), 10) : NaN;
  return Number.isFinite(y) && y > 1850 && y < 2100 ? y : null;
};

// -------------------------------------------------------------- MusicBrainz

interface Hit { rec: any; title: "exact" | "loose"; artist: "exact" | "loose" }

function judge(recs: any[], keys: string[], names: string[], minScore: number): Hit[] {
  const hits: Hit[] = [];
  for (const rec of recs) {
    if ((rec.score ?? 0) < minScore) continue;
    const credited: string[] = (rec["artist-credit"] ?? []).flatMap((a: any) =>
      [a.name, a.artist?.name, a.artist?.["sort-name"]].filter(Boolean));
    const a = artistMatch(names, credited), t = titleMatch(keys, rec.title ?? "");
    if (a && t) hits.push({ rec, title: t, artist: a });
  }
  return hits;
}

async function mbRecordings(query: string, limit = 25): Promise<any[]> {
  const d = await getJson("mb", `${MB}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`);
  return d?.recordings ?? [];
}

/** Tries each fallback in turn and stops at the first that finds the song. */
async function musicbrainz(song: Song, tried: string[]): Promise<{ hits: Hit[]; via: string } | null> {
  const keys = titleKeys(song.title), names = artistNames(song.artist), cands = artistCandidates(song.artist);
  const lead = cands[0];
  const attempt = async (via: string, query: string, minScore: number, limit = 25) => {
    tried.push(query);
    const hits = judge(await mbRecordings(query, limit), keys, names, minScore);
    return hits.length ? { hits, via } : null;
  };
  // 1. the pilot's query, with the cleaned title and lead artist
  let r = await attempt("lead+title", `recording:"${lucene(keys[0])}" AND artist:"${lucene(lead)}"`, 85);
  if (r) return r;
  // 2. title only, the artist filtered here (the artist field may be spelled differently)
  r = await attempt("title-only", `recording:"${lucene(keys[0])}"`, 85, 60);
  if (r) return r;
  // 3. the artist as an MB artist or alias, then that artist's recordings of the title
  for (const c of cands.slice(0, 2)) {
    tried.push(`artist:"${c}"`);
    const found = await getJson("mb", `${MB}/artist?query=${encodeURIComponent(`artist:"${lucene(c)}"`)}&fmt=json&limit=5`);
    const wanted = fold(c);
    const ids = (found?.artists ?? []).filter((a: any) => (a.score ?? 0) >= 90 &&
      [a.name, a["sort-name"], ...(a.aliases ?? []).map((x: any) => x.name)].some((n: string) => fold(n ?? "") === wanted))
      .slice(0, 2).map((a: any) => a.id);
    for (const id of ids) {
      r = await attempt("alias", `recording:"${lucene(keys[0])}" AND arid:${id}`, 70);
      if (r) return r;
    }
  }
  // 4. each other credited artist
  for (const c of cands.slice(1)) {
    r = await attempt("other-artist", `recording:"${lucene(keys[0])}" AND artist:"${lucene(c)}"`, 85);
    if (r) return r;
  }
  // 5. looser titles (theme suffix, brackets, the work without the movement)
  for (const k of keys.slice(1, 3)) {
    r = await attempt("relaxed-title", `recording:"${lucene(k)}" AND artist:"${lucene(lead)}"`, 85);
    if (r) return r;
  }
  return null;
}

async function fromMusicBrainz(song: Song, base: Enriched, found: { hits: Hit[]; via: string },
  artistCache: Map<string, any>): Promise<Enriched> {
  const { hits, via } = found;
  const best = hits.some((h) => h.title === "exact" && h.artist === "exact" && h.rec.score >= 95) ? "high" : "medium";
  // A high match takes its year only from the exact ones; a weak one from all it has.
  const pool = best === "high" ? hits.filter((h) => h.title === "exact" && h.artist === "exact") : hits;
  const dated = pool.filter((h) => h.rec["first-release-date"])
    .sort((a, b) => a.rec["first-release-date"].localeCompare(b.rec["first-release-date"]));
  const first = (dated[0] ?? pool[0]).rec;
  const year = yearOf(first["first-release-date"]);
  const out: Enriched = {
    ...base, confidence: best, source: "musicbrainz", via, year, yearTier: year ? "earliest" : null,
    recordings: pool.length, mbid: first.id,
    matched: `${(first["artist-credit"] ?? []).map((a: any) => a.name).join(", ")} - ${first.title}`,
  };
  const artistExact = pool.some((h) => h.artist === "exact");

  // The artist carries the genres; a recording rarely does.
  const artistId = first["artist-credit"]?.[0]?.artist?.id;
  let thin = false;
  if (artistId) {
    if (!artistCache.has(artistId)) artistCache.set(artistId, await getJson("mb", `${MB}/artist/${artistId}?inc=genres+tags&fmt=json`));
    const a = artistCache.get(artistId);
    const by = (xs: any[] | undefined) => [...(xs ?? [])].sort((p, q) => q.count - p.count);
    const genres = by(a?.genres), tags = by(a?.tags);
    const use = genres.length ? genres : tags;
    out.genres = use.slice(0, 5).map((x: any) => x.name);
    out.genreSource = genres.length ? "genre" : tags.length ? "tag" : null;
    // One vote is an opinion, not a consensus.
    out.genreVotes = use.length ? use[0].count ?? 0 : null;
    thin = use.length > 0 && (use[0].count ?? 0) < 2;
    out.country = a?.country ?? a?.area?.["iso-3166-1-codes"]?.[0] ?? null;
  }
  (out as any)._lowGenre = best !== "high" || !artistExact || thin;

  // The cover: the release groups of the earliest dated releases, a few tried in turn.
  const groups: string[] = [];
  for (const h of [...pool].sort((a, b) => (a.rec["first-release-date"] || "9").localeCompare(b.rec["first-release-date"] || "9"))) {
    for (const rel of [...(h.rec.releases ?? [])].sort((a: any, b: any) => (a.date || "9").localeCompare(b.date || "9"))) {
      const id = rel["release-group"]?.id;
      if (id && !groups.includes(id)) groups.push(id);
    }
  }
  out.releaseGroup = groups[0] ?? null;
  for (const g of groups.slice(0, 3)) {
    const res = await polite("caa", GAPS.caa, () => { stats.requests.caa++; return fetch(`https://coverartarchive.org/release-group/${g}/front-250`,
      { method: "HEAD", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) }); });
    if (res.status >= 300 && res.status < 400) { out.cover = true; out.releaseGroup = g; out.coverSource = "caa"; break; }
  }
  return out;
}

// ---------------------------------------------------------- Deezer and iTunes

interface Fallback { via: string; exact: boolean; year: number | null; genres: string[]; coverUrl: string | null; matched: string; album: string | null; releaseDate: string | null }

async function deezer(song: Song): Promise<Fallback | null> {
  const keys = titleKeys(song.title), names = artistNames(song.artist), cands = artistCandidates(song.artist);
  const queries = [`${cands[0]} ${keys[0]}`, ...(cands[1] ? [`${cands[1]} ${keys[0]}`] : []), ...(keys[1] ? [`${cands[0]} ${keys[1]}`] : [])];
  for (const q of queries) {
    const d = await getJson("deezer", `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=15`);
    const hits = (d?.data ?? []).map((t: any) => ({ t, title: titleMatch(keys, t.title ?? ""), artist: artistMatch(names, [t.artist?.name ?? ""]) }))
      .filter((h: any) => h.title && h.artist);
    if (!hits.length) continue;
    const exact = hits.filter((h: any) => h.title === "exact" && h.artist === "exact");
    const pool = (exact.length ? exact : hits).slice(0, 4);
    // The earliest of the albums it appears on: a song is often on a later compilation.
    const albums = new Map<number, any>();
    for (const h of pool) {
      const id = h.t.album?.id;
      if (id && !albums.has(id)) albums.set(id, await getJson("deezer", `https://api.deezer.com/album/${id}`));
    }
    const dated = [...albums.values()].filter((a) => yearOf(a?.release_date)).sort((a, b) => a.release_date.localeCompare(b.release_date));
    const alb = dated[0] ?? [...albums.values()][0];
    const t = pool[0].t;
    return {
      via: "deezer", exact: exact.length > 0, year: yearOf(alb?.release_date),
      genres: (alb?.genres?.data ?? []).map((g: any) => g.name).filter(Boolean),
      coverUrl: alb?.cover_medium ?? t.album?.cover_medium ?? null,
      matched: `${t.artist?.name} - ${t.title}`,
      album: alb?.title ?? t.album?.title ?? null, releaseDate: alb?.release_date ?? null,
    };
  }
  return null;
}

async function itunes(song: Song): Promise<Fallback | null> {
  const keys = titleKeys(song.title), names = artistNames(song.artist), cands = artistCandidates(song.artist);
  const d = await getJson("itunes", `https://itunes.apple.com/search?term=${encodeURIComponent(`${cands[0]} ${keys[0]}`)}&entity=song&limit=15`);
  const hits = (d?.results ?? []).map((t: any) => ({ t, title: titleMatch(keys, t.trackName ?? ""), artist: artistMatch(names, [t.artistName ?? ""]) }))
    .filter((h: any) => h.title && h.artist);
  if (!hits.length) return null;
  const exact = hits.filter((h: any) => h.title === "exact" && h.artist === "exact");
  const pool = exact.length ? exact : hits;
  const dated = pool.filter((h: any) => yearOf(h.t.releaseDate)).sort((a: any, b: any) => a.t.releaseDate.localeCompare(b.t.releaseDate));
  const t = (dated[0] ?? pool[0]).t;
  return {
    via: "itunes", exact: exact.length > 0, year: yearOf(t.releaseDate),
    genres: t.primaryGenreName ? [t.primaryGenreName] : [],
    coverUrl: t.artworkUrl100 ? String(t.artworkUrl100).replace("100x100", "300x300") : null,
    matched: `${t.artistName} - ${t.trackName}`,
    album: t.collectionName ?? null, releaseDate: t.releaseDate ? String(t.releaseDate).slice(0, 10) : null,
  };
}

function fromFallback(base: Enriched, f: Fallback, source: "deezer" | "itunes"): Enriched {
  return {
    ...base, confidence: f.exact ? "high" : "medium", source, via: f.via,
    year: f.year, yearTier: f.year ? "fallback" : null,
    genres: f.genres.slice(0, 5), genreSource: f.genres.length ? "album" : null,
    cover: !!f.coverUrl, coverUrl: f.coverUrl, coverSource: f.coverUrl ? source : null,
    matched: f.matched, recordings: 1,
  };
}

// ------------------------------------------------------------------- lookup

/** Fills the derived fields (suspect year, family, genre confidence, per-field
 *  sources) from what is already in the record. No network. */
export function finish(e: Enriched, song: Song | undefined, spotify: string | undefined): Enriched {
  const lowGenre = (e as any)._lowGenre === true;
  delete (e as any)._lowGenre;
  e.yearSuspect = !!(e.year && song && yearImpossible(e.year, song.firstPlayed));
  const own = e.source ?? (e.confidence !== "none" ? "musicbrainz" : null);
  e.source = e.confidence === "none" ? null : own;
  if (e.confidence === "none" && !e.genres.length && song && looksClassical(song.title)) {
    // A composer and a work: no service matched, but the title alone says what it is.
    e.family = "classical"; e.genreSource = "title"; e.genreConfidence = "low";
  } else if (e.genres.length) {
    e.family = familyOf(e.genres);
    let low = lowGenre || (e.source !== "musicbrainz" && e.confidence !== "high") || e.family === "other";
    if (spotify && !genreAgrees(e.genres, spotify)) low = true;
    e.genreConfidence = low ? "low" : "ok";
  } else if (spotify) {
    // Nothing else has a genre; Spotify's own, taken as it is.
    e.genres = [spotify]; e.genreSource = "spotify"; e.family = familyOf(e.genres); e.genreConfidence = "ok";
  } else { e.family = null; e.genreConfidence = null; }
  const gs: Source | null = !e.genres.length && !e.family ? null
    : e.genreSource === "spotify" ? "spotify" : e.genreSource === "title" ? "heuristic" : e.source;
  e.sources = {
    year: e.year ? e.source ?? null : null,
    genre: gs,
    cover: e.cover ? (e.coverSource === "caa" || !e.coverSource ? "musicbrainz" : e.coverSource) : null,
  };
  e.v = VERSION;
  return e;
}

async function lookup(song: Song, artistCache: Map<string, any>, spotify: string | undefined): Promise<Enriched> {
  const tried: string[] = [];
  const base: Enriched = {
    songId: song.id, confidence: "none", source: null, via: null, year: null, yearTier: null, genres: [],
    genreSource: null, country: null, recordings: 0, mbid: null, releaseGroup: null, cover: false,
    query: "", matched: null,
  };
  const mbFound = await musicbrainz(song, tried);
  base.query = tried.join(" | ");
  if (mbFound) return finish(await fromMusicBrainz(song, base, mbFound, artistCache), song, spotify);

  // MusicBrainz left it unmatched: the second sources, in order.
  const d = await deezer(song);
  if (d) return finish(fromFallback(base, d, "deezer"), song, spotify);
  const i = await itunes(song);
  if (i) return finish(fromFallback(base, i, "itunes"), song, spotify);
  return finish(base, song, spotify);
}

/** For a song MusicBrainz matched: what does Deezer say the year is? Never changes the record. */
async function crosscheck(song: Song, e: Enriched): Promise<void> {
  const d = await deezer(song);
  e.check = { deezerYear: d?.year ?? null, disagrees: yearsDisagree(e.year, d?.year ?? null) };
}

// --------------------------------------------------------------- album pass

/** One request for a MusicBrainz song (its stored mbid); a Deezer/iTunes song is
 *  searched again in its own source. Returns null when nothing usable came back;
 *  throws on a network failure. Neither case touches the record. */
async function albumFor(song: Song, e: Enriched): Promise<{ album: string; releaseDate: string | null; source: Source } | null> {
  if (e.source === "musicbrainz" && e.mbid) {
    const d = await getJson("mb", `${MB}/recording/${e.mbid}?inc=releases+release-groups&fmt=json`);
    const pick = pickRelease(d?.releases ?? [], e.year, d?.["first-release-date"]);
    if (pick) return { ...pick, source: "musicbrainz" };
    // The stored recording is the earliest-dated one, often a bootleg or video with no
    // official release. Try the other recordings of the same song: one more request.
    const keys = titleKeys(song.title), names = artistNames(song.artist);
    const hits = judge(await mbRecordings(`recording:"${lucene(keys[0])}" AND artist:"${lucene(artistCandidates(song.artist)[0])}"`, 50), keys, names, 85);
    const alt = pickRelease(hits.flatMap((h) => h.rec.releases ?? []), e.year);
    return alt ? { ...alt, source: "musicbrainz" } : null;
  }
  const f = e.source === "deezer" ? await deezer(song) : e.source === "itunes" ? await itunes(song) : null;
  if (!f?.album) return null;
  // The album only counts if it is the one the stored year came from.
  if (e.year && f.year !== e.year) return null;
  return { album: f.album, releaseDate: dateForYear(e.year, f.releaseDate), source: e.source as Source };
}

async function fillAlbum(args: string[]) {
  const { byId } = context(args);
  const store = load();
  const todo = Object.values(store.songs).filter((e) => e.confidence !== "none" && e.album === undefined && byId.has(e.songId));
  const lim = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  const work = todo.slice(0, lim);
  console.log(`${todo.length} matched songs lack an album; doing ${work.length}`);
  const t0 = Date.now();
  let done = 0, none = 0, failed = 0, streak = 0, n = 0;
  for (const e of work) {
    const s = byId.get(e.songId)!;
    try {
      const r = await albumFor(s, e);
      streak = 0;
      if (r) { e.album = r.album; e.releaseDate = r.releaseDate; e.albumSource = r.source; e.v = ALBUM_VERSION; done++; }
      else { none++; console.log(`  - no album: ${s.artist} - ${s.title}`); }
    } catch (err) {
      failed++; streak++;
      console.error(`  ! ${s.artist} - ${s.title}: ${(err as Error).message}`);
      if (streak >= 3) { console.error("  three failures in a row: pausing 60s"); await sleep(60000); streak = 0; }
    }
    if (++n % 25 === 0) { save(store); console.log(`  ${n}/${work.length}  filled ${done}, none ${none}, failed ${failed}  (${Math.round((Date.now() - t0) / 1000)}s)`); }
  }
  save(store);
  console.log(`done. ${done} filled, ${none} no album found, ${failed} failed (both left unchanged; run again to retry). requests ${JSON.stringify(stats.requests)}`);
}

// ----------------------------------------------------------------------- run

function load(path = OUT): Store {
  if (!existsSync(path)) return { schema: "mdc-enrich/2", songs: {} };
  const s = JSON.parse(readFileSync(path, "utf8"));
  s.schema = "mdc-enrich/2";
  return s;
}
const save = (s: Store) => writeFileSync(OUT, JSON.stringify(s, null, 1));

/** A small seeded shuffle, so "the same 200" can be asked for again. */
function shuffled<T>(xs: T[], seed: number): T[] {
  let x = seed >>> 0 || 1;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function context(args: string[]) {
  const arg = (k: string, d: number) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
  const cat = JSON.parse(readFileSync(join(ROOT, "public", "data", "catalog.json"), "utf8")) as Catalog;
  const onNights = new Set(cat.events.filter((e) => e.kind === "event").map((e) => e.id));
  // Only songs that were played on a night: a shelf is not the history being studied.
  const songs = cat.songs.filter((s) => s.nights.some((n) => onNights.has(n)));
  const pick = args.includes("--all") ? songs : shuffled(songs, arg("--seed", 1)).slice(0, arg("--n", 200));
  const spotify = new Map<string, string>();
  for (const t of cat.tracks) if (t.songId && t.provenance.genre === "spotify" && t.genre) spotify.set(t.songId, t.genre);
  return { cat, songs, pick, spotify, byId: new Map(cat.songs.map((s) => [s.id, s])) };
}

async function run(args: string[]) {
  const { songs, pick, spotify, byId } = context(args);
  const store = load();

  // Old records get their derived fields without a request.
  for (const e of Object.values(store.songs)) if ((e.v ?? 0) < VERSION && e.confidence === "high") {
    e.source = "musicbrainz"; e.yearTier = e.year ? "earliest" : null; e.via = "pilot";
    e.coverSource = e.cover ? "caa" : null;
    finish(e, byId.get(e.songId), spotify.get(e.songId));
  }
  // Families may have been refined since: re-derive them where nothing network-dependent is involved.
  for (const e of Object.values(store.songs)) if ((e.v ?? 0) >= VERSION && e.source !== "musicbrainz") {
    if (e.genreSource === "spotify" || e.genreSource === "title") { e.genres = e.genreSource === "spotify" ? [] : e.genres; e.genreSource = null; }
    finish(e, byId.get(e.songId), spotify.get(e.songId));
  }
  // Pilot records that were not a confident match are looked up again, with the new fallbacks.
  const todo = pick.filter((s) => !store.songs[s.id] || (store.songs[s.id].v ?? 0) < VERSION);
  console.log(`${pick.length} songs chosen of ${songs.length}; ${pick.length - todo.length} already current; ${todo.length} to look up`);
  const artists = new Map<string, any>();
  const t0 = Date.now();
  let done = 0, failed = 0, streak = 0;
  for (const s of todo) {
    try { store.songs[s.id] = await lookup(s, artists, spotify.get(s.id)); streak = 0; }
    catch (e) {
      failed++; streak++;
      console.error(`  ! ${s.artist} - ${s.title}: ${(e as Error).message}`);
      if (streak >= 3) { console.error("  three failures in a row: pausing 60s"); await sleep(60000); streak = 0; }
      continue;
    }
    if (++done % 10 === 0) { save(store); console.log(`  ${done}/${todo.length}  (${Math.round((Date.now() - t0) / 1000)}s)`); }
  }
  save(store);
  console.log(`done. ${done} looked up, ${failed} failed (left uncached; run again). ${Object.keys(store.songs).length} songs in data/enrich.json`);
  if (done) console.log(`  ${((Date.now() - t0) / 1000 / done).toFixed(1)}s per song; requests ${JSON.stringify(stats.requests)}, retries ${stats.retries}`);

  if (args.includes("--crosscheck")) {
    const rows = pick.map((s) => store.songs[s.id]).filter((e) => e && e.source === "musicbrainz" && e.year && !e.check);
    console.log(`crosschecking ${rows.length} MusicBrainz years against Deezer`);
    let k = 0;
    for (const e of rows) {
      try { await crosscheck(byId.get(e.songId)!, e); } catch (err) { console.error(`  ! ${(err as Error).message}`); }
      if (++k % 20 === 0) save(store);
    }
    save(store);
  }
}

// -------------------------------------------------------------------- report

interface Metrics {
  n: number; high: number; medium: number; none: number; failed: number;
  year: number; yearSuspect: number; genre: number; family: number; cover: number;
  agree: number; comparable: number; legacyAgree: number; byYearSource: Record<string, number>;
  bySource: Record<string, number>; byGenre: Record<string, number>; byCover: Record<string, number>;
}

function metrics(ids: string[], recs: Record<string, Enriched>, songs: Map<string, Song>, spotify: Map<string, string>): Metrics {
  const m: Metrics = { n: ids.length, high: 0, medium: 0, none: 0, failed: 0, year: 0, yearSuspect: 0, genre: 0, family: 0, cover: 0,
    agree: 0, comparable: 0, legacyAgree: 0, byYearSource: {}, bySource: {}, byGenre: {}, byCover: {} };
  const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  for (const id of ids) {
    const e = recs[id];
    if (!e) { m.failed++; continue; }
    m[e.confidence]++;
    const src = e.source ?? (e.confidence !== "none" ? "musicbrainz" : null);
    if (src) bump(m.bySource, src);
    const suspect = e.yearSuspect ?? (e.year ? yearImpossible(e.year, songs.get(id)?.firstPlayed ?? null) : false);
    if (e.year && suspect) m.yearSuspect++;
    if (e.year && !suspect) { m.year++; bump(m.byYearSource, `${src}/${e.yearTier ?? "earliest"}`); }
    const matched = e.confidence !== "none";
    if (matched && e.genres.length) { m.genre++; bump(m.byGenre, e.genreSource ?? "?"); }
    const fam = e.family !== undefined ? e.family : (matched ? familyOf(e.genres) : null);
    if (fam && fam !== "other" && (matched || e.genreSource === "title" || e.genreSource === "spotify")) m.family++;
    if (matched && e.cover) { m.cover++; bump(m.byCover, e.coverSource ?? "caa"); }
    const sp = spotify.get(id);
    if (matched && e.genres.length && sp && e.genreSource !== "spotify") {
      m.comparable++;
      const g = sp.toLowerCase();
      if (e.genres.some((x) => { x = x.toLowerCase(); return g.includes(x) || x.includes(g) || x.split(" ").some((w) => w.length > 3 && g.includes(w)); })) m.legacyAgree++;
      if (genreAgrees(e.genres, sp)) m.agree++;
    }
  }
  return m;
}

function category(s: Song): string {
  const a = `${s.artist} ${s.title}`;
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(a)) return "Japanese script";
  if (/\b(mashup|bootleg|remix|vip|flip|rework|cover|vs\.?)\b/i.test(a)) return "remix/mashup/cover";
  if (/\b(ost|soundtrack|theme|opening|ending|bgm|stage|boss|battle)\b/i.test(a)) return "game/anime/theme";
  if (looksClassical(s.title)) return "classical";
  if (/\b(feat|ft)\b/i.test(a)) return "featured credit";
  return "other (likely obscure/mis-tagged)";
}

function report(args: string[]) {
  const { cat, pick, spotify, byId } = context(args);
  const store = load();
  const ids = pick.map((s) => s.id).filter((id) => byId.has(id));
  const after = metrics(ids, store.songs, byId, spotify);
  const compare = args.includes("--compare") && existsSync(PILOT1);
  const before = compare ? metrics(ids, load(PILOT1).songs, byId, spotify) : null;
  const pct = (k: number, n: number) => `${String(k).padStart(4)} ${(`(${((k / n) * 100).toFixed(0)}%)`).padStart(6)}`;
  const row = (label: string, f: (m: Metrics) => number) =>
    console.log(`  ${label.padEnd(34)} ${before ? pct(f(before), before.n) + "   " : ""}${pct(f(after), after.n)}`);
  console.log(`${ids.length} songs in the sample${compare ? "" : ""}`);
  console.log(`  ${"".padEnd(34)} ${before ? "pilot1        " : ""}now`);
  row("confident match (high)", (m) => m.high);
  row("weak match (medium)", (m) => m.medium);
  row("no match", (m) => m.none);
  row("lookup failed / not in cache", (m) => m.failed);
  row("year known (excl. impossible)", (m) => m.year);
  row("  impossible year (flagged)", (m) => m.yearSuspect);
  row("genre known (matched songs)", (m) => m.genre);
  row("family known (non-other)", (m) => m.family);
  row("cover found", (m) => m.cover);
  console.log(`  genre agrees with Spotify (words)   ${before ? `${before.legacyAgree}/${before.comparable}     ` : ""}${after.legacyAgree}/${after.comparable}`);
  console.log(`  genre agrees with Spotify (+family) ${before ? `${before.agree}/${before.comparable}     ` : ""}${after.agree}/${after.comparable}`);
  const show = (label: string, o: Record<string, number>) => console.log(`  ${label}: ${Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  console.log("per source (now):");
  show("matched by", after.bySource); show("year from", after.byYearSource); show("genre from", after.byGenre); show("cover from", after.byCover);

  const rows = ids.map((id) => store.songs[id]).filter(Boolean);
  const via: Record<string, number> = {};
  for (const r of rows) if (r.confidence !== "none") via[r.via ?? "?"] = (via[r.via ?? "?"] ?? 0) + 1;
  show("matched via strategy", via);
  const low = rows.filter((r) => r.genreConfidence === "low").length;
  console.log(`  genre marked low-confidence: ${low} of ${rows.filter((r) => r.genres.length).length} with genres`);
  const checked = rows.filter((r) => r.check);
  if (checked.length) {
    const have = checked.filter((r) => r.check!.deezerYear);
    console.log(`  Deezer year cross-check of MB years: ${have.length} comparable, ${have.filter((r) => r.check!.disagrees).length} differ by >2y`);
  }

  const bad = rows.filter((r) => r.yearSuspect);
  for (const r of bad.slice(0, 8)) {
    const s = byId.get(r.songId)!;
    console.log(`     impossible: ${s.artist} - ${s.title}: first played ${s.firstPlayed}, year ${r.year} (${r.source}: ${r.matched})`);
  }

  const none = rows.filter((r) => r.confidence === "none").map((r) => byId.get(r.songId)!);
  const cats: Record<string, number> = {};
  for (const s of none) { const c = category(s); cats[c] = (cats[c] ?? 0) + 1; }
  console.log(`\nStill unmatched: ${none.length}. By rough category:`);
  show("  ", cats);
  for (const s of none) console.log(`  ${category(s).slice(0, 12).padEnd(12)} ${s.artist} - ${s.title}`);
  void cat;
}

const args = process.argv.slice(2);
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (args.includes("--report")) report(args);
  else if (args.includes("--fill-album")) fillAlbum(args).catch((e) => { console.error(e); process.exit(1); });
  else run(args).catch((e) => { console.error(e); process.exit(1); });
}
