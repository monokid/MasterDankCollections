/** Finding a 30-second preview for a song, from Apple's public iTunes Search API
 *  (no key, CORS open). Only the lookup happens here; the audio itself is played
 *  by the browser's <audio> straight from Apple's preview URL -- we never fetch
 *  or host the music. Nothing here runs until the visitor presses play.
 *
 *  Matching is the hard part: the search returns covers, karaoke, live takes and
 *  remasters. `pickBest` is pure so tools/previews.test.ts can pin each way it
 *  goes wrong. */
import { fold, splitVariant } from "./identity.ts";

export interface Wanted {
  artist: string | null;
  title: string;
  durationSec: number | null;
}

/** The fields of an iTunes result we read. */
export interface ItunesResult {
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  previewUrl?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
}

export interface Preview {
  previewUrl: string;
  artworkUrl: string | null;
  trackName: string;
  artistName: string;
}

// ---------------------------------------------------------------- matching

const FEAT = /\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.*$/i;
// "(2011 Remaster)", "- Remastered 2009", "(Remastered)", "- Single Version", "(Deluxe)" are the same recording.
const REISSUE = /\s*[(\[][^)\]]*\b(?:remaster(?:ed)?|deluxe|bonus track|mono|stereo|single version|single edit|original mix|album version|explicit)\b[^)\]]*[)\]]|\s+[-–]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|single edit|original mix|album version|mono|stereo)\b.*$/i;
/** Things a different artist's version of the song says about itself. */
const NOT_THE_SONG = /\b(?:karaoke|tribute|made famous|originally performed|in the style of|cover version|lullaby|8[- ]?bit|piano version|string quartet|backing track)\b|\bcovers?\b/i;
/** Renditions that are the same name but a different recording. */
const RENDITION = /\b(?:live|remix|acoustic|instrumental|demo|unplugged|reprise|orchestral|extended mix|radio edit)\b/i;

/** The song's title with feat. tags and reissue labels removed. */
export function cleanTitle(title: string): string {
  return title.replace(REISSUE, "").replace(FEAT, "").replace(/\s+/g, " ").trim();
}

const JOINER = /\s+(?:&|and|x|vs\.?|with)\s+|\s*[,;]\s*/i;

/** The lead artist: "A feat. B", "A & B", "A, B", "A x B" all lead with A. */
export function leadArtist(artist: string): string {
  return artist.replace(FEAT, "").split(JOINER)[0].trim();
}

const bigrams = (s: string) => {
  const t = s.replace(/\s+/g, "");
  const out = new Map<string, number>();
  if (t.length < 2) { if (t) out.set(t, 1); return out; }
  for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
  return out;
};

/** Dice coefficient over letter pairs: works for any script, tolerant of small spelling drift. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a), y = bigrams(b);
  let hit = 0, nx = 0, ny = 0;
  for (const [k, n] of x) { nx += n; hit += Math.min(n, y.get(k) ?? 0); }
  for (const n of y.values()) ny += n;
  return nx + ny ? (2 * hit) / (nx + ny) : 0;
}

const unThe = (s: string) => s.replace(/^the /, "");

export function artistSimilarity(ours: string, theirs: string): number {
  const a = unThe(fold(leadArtist(ours))), b = unThe(fold(leadArtist(theirs)));
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Ours is one of their credited artists ("Daft Punk" in "Pharrell & Daft Punk"). Whole names only: "Air" is not "Air Supply".
  if (theirs.split(JOINER).some((p) => unThe(fold(p)) === a)) return 0.9;
  return similarity(a, b);
}

export function titleSimilarity(ours: string, theirs: string): number {
  const a = fold(splitVariant(cleanTitle(ours)).base), b = fold(splitVariant(cleanTitle(theirs)).base);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // "Black Harvest" vs "Black Harvest (Pt. 2)": a longer name that starts with ours is a near miss, not a match.
  return Math.min(similarity(a, b), 0.9);
}

/** How well one result fits what we want: 0 (reject) to 1 (exact). */
export function matchScore(w: Wanted, r: ItunesResult): number {
  if (!r.previewUrl || !r.trackName) return 0;
  const ourText = `${w.title} ${w.artist ?? ""}`;
  // A cover / karaoke / tribute album when we did not ask for one.
  const theirText = `${r.trackName} ${r.collectionName ?? ""} ${r.artistName ?? ""}`;
  if (NOT_THE_SONG.test(theirText) && !NOT_THE_SONG.test(ourText)) return 0;
  // A live or remixed take of a song we hold in its plain form (and the other way round).
  const ourR = RENDITION.test(w.title), theirR = RENDITION.test(r.trackName);
  if (theirR !== ourR && !(ourR && !theirR)) return 0;

  const t = titleSimilarity(w.title, r.trackName);
  const a = w.artist ? artistSimilarity(w.artist, r.artistName ?? "") : 0.75;   // no artist known: the title must carry it
  if (t < 0.85 || a < 0.7) return 0;

  const mine = w.durationSec, theirs = r.trackTimeMillis ? r.trackTimeMillis / 1000 : null;
  let penalty = 0;
  if (mine && theirs) {
    const off = Math.abs(theirs - mine) / mine;
    if (off > 0.2) return 0;                      // a different edit, or a different song of the same name
    penalty = off * 0.25;
  }
  return 0.55 * t + 0.45 * a - penalty;
}

/** The best acceptable result, or null. */
export function pickBest(w: Wanted, results: ItunesResult[]): ItunesResult | null {
  let best: ItunesResult | null = null, bestScore = 0.7;
  for (const r of results) {
    const s = matchScore(w, r);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return best;
}

export const toPreview = (r: ItunesResult): Preview => ({
  previewUrl: r.previewUrl!, artworkUrl: r.artworkUrl100 ?? null,
  trackName: r.trackName ?? "", artistName: r.artistName ?? "",
});

// ------------------------------------------------------------------ lookup

export const searchUrl = (w: Wanted): string =>
  `https://itunes.apple.com/search?term=${encodeURIComponent([w.artist ? leadArtist(w.artist) : "", cleanTitle(w.title)].filter(Boolean).join(" "))}&entity=song&limit=8`;

const mem = new Map<string, Preview | null>();
const inflight = new Map<string, Promise<Preview | null>>();
const KEY = (w: Wanted) => fold(`${w.artist ?? ""} ${w.title}`);
const SKEY = "mdc:prev:";

function fromSession(key: string): Preview | null | undefined {
  try {
    const raw = sessionStorage.getItem(SKEY + key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as Preview | null;
  } catch { return undefined; }
}
function toSession(key: string, v: Preview | null) {
  try { sessionStorage.setItem(SKEY + key, JSON.stringify(v)); } catch { /* storage blocked: memory only */ }
}

/** What we already know, without asking the network. undefined = never looked. */
export function cachedPreview(w: Wanted): Preview | null | undefined {
  const key = KEY(w);
  if (mem.has(key)) return mem.get(key);
  const s = fromSession(key);
  if (s !== undefined) mem.set(key, s);
  return s;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Look a preview up. Resolves null for "there is none" (cached, so asked once); a
 *  network or server failure also resolves null but is NOT cached, so a later try can succeed. */
export async function findPreview(w: Wanted, fetcher: Fetcher = fetch as Fetcher): Promise<Preview | null> {
  const known = cachedPreview(w);
  if (known !== undefined) return known;
  const key = KEY(w);
  const going = inflight.get(key);
  if (going) return going;
  const p = (async () => {
    try {
      const res = await fetcher(searchUrl(w), { referrerPolicy: "no-referrer" });
      if (!res.ok) return null;
      const body = (await res.json()) as { results?: ItunesResult[] };
      const best = pickBest(w, Array.isArray(body.results) ? body.results : []);
      const out = best ? toPreview(best) : null;
      mem.set(key, out);
      toSession(key, out);
      return out;
    } catch { return null; }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/** For tests. */
export function forgetPreviews() { mem.clear(); inflight.clear(); }
