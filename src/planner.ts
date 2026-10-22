/** Planning a night: has this been brought before?
 *
 *  Pure functions, no UI. A pasted list (or an Exportify CSV) becomes
 *  candidates; each candidate is looked up by the catalogue's own song identity
 *  (songId = fold(artist) | fold(base title)) and gets one verdict:
 *
 *    never    no night has had it (the artist may still be known)
 *    played   a night has had this very version
 *    variant  only another version was played (a Live, a Remix...) -- this
 *             counts as played, and says which version
 *    clash    the same song is already earlier in the pasted list
 *
 *  Only nights count. A song that exists only in a collection (favs, mix) is
 *  "never", with a note that it sits on a shelf.
 */
import type { Catalog } from "./catalog.ts";
import { fold, splitVariant } from "./identity.ts";
import { parseCsv } from "./csv.ts";

export type Verdict = "never" | "played" | "variant" | "clash";

export interface Candidate {
  line: number;          // 1-based line in the pasted text (row in a CSV)
  raw: string;
  artists: string[];     // spellings to try, the one to show first
  title: string;
}

export interface ArtistFacts { id: string; name: string; songs: number; nights: number; last: string | null }

export interface PlanRow {
  cand: Candidate;
  verdict: Verdict;
  /** What the catalogue says before the list is compared with itself. */
  found: "never" | "played" | "variant";
  songId: string | null;
  key: string;                 // identity used for the clash test
  nights: number;
  first: string | null;
  last: string | null;
  bringers: string[];
  you: boolean;
  /** "played as Live, 2019" -- only for a variant. */
  label: string | null;
  shelf: boolean;
  artist: ArtistFacts | null;
  clashWith: number | null;    // line of the earlier twin
}

// ------------------------------------------------------------------ the index

interface Play { eventId: string; date: string | null; personId: string | null; variant: string | null }

export interface PlanIndex {
  songs: Map<string, Play[]>;
  shelf: Set<string>;
  artists: Map<string, ArtistFacts>;
  people: Map<string, { name: string; isYou: boolean }>;
}

/** Every play on a night, by song. Anonymised copies are the same playlist
 *  again, so they are left out, as everywhere else. */
export function buildPlanIndex(cat: Catalog): PlanIndex {
  const kind = new Map(cat.events.map((e) => [e.id, e]));
  const names = new Map(cat.artists.map((a) => [a.id, a.name]));
  const songs = new Map<string, Play[]>();
  const shelf = new Set<string>();
  const acc = new Map<string, { songs: Set<string>; nights: Set<string>; last: string | null }>();
  for (const t of cat.tracks) {
    if (!t.songId || t.flags.includes("anon")) continue;
    const ev = kind.get(t.eventId);
    if (!ev) continue;
    if (ev.kind !== "event") { shelf.add(t.songId); continue; }
    const list = songs.get(t.songId) ?? [];
    list.push({ eventId: ev.id, date: ev.date, personId: t.personId, variant: t.variant });
    songs.set(t.songId, list);
    const aid = t.songId.split("|")[0];
    const a = acc.get(aid) ?? { songs: new Set<string>(), nights: new Set<string>(), last: null };
    a.songs.add(t.songId); a.nights.add(ev.id);
    if (ev.date && (!a.last || ev.date > a.last)) a.last = ev.date;
    acc.set(aid, a);
  }
  const artists = new Map<string, ArtistFacts>();
  for (const [id, a] of acc) {
    artists.set(id, { id, name: names.get(id) ?? id, songs: a.songs.size, nights: a.nights.size, last: a.last });
  }
  return {
    songs, shelf, artists,
    people: new Map(cat.people.map((p) => [p.id, { name: p.name, isYou: p.isYou }])),
  };
}

// ------------------------------------------------------------ reading titles

// Words that name a rendition. A variant is reduced to its kind, so "Live at
// Wembley" and "Live" compare equal. A remaster is the same recording cleaned
// up, so it has no kind at all: a remaster of a song played plain is the same
// version, and the reverse.
const KINDS = [
  "live", "remix", "remastered", "remaster", "acoustic", "instrumental", "unplugged", "demo",
  "reprise", "cover", "radio edit", "extended mix", "orchestral", "karaoke",
];
export function variantKind(v: string | null): string {
  if (!v) return "";
  const low = v.toLowerCase();
  const k = KINDS.find((w) => new RegExp(String.raw`\b${w}\b`).test(low));
  return k ? (k.startsWith("remaster") ? "" : k) : fold(v);
}

const FEAT_GROUP = /\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi;
const FEAT_TAIL = /\s+(?:feat\.?|ft\.?|featuring)\s.*$/i;
// Streaming-service suffixes: "Song - 2011 Remaster", "Song - Single Version".
const REMASTER_TAIL = /\s*[-–—]\s*(?:\d{4}\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4}))?\s*$/i;
const EDITION_TAIL = /\s*[-–—]\s*(?:single|album|mono|stereo|original|radio)\s+(?:version|mix|edit)\s*$/i;

/** The catalogue's reading of a title, and a more forgiving one. The first is
 *  exactly what the distiller would have made; the second also drops guest
 *  credits and streaming suffixes the distiller never saw. */
export function readTitle(title: string): Array<{ base: string; variant: string | null }> {
  const strict = splitVariant(title);
  let t = title.replace(FEAT_GROUP, "").replace(FEAT_TAIL, "");
  let extra: string | null = null;
  if (REMASTER_TAIL.test(t)) { t = t.replace(REMASTER_TAIL, ""); extra = "Remaster"; }
  t = t.replace(EDITION_TAIL, "");
  const loose = splitVariant(t);
  const out = [strict];
  if (fold(loose.base) !== fold(strict.base) || (loose.variant ?? extra) !== strict.variant) {
    out.push({ base: loose.base, variant: loose.variant ?? extra });
  }
  return out;
}

/** Spellings of an artist worth trying: as given, the lead name before a guest
 *  credit, each name of a list, and with or without a leading "The". */
export function artistSpellings(artist: string): string[] {
  const main = artist.replace(FEAT_TAIL, "").replace(FEAT_GROUP, "").trim();
  const parts = main.split(/\s*(?:,|;|&|\band\b|\sx\s|\swith\s)\s*/i).filter(Boolean);
  const all = [artist, main, ...parts];
  const keys: string[] = [];
  for (const a of all) {
    const f = fold(a);
    if (!f) continue;
    for (const k of f.startsWith("the ") ? [f, f.slice(4)] : [f, "the " + f]) if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

// ------------------------------------------------------------------ parsing

export interface Parsed { candidates: Candidate[]; skipped: string[] }

const NUMBERING = /^\s*(?:\(?\d{1,3}\s*[.)]\s+|\d{1,3}\s+[-–—]\s+|[*•]\s+|-\s+)/;
const SEP = /\s+[-–—]\s+|\t+/;
const unquote = (s: string) => s.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();

/** Would this (artist, title) be found in the library? 3 = the song, 1 = the
 *  artist only, 0 = neither. Used only to decide which side of a dash is the
 *  artist when the list does not say. */
function score(ix: PlanIndex, artist: string, title: string): number {
  const keys = artistSpellings(artist);
  if (keys.some((a) => readTitle(title).some((r) => ix.songs.has(`${a}|${fold(r.base)}`)))) return 3;
  return keys.some((a) => ix.artists.has(a)) ? 1 : 0;
}

/** Lines such as "Artist - Title". Either order is accepted: for each dash the
 *  library is asked which way round it knows, and "Artist - Title" wins a tie.
 *  Numbering ("01.", "3)"), bullets, blank lines and quotes are ignored. */
export function parseList(text: string, ix: PlanIndex): Parsed {
  const candidates: Candidate[] = [], skipped: string[] = [];
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(NUMBERING, "").trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(SEP).map(unquote).filter(Boolean);
    if (parts.length < 2) { skipped.push(raw.trim()); return; }
    let best: { artist: string; title: string } | null = null, top = -1;
    for (let k = 1; k < parts.length; k++) {
      const left = parts.slice(0, k).join(" - "), right = parts.slice(k).join(" - ");
      for (const [artist, title] of [[left, right], [right, left]]) {
        const s = score(ix, artist, title);
        if (s > top) { top = s; best = { artist, title }; }
      }
    }
    candidates.push({ line: i + 1, raw: raw.trim(), artists: [best!.artist], title: best!.title });
  });
  return { candidates, skipped };
}

/** An Exportify CSV: "Track Name" and "Artist Name(s)", the latter split on ";". */
export function parseExportify(text: string): Parsed {
  const rows = parseCsv(text);
  const head = rows[0] ?? [];
  const ti = head.indexOf("Track Name"), ai = head.indexOf("Artist Name(s)");
  if (ti < 0 || ai < 0) return { candidates: [], skipped: ["Not an Exportify file: no \"Track Name\" and \"Artist Name(s)\" columns."] };
  const candidates: Candidate[] = [], skipped: string[] = [];
  rows.slice(1).forEach((r, i) => {
    const title = (r[ti] ?? "").trim();
    const artists = (r[ai] ?? "").split(";").map((a) => a.trim()).filter(Boolean);
    if (!title || !artists.length) { skipped.push(r.join(",")); return; }
    candidates.push({ line: i + 2, raw: `${artists.join(", ")} - ${title}`, artists: [artists[0], ...artists.slice(1), artists.join(" ")], title });
  });
  return { candidates, skipped };
}

// ------------------------------------------------------------------ checking

const year = (d: string | null) => (d ? d.slice(0, 4) : "an undated night");

/** Looks one candidate up. Returns the verdict before the list is compared
 *  with itself, and the canonical identity for that comparison. */
function look(ix: PlanIndex, cand: Candidate): Omit<PlanRow, "verdict" | "clashWith"> {
  const readings = readTitle(cand.title);
  const artistKeys = cand.artists.flatMap(artistSpellings);
  let songId: string | null = null, variant: string | null = null;
  search: for (const a of artistKeys) {
    for (const r of readings) {
      const base = fold(r.base);
      if (!base) continue;
      if (ix.songs.has(`${a}|${base}`)) { songId = `${a}|${base}`; variant = r.variant; break search; }
      // "Ghost Love Score Live": a rendition word glued on, as the distiller reads it
      const m = r.variant ? null : r.base.match(/^(.+?)\s+(live|remix|remastered|acoustic|instrumental)$/i);
      if (m && ix.songs.has(`${a}|${fold(m[1])}`)) { songId = `${a}|${fold(m[1])}`; variant = m[2]; break search; }
    }
  }
  const artistKey = artistKeys.find((a) => ix.artists.has(a)) ?? null;
  const artist = artistKey ? ix.artists.get(artistKey)! : null;
  // Not in the library: identify it by its lead artist (no guest credit, no
  // "The") so two spellings of one unknown song still clash.
  const lead = fold(cand.artists[0].replace(FEAT_TAIL, "").replace(FEAT_GROUP, "")).replace(/^the /, "");
  const key = songId ?? `${lead}|${fold(readings[readings.length - 1].base)}`;
  const base = { songId, key, artist, shelf: false, nights: 0, first: null, last: null, bringers: [] as string[], you: false, label: null as string | null, cand };

  if (!songId) {
    const shelf = [...ix.shelf].some((s) => artistKeys.some((a) => readings.some((r) => s === `${a}|${fold(r.base)}`)));
    return { ...base, found: "never", shelf };
  }
  const plays = ix.songs.get(songId)!;
  const want = variantKind(variant);
  const exact = plays.filter((p) => variantKind(p.variant) === want);
  const used = exact.length ? exact : plays;
  const nightIds = new Set(used.map((p) => p.eventId));
  const dates = used.map((p) => p.date).filter(Boolean).sort() as string[];
  const who = new Set(used.map((p) => p.personId).filter(Boolean) as string[]);
  const bringers = [...who].map((id) => ix.people.get(id)?.name ?? id);
  const row = {
    ...base, nights: nightIds.size, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null,
    bringers, you: [...who].some((id) => ix.people.get(id)?.isYou), label: null as string | null,
  };
  if (exact.length) return { ...row, found: "played" };
  // Only other versions were played: say which, and when it was last.
  const seen = new Map<string, string | null>();
  for (const p of plays) {
    const name = p.variant ?? "the original";
    if (!seen.has(name) || (p.date ?? "") > (seen.get(name) ?? "")) seen.set(name, p.date);
  }
  const label = "played as " + [...seen].map(([n, d]) => `${n}, ${year(d)}`).join("; ");
  return { ...row, found: "variant", label };
}

/** Verdicts for a list, in the order given. A song that is already earlier in
 *  the list is a clash, whatever the library says about it. */
export function checkList(ix: PlanIndex, cands: Candidate[]): PlanRow[] {
  const firstSeen = new Map<string, number>();
  return cands.map((c) => {
    const r = look(ix, c);
    const twin = firstSeen.get(r.key);
    if (twin === undefined) firstSeen.set(r.key, c.line);
    return { ...r, verdict: twin === undefined ? r.found : "clash", clashWith: twin ?? null };
  });
}

export function summarise(rows: PlanRow[]): { counts: Record<Verdict, number>; sentence: string } {
  const counts: Record<Verdict, number> = { never: 0, played: 0, variant: 0, clash: 0 };
  for (const r of rows) counts[r.verdict]++;
  if (!rows.length) return { counts, sentence: "" };
  const bits = [`${counts.never} of ${rows.length} are new to the library`];
  if (counts.played) bits.push(`${counts.played} played before`);
  if (counts.variant) bits.push(`${counts.variant} as other versions`);
  if (counts.clash) bits.push(`${counts.clash} repeated in your list`);
  return { counts, sentence: bits.join(", ") };
}

/** The songs nobody has brought, as pasteable "Artist - Title" lines. */
export function newOnes(rows: PlanRow[]): string {
  return rows.filter((r) => r.verdict === "never")
    .map((r) => `${r.cand.artists[0]} - ${r.cand.title}`).join("\n");
}
