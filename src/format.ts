/** One place for how the pages print durations, counts and dates, so a track
 *  length on Search reads the same as on a night. Pure: no React, no DOM. */

/** Track length, "3:07". Rounds the whole value first: rounding only the
 *  seconds part printed 59.6s as "2:60". Empty for unknown. */
export const fmtDur = (s: number | null | undefined) => {
  if (!s || s < 0) return "";
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Running time as hours and minutes: "2h 14m", or "34m". */
export const fmtSpan = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/** Hours with one decimal, "6.4". */
export const fmtHours = (s: number) => (s / 3600).toFixed(1);

/** A count with thousands separators: 2,904. */
export const fmtCount = (n: number) => n.toLocaleString();

/** "1 song", "2 songs"; pass `many` for irregular plurals. */
export const plural = (n: number, one: string, many = one + "s") =>
  `${fmtCount(n)} ${n === 1 ? one : many}`;

/** A 0..1 share as "42%". */
export const pct = (share: number) => `${Math.round(share * 100)}%`;

const day = (iso: string) => new Date(iso + "T00:00:00");

/** "3 Feb 2018" (locale order); "undated" for no date. */
export const fmtDate = (d: string | null | undefined, locale?: string) =>
  d ? day(d).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "undated";

/** "Saturday, 3 February 2018". */
export const fmtDateLong = (d: string, locale?: string) =>
  day(d).toLocaleDateString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

/** "2018" for one year, "2018–21" across several. */
export function yearSpan(dates: string[]): string {
  if (!dates.length) return "";
  let lo = dates[0], hi = dates[0];
  for (const d of dates) { if (d < lo) lo = d; if (d > hi) hi = d; }
  return lo.slice(0, 4) === hi.slice(0, 4) ? lo.slice(0, 4) : `${lo.slice(0, 4)}–${hi.slice(2, 4)}`;
}
