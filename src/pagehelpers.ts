/** Logic the pages share, kept free of React so tools/pages.test.ts can run it:
 *  grouping and sorting search hits, setlists, CSV, scroll-spy and keyboard
 *  stepping. The few functions that touch the browser say so. */
import type { ArtistEntry, Catalog, Event, Person, Song, Track } from "./catalog.ts";
import { yearSpan } from "./format.ts";

// ------------------------------------------------------------ lookup tables

export interface Lookups {
  events: Map<string, Event>;
  songs: Map<string, Song>;
  artists: Map<string, ArtistEntry>;
  people: Map<string, Person>;
  peopleName: Map<string, string>;
}

const lookupCache = new WeakMap<Catalog, Lookups>();

/** Id -> record maps for a catalogue, built once. `TrackRow` used to scan three
 *  arrays per row; on a night with 200 tracks that is 200 x thousands of songs. */
export function lookups(cat: Catalog): Lookups {
  let l = lookupCache.get(cat);
  if (!l) {
    l = {
      events: new Map(cat.events.map((e) => [e.id, e])),
      songs: new Map(cat.songs.map((s) => [s.id, s])),
      artists: new Map(cat.artists.map((a) => [a.id, a])),
      people: new Map(cat.people.map((p) => [p.id, p])),
      peopleName: new Map(cat.people.map((p) => [p.id, p.name])),
    };
    lookupCache.set(cat, l);
  }
  return l;
}

// ----------------------------------------------------------- search grouping

export interface Group {
  key: string;
  songId: string | null;
  title: string;
  artist: string | null;
  variants: string[];
  /** Every play that survived the filters, newest night first. */
  tracks: Track[];
  nights: number;
  /** Who brought it, by name. */
  people: string[];
  /** "2018" or "2018–21". */
  span: string;
  /** Date of the newest play, "" when undated. */
  latest: string;
  anon: boolean;
}

export type SortKey = "match" | "nights" | "az" | "newest";

export const SORT_LABEL: Record<SortKey, string> = {
  match: "Best match", nights: "Most nights", az: "A to Z", newest: "Newest play",
};

/** Folds search hits (a ranked list of tracks) into one group per song, in the
 *  order the song first appeared -- which is the scorer's rank order. */
export function groupHits(
  hits: Array<{ track: Track }>,
  ctx: Pick<Lookups, "events" | "songs" | "peopleName">,
  filter: { year?: string; type?: string } = {},
): { groups: Group[]; plays: number } {
  const by = new Map<string, Group>();
  let plays = 0;
  for (const { track: t } of hits) {
    const ev = ctx.events.get(t.eventId);
    if (filter.year && ev?.date?.slice(0, 4) !== filter.year) continue;
    if (filter.type && !ev?.types.includes(filter.type)) continue;
    plays++;
    const key = t.songId ?? `t:${t.id}`;
    let g = by.get(key);
    if (!g) {
      const song = t.songId ? ctx.songs.get(t.songId) : undefined;
      g = {
        key, songId: t.songId,
        title: song?.title ?? t.title ?? "(untitled)",
        artist: song?.artist ?? t.artist,
        variants: song?.variants ?? [],
        tracks: [], nights: 0, people: [], span: "", latest: "", anon: false,
      };
      by.set(key, g);
    }
    g.tracks.push(t);
  }
  const groups = [...by.values()];
  const date = (t: Track) => ctx.events.get(t.eventId)?.date ?? "";
  for (const g of groups) {
    g.nights = new Set(g.tracks.map((t) => t.eventId)).size;
    // Newest play first: that is the one people are usually after.
    g.tracks.sort((a, b) => date(b).localeCompare(date(a)));
    g.latest = g.tracks.length ? date(g.tracks[0]) : "";
    g.span = yearSpan(g.tracks.map(date).filter(Boolean));
    g.people = [...new Set(g.tracks.map((t) => t.personId).filter((p): p is string => !!p))]
      .map((id) => ctx.peopleName.get(id) ?? "").filter(Boolean);
    g.anon = g.tracks.some((t) => t.flags.includes("anon"));
  }
  return { groups, plays };
}

/** "Best match" keeps the order given (rank order); the rest sort a copy.
 *  Without a query there is no rank, so "match" falls back to most nights. */
export function sortGroups(list: Group[], sort: SortKey, hasQuery: boolean): Group[] {
  const key: SortKey = sort === "match" && !hasQuery ? "nights" : sort;
  if (key === "match") return list;
  const out = [...list];
  const byNights = (a: Group, b: Group) => b.nights - a.nights || b.tracks.length - a.tracks.length;
  if (key === "nights") out.sort(byNights);
  else if (key === "az") out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || byNights(a, b));
  else out.sort((a, b) => b.latest.localeCompare(a.latest) || byNights(a, b));
  return out;
}

// ------------------------------------------------------------------ setlists

export const setlistLine = (t: Pick<Track, "artist" | "title">) => {
  const title = t.title ?? "(untitled)";
  return t.artist ? `${t.artist} - ${title}` : title;
};

/** Plain text, one "Artist - Title" per line, in the order given. */
export const setlistText = (tracks: Array<Pick<Track, "artist" | "title">>) =>
  tracks.map(setlistLine).join("\n");

/** A person's played tracks split the way the night page lays them out: one
 *  list per phase (in the order `phaseIds` gives), then the loose ones. */
export function splitSet(played: Track[], phaseIds: string[]) {
  const known = new Set(phaseIds);
  const byPhase = new Map<string, Track[]>(phaseIds.map((id) => [id, []]));
  const loose: Track[] = [];
  for (const t of played) {
    if (t.phaseId && known.has(t.phaseId)) byPhase.get(t.phaseId)!.push(t);
    else loose.push(t);
  }
  return { byPhase, loose, ordered: [...phaseIds.flatMap((id) => byPhase.get(id)!), ...loose] };
}

/** Link to a track on Spotify, or null when the uri is not a plain track id. */
export function spotifyUrl(uri: string | undefined): string | null {
  const id = uri?.split(":").pop();
  return id && /^[A-Za-z0-9]+$/.test(id) ? `https://open.spotify.com/track/${id}` : null;
}

// ----------------------------------------------------------------------- CSV

export type Cell = string | number | null | undefined;

/** One CSV cell. Text that a spreadsheet would run as a formula (= + - @) is
 *  prefixed with an apostrophe; real numbers are written as they are. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (header: string[], rows: Cell[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** "Songs that keep coming back" -> "songs-that-keep-coming-back.csv". */
export function csvFilename(title: string, suffix = "") {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "chart";
  return `${slug}${suffix ? "-" + suffix : ""}.csv`;
}

// ---------------------------------------------------- scroll-spy & keyboard

/** Which section a scroll position is in: the last one whose top has reached
 *  `line`, or -1 before the first. At the very bottom the last section wins,
 *  or a short final section could never be the current one. */
export function sectionAt(tops: number[], line: number, atBottom = false): number {
  if (atBottom && tops.length) return tops.length - 1;
  let cur = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) cur = i; else break;
  }
  return cur;
}

/** Arrow-key stepping through `n` results. -1 means "above the first" (back to
 *  the search box). Stops at the last result instead of wrapping. */
export const stepIndex = (cur: number, delta: -1 | 1, n: number) =>
  Math.max(-1, Math.min(n - 1, cur + delta));

// ----------------------------------------------------------- browser helpers

export const scrollRootOf = (el: Element | null) => el?.closest(".scroll") as HTMLElement | null;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Plain http or a denied permission: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  // A BOM makes Excel read the accents in artist names as UTF-8.
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff), text], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
