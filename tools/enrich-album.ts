/** The pure parts of the album pass: which release a song's year came from, and
 *  the full date to go with the year. No network (tools/enrich-album.test.ts). */

export interface MbRelease {
  title?: string;
  date?: string;
  status?: string;
  "release-group"?: { title?: string; "primary-type"?: string | null; "secondary-types"?: string[] };
}

export interface AlbumPick { album: string; releaseDate: string | null }

const yearPart = (d: string | undefined | null) => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec((d ?? "").trim());
  return m ? { y: Number(m[1]), prec: m[3] ? 3 : m[2] ? 2 : 1 } : null;
};

/** 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' as given, or null if malformed/implausible. */
export function cleanDate(d: string | undefined | null): string | null {
  const p = yearPart(d);
  return p && p.y > 1850 && p.y < 2100 ? (d as string).trim() : null;
}

/** Lower is better: a plain album, then an album that is also e.g. a soundtrack, then
 *  single, EP, other, and a compilation/live/remix album last. */
export function typeRank(rel: MbRelease): number {
  const g = rel["release-group"];
  const prim = g?.["primary-type"] ?? "";
  const sec = g?.["secondary-types"] ?? [];
  if (sec.some((s) => /compilation|live|remix|dj-mix|mixtape|demo/i.test(s))) return 5;
  if (prim === "Album") return sec.length ? 1 : 0;
  if (prim === "Single") return 2;
  if (prim === "EP") return 3;
  return 4;
}

/** The date to publish for a year: the earliest date in that year, preferring day
 *  precision over a bare year over nothing. A date from another year never is. */
export function bestDate(year: number | null, dates: (string | undefined | null)[]): string | null {
  if (!year) return null;
  const inYear = dates.map(cleanDate).filter((d): d is string => !!d && yearPart(d)!.y === year);
  if (!inYear.length) return null;
  const maxPrec = Math.max(...inYear.map((d) => yearPart(d)!.prec));
  return inYear.filter((d) => yearPart(d)!.prec === maxPrec).sort()[0];
}

/** Date consistent with the stored year, or null (the year is kept either way). */
export const dateForYear = (year: number | null, date: string | null | undefined): string | null =>
  bestDate(year, [date]);

/** Picks the album for a recording's releases. Only official releases count. Among
 *  them, those dated in the stored `year` are preferred (that is where the year came
 *  from); otherwise the earliest year. Within a year: album before single/EP/
 *  compilation, then the earlier full date. `recordingDate` is the recording's own
 *  first-release-date, offered as a candidate for the date. */
export function pickRelease(releases: MbRelease[], year: number | null, recordingDate?: string | null): AlbumPick | null {
  const ok = releases.filter((r) => (r.status ?? "Official") === "Official" && (r["release-group"]?.title || r.title) && yearPart(r.date));
  if (!ok.length) return null;
  const yr = (r: MbRelease) => yearPart(r.date)!.y;
  const target = year && ok.some((r) => yr(r) === year) ? year : Math.min(...ok.map(yr));
  const pool = ok.filter((r) => yr(r) === target);
  pool.sort((a, b) => typeRank(a) - typeRank(b) || (b.date ?? "").length - (a.date ?? "").length || (a.date ?? "").localeCompare(b.date ?? ""));
  const best = pool[0];
  const album = (best["release-group"]?.title || best.title) as string;
  const releaseDate = bestDate(year ?? target, [recordingDate, ...ok.map((r) => r.date)]);
  return { album, releaseDate };
}
