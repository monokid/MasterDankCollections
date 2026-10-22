/** How the catalogue decides two spellings are one song: `fold` and
 *  `splitVariant`, the same rule the distiller used to build every songId
 *  (songId = fold(artist) | fold(base title)).
 *
 *  This is a copy, because the distiller pulls in node: modules and the page
 *  cannot. tools/planner.test.ts runs both over the same inputs and fails the
 *  moment they disagree, so the copy cannot drift quietly. */

// Bracketed words that mark a rendition rather than a different song. Must stay
// identical to VARIANT_WORDS in tools/distill.ts.
const VARIANT_WORDS = [
  "live", "remix", "remaster", "remastered", "acoustic", "instrumental",
  "unplugged", "demo", "reprise", "cover", "radio edit", "extended mix",
  "orchestral", "karaoke",
];
const VARIANT_ALT = VARIANT_WORDS.join("|");
const VARIANT_RE = new RegExp(
  String.raw`[(\[]\s*([^)\]]*\b(?:` + VARIANT_ALT + String.raw`)\b[^)\]]*)\s*[)\]]`, "i");
const VARIANT_TRAIL = new RegExp(
  String.raw`\s*[-–]\s*((?:` + VARIANT_ALT + String.raw`)\b.*)$`, "i");

/** Case- and punctuation-insensitive form, letters and digits of any script. */
export const fold = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Splits "King Nothing (Live)" into the work and the rendition. */
export function splitVariant(title: string): { base: string; variant: string | null } {
  const m = title.match(VARIANT_RE);
  if (m) return { base: title.replace(VARIANT_RE, "").trim(), variant: m[1].trim() };
  const t = title.match(VARIANT_TRAIL);
  if (t) return { base: title.replace(VARIANT_TRAIL, "").trim(), variant: t[1].trim() };
  return { base: title.trim(), variant: null };
}
