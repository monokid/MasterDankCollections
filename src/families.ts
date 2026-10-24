/** One colour per genre family, shared by every page that paints one (night
 *  orbs, mixes, legends). Hues are spread round the wheel so neighbours differ;
 *  a colour is never the only carrier of the family: always label it too. */

export const FAMILY_ORDER = [
  "rock", "house/techno", "metal", "post-rock/prog", "vgm/soundtrack", "folk/medieval/celtic",
  "classical", "jazz/funk/soul", "pop", "industrial/EBM", "j-pop/anime", "ambient/downtempo",
  "psytrance/trance", "hip hop", "dubstep/bass", "hard dance/hardcore", "punk", "synthwave",
  "world", "comedy/novelty", "reggae/dub", "country", "other",
] as const;

const HUES: Record<string, number> = {
  "rock": 8, "house/techno": 192, "metal": 345, "post-rock/prog": 262, "vgm/soundtrack": 150,
  "folk/medieval/celtic": 95, "classical": 48, "jazz/funk/soul": 28, "pop": 320, "industrial/EBM": 215,
  "j-pop/anime": 335, "ambient/downtempo": 175, "psytrance/trance": 285, "hip hop": 62, "dubstep/bass": 240,
  "hard dance/hardcore": 0, "punk": 18, "synthwave": 300, "world": 120, "comedy/novelty": 75,
  "reggae/dub": 135, "country": 40,
};

/** The family's colour as hsl(), or a neutral grey for "other" and unknown. */
export function familyColour(family: string | null | undefined, light = 66): string {
  const h = family ? HUES[family] : undefined;
  return h === undefined ? `hsl(240 8% ${light - 12}%)` : `hsl(${h} 78% ${light}%)`;
}

/** The family's name for people: "vgm/soundtrack" -> "VGM / soundtrack". */
export function familyLabel(family: string): string {
  return family.replace(/\bvgm\b/i, "VGM").replace(/\bebm\b/i, "EBM").replace(/\//g, " / ");
}
