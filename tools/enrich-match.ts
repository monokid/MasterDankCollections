/** The pure parts of enrichment: cleaning a title or artist into things worth
 *  asking a service for, deciding whether what came back is the same song, and
 *  collapsing raw genre tags into a small controlled set. No network here, so
 *  every rule can be tested (tools/enrich.test.ts). */
import { fold, splitVariant } from "./distill.ts";

// ------------------------------------------------------------------ cleaning

/** Bracketed or dash-trailed words that describe a rendition, not the song. */
const NOISE_WORDS =
  "mashup|bootleg|edit|mix|ver\\.?|version|remix|vip|rework|flip|cover|live|remaster(?:ed)?|instrumental|" +
  "acoustic|radio|extended|original|opening|ending|tv size|full|short|slow|official|lyrics?|audio|video|" +
  "feat\\.?|ft\\.?|featuring|bonus|single|album|clean|explicit|\\d{4}";
const NOISE_BRACKET = new RegExp(String.raw`\s*[(\[{][^)\]}]*\b(?:${NOISE_WORDS})(?![a-z])[^)\]}]*[)\]}]`, "gi");
const NOISE_DASH = new RegExp(String.raw`\s+[-–~]\s*[^-–~]*\b(?:ver\.?|version|remix|mix|edit|mashup|cover|live|remaster(?:ed)?)\b[^-–~]*[-–~]?\s*$`, "i");
const FEAT_TRAIL = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
const ANY_BRACKET = /\s*[(\[{][^)\]}]*[)\]}]/g;
const THEME_TAIL = /\s+(?:main\s+)?(?:theme|ost|soundtrack|opening|ending)(?:\s+song)?$/i;

const unquote = (s: string) => s.replace(/[“”"„‟«»]/g, "").replace(/[‘’`´]/g, "'").replace(/\s+/g, " ").trim();

/** The title as the song's own name: no feat., no (Remix), no [Radio Edit], no "-Slow ver.-". */
export function cleanTitle(title: string): string {
  let t = unquote(title);
  t = t.replace(NOISE_BRACKET, "").replace(NOISE_DASH, "").replace(FEAT_TRAIL, "");
  t = splitVariant(t).base;
  return t.replace(/\s+/g, " ").trim() || unquote(title);
}

/** Titles worth asking for, most specific first. Later ones are looser and
 *  only ever yield a weak match. */
export function titleKeys(title: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { s = s.trim(); if (fold(s).length >= 3 && !out.some((o) => fold(o) === fold(s))) out.push(s); };
  const v0 = cleanTitle(title);
  out.push(v0);   // always: even a two-letter title is asked for as it is
  const noTheme = v0.replace(THEME_TAIL, "");
  add(noTheme);
  const noBrackets = noTheme.replace(ANY_BRACKET, "").trim();
  add(noBrackets);
  // "Symphony No. 9 ... IV. Allegro con fuoco": the work, without the movement.
  const work = noBrackets.split(/\s*(?:\.{2,}|…|:|\s[-–]\s)\s*/)[0];
  if (work !== noBrackets) add(work);
  return out;
}

const SPLIT_CREDIT = /\s*(?:,|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bvs\.?|\bwith\b| x | & | and | \+ )\s*/i;

/** Credited names to try, in order: the lead, the whole credit, then the rest.
 *  At most four, because each costs a request. */
export function artistCandidates(artist: string): string[] {
  const a = unquote(artist);
  const parts = a.split(SPLIT_CREDIT).map((p) => p.trim()).filter((p) => fold(p).length >= 2);
  const whole = a.replace(FEAT_TRAIL, "").trim();
  const out: string[] = [];
  for (const c of [parts[0], whole, ...parts.slice(1)]) {
    if (c && !out.some((o) => fold(o) === fold(c))) out.push(c);
  }
  return out.slice(0, 4);
}

/** Every name a credit might legitimately appear under, for matching. */
export const artistNames = (artist: string): string[] => [unquote(artist), ...artistCandidates(artist)];

// ------------------------------------------------------------------ matching

const dropThe = (s: string) => s.replace(/^the\s+/, "");
const contains = (long: string, short: string) => ` ${long} `.includes(` ${short} `);

/** exact: same words. loose: one contains the other on word boundaries, and the
 *  shorter is long enough and more than half the longer. null: not the same. */
export function looseOrExact(a: string, b: string, minLen: number): "exact" | "loose" | null {
  const x = dropThe(fold(a)), y = dropThe(fold(b));
  if (!x || !y) return null;
  if (x === y) return "exact";
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length >= minLen && s.length * 2 > l.length && contains(l, s)) return "loose";
  return null;
}

/** Does a returned title name the same song as any of the wanted keys?
 *  exact needs the cleaned title equal; a relaxed key equal or containment is loose. */
export function titleMatch(wantKeys: string[], gotTitle: string): "exact" | "loose" | null {
  const gotKeys = titleKeys(gotTitle);
  if (!wantKeys.length || !gotKeys.length) return null;
  if (fold(wantKeys[0]) === fold(gotKeys[0])) return "exact";
  let best: "loose" | null = null;
  for (const w of wantKeys) for (const g of gotKeys) {
    const m = looseOrExact(w, g, 6);
    if (m) best = "loose";
  }
  return best;
}

/** Does any credited name match any name we have for the artist? */
export function artistMatch(wantNames: string[], credited: string[]): "exact" | "loose" | null {
  let best: "exact" | "loose" | null = null;
  for (const w of wantNames) for (const c of credited) {
    const m = looseOrExact(w, c, 4);
    if (m === "exact") return "exact";
    if (m) best = "loose";
  }
  return best;
}

/** Released after it was first played means the match is wrong (or a different
 *  recording): a song cannot be older than the night it was heard. */
export function yearImpossible(year: number | null, firstPlayed: string | null): boolean {
  if (!year || !firstPlayed) return false;
  const played = parseInt(firstPlayed.slice(0, 4), 10);
  return Number.isFinite(played) && year > played;
}

/** Two sources' years that are further apart than a reissue explains. */
export const yearsDisagree = (a: number | null, b: number | null, tolerance = 2) =>
  !!a && !!b && Math.abs(a - b) > tolerance;

/** "Anthony Dvorak - Symphony No. 9 ... IV. Allegro con fuoco": a composer and a work. */
export function looksClassical(title: string): boolean {
  return /\b(symphony|symphonie|concerto|sonata|suite|nocturne|prelude|fugue|etude|requiem|rhapsody|overture|opus|op\.\s*\d|bwv|k\.\s*\d{2,3}|allegro|andante|adagio|scherzo|largo|presto|movement)\b/i.test(title) ||
    /\bno\.\s*\d+\b.*\b(in|major|minor)\b/i.test(title);
}

// -------------------------------------------------------------- genre family

/** About 25 families, from MusicBrainz tags and Spotify genres alike.
 *  ORDER MATTERS: the first pattern that matches a tag wins, so the specific
 *  ones sit above the general ones ("industrial metal" is industrial, "j-pop" is
 *  not pop, "hardcore punk" is punk while plain "hardcore" stays punk too but
 *  "happy hardcore"/"hardcore techno"/"gabber" are hard dance). */
export const FAMILIES: [string, RegExp][] = [
  ["comedy/novelty", /\b(comedy|novelty|parody|humou?r|spoken word|meme|funny)\b/],
  ["vgm/soundtrack", /\b(video game|vgm|chiptune|game music|soundtrack|ost|score|films?|games?|movie|musical|cinematic|bitpop)\b/],
  ["classical", /\b(classical|baroque|romantic|opera|orchestral|symphon(?:y|ic)(?! metal)|chamber|neoclassical|contemporary classical|choral|renaissance|piano music|concerto)\b/],
  ["j-pop/anime", /\b(j pop|jpop|j-pop|anime|vocaloid|utaite|doujin|touhou|japanese|k pop|kpop|city pop|j rock|jrock|visual kei|idol)\b/],
  ["hard dance/hardcore", /\b(hardstyle|gabber|happy hardcore|uk hardcore|hardcore techno|hardcore dance|frenchcore|rawstyle|hard dance|hard trance|speedcore|makina|early rave|rave|eurodance|hands up|jumpstyle|hard house|donk)\b/],
  ["industrial/EBM", /\b(industrial|ebm|electronic body|aggrotech|dark electro|darkwave|futurepop|electro industrial|coldwave)\b/],
  ["psytrance/trance", /\b(psytrance|psychedelic trance|goa|trance|progressive trance|full on|dark psy|psy)\b/],
  ["dubstep/bass", /\b(dubstep|drum and bass|drum n bass|dnb|jungle|breakbeat|bass music|brostep|riddim|trap|glitch hop|neurofunk|future bass|grime|uk garage|bass house|breaks|big beat)\b/],
  ["synthwave", /\b(synthwave|retrowave|outrun|vaporwave|synth wave|new retro wave|chillwave|darksynth)\b/],
  ["ambient/downtempo", /\b(ambient|downtempo|chillout|chill out|trip hop|new age|drone|lounge|idm|lo fi|lofi|dark ambient|psybient|space music|easy listening)\b/],
  ["house/techno", /\b(house|techno|minimal|electro house|deep house|tech house|disco|italo|dance|club|edm|electro|electronic|electronica|idm|big room|progressive house|nu disco)\b/],
  ["post-rock/prog", /\b(post rock|post metal|post-rock|post-metal|prog|progressive|math rock|krautrock|space rock|art rock|shoegaze|experimental|avant garde|psychedelic rock|neo prog)\b/],
  ["metal", /\b(metal|metalcore|deathcore|grindcore|death|thrash|doom|sludge|black|power|nwobhm|heavy|djent|screamo|viking|folk metal|symphonic metal)\b/],
  ["punk", /\b(punk|hardcore|post punk|post-punk|emo|ska|skate|oi|garage punk|riot grrrl|pop punk|crust|new wave|no wave)\b/],
  ["folk/medieval/celtic", /\b(folk|medieval|celtic|irish|pagan|renaissance|bard|acoustic|singer songwriter|singer-songwriter|nordic|neofolk|sea shanty|shanty|bluegrass|americana|world fusion|middle ages|minstrel)\b/],
  ["reggae/dub", /\b(reggae|dub|dancehall|ragga|roots|ska reggae|rocksteady|soca)\b/],
  ["hip hop", /\b(hip hop|hip-hop|rap|hiphop|boom bap|trap rap|gangsta|emcee|mc)\b/],
  ["jazz/funk/soul", /\b(jazz|funk|soul|swing|bebop|blues|r&b|rnb|r b|gospel|motown|big band|bossa|latin jazz|neo soul|rhythm and blues)\b/],
  ["world", /\b(world|asian|latin|afro|african|balkan|klezmer|flamenco|salsa|tango|bollywood|indian|arabic|brazilian|cumbia|reggaeton|samba|gypsy|polka|tribal|didgeridoo|throat)\b/],
  ["country", /\b(country|honky tonk|outlaw|western|cowboy)\b/],
  ["rock", /\b(rock|alternative|indie|grunge|britpop|hard rock|classic rock|pop rock|garage|stoner|glam|southern rock|rock and roll|rockabilly|surf|blues rock|psychedelic|new romantic|jam band|lo-fi)\b/],
  ["pop", /\b(pop|synthpop|synth pop|electropop|dance pop|teen pop|power pop|singer|vocal|easy|schlager|europop|adult contemporary|bubblegum|neue deutsche welle)\b/],
];

export const FAMILY_NAMES = [...FAMILIES.map(([n]) => n), "other"];

const tagText = (g: string) => g.toLowerCase().replace(/[_]/g, " ").replace(/\s+/g, " ").trim();

/** The family of the first-listed genre that maps to one. Genres arrive most
 *  voted first, so the position decides; "other" is returned only when genres
 *  exist but none map. null when there are no genres at all. */
export function familyOf(genres: string[]): string | null {
  if (!genres.length) return null;
  const score = new Map<string, number>();
  genres.slice(0, 5).forEach((g, i) => {
    const t = tagText(g);
    const hit = FAMILIES.find(([, re]) => re.test(t));
    if (hit) score.set(hit[0], (score.get(hit[0]) ?? 0) + (5 - i));
  });
  if (!score.size) return "other";
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Whether MusicBrainz's genres and Spotify's one genre say the same thing:
 *  words in common, or the same family. */
export function genreAgrees(genres: string[], spotify: string): boolean {
  const g = tagText(spotify);
  if (!g) return false;
  const words = genres.some((x) => {
    x = tagText(x);
    return g.includes(x) || x.includes(g) || x.split(" ").some((w) => w.length > 3 && g.includes(w));
  });
  if (words) return true;
  const a = familyOf(genres), b = familyOf([spotify]);
  return !!a && a === b && a !== "other";
}
