/** The "About this song" facts block on the track page, as pure logic: how a
 *  release date is worded at the precision it is known, and which rows exist and
 *  in what order. No React, no DOM, so tools/songabout.test.ts can run it.
 *
 *  A facts list has no placeholders: a row whose value is unknown is not there. */
import type { DatePrecision } from "./enrich.ts";
import { fmtDuration, type SongInfo } from "./songcols.ts";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2013-03-14" -> "14 March 2013"; "2013-03" -> "March 2013"; "2013" -> "2013".
 *  The string is parsed, never given to Date(): a date-only string is read as UTC
 *  and printed in local time, which shows the day before west of Greenwich.
 *  Anything that does not parse at the stated precision falls back to the year,
 *  and to null when there is not even a year. */
export function releasedWords(text: string | null | undefined, precision: DatePrecision | null | undefined): string | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec((text ?? "").trim());
  if (!m) return null;
  const year = m[1], mo = m[2] ? +m[2] : 0, d = m[3] ? +m[3] : 0;
  const monthOk = mo >= 1 && mo <= 12;
  if (precision === "day" && monthOk && d >= 1 && d <= 31) return `${d} ${MONTHS[mo - 1]} ${year}`;
  if (precision === "month" && monthOk) return `${MONTHS[mo - 1]} ${year}`;
  return year;
}

export type AboutKey = "title" | "artist" | "album" | "length" | "released" | "genre" | "country" | "nights";

export interface AboutRow {
  key: AboutKey;
  label: string;
  /** Main text of the value. */
  text: string;
  /** Small chips after the text (raw genre tags). */
  chips?: string[];
}

/** The rows to show, in order, unknown ones left out. `country` comes from the
 *  enrichment facts (songfacts.countryName), which SongInfo does not carry. */
export function aboutRows(info: SongInfo, country: string | null = null): AboutRow[] {
  const rows: AboutRow[] = [{ key: "title", label: "Title", text: info.title }];
  const add = (r: AboutRow | null) => { if (r && (r.text.trim() || r.chips?.length)) rows.push(r); };
  add(info.artist ? { key: "artist", label: "Artist", text: info.artist } : null);
  add(info.album ? { key: "album", label: "Album", text: info.album } : null);
  const len = fmtDuration(info.durationSec);
  add(len ? { key: "length", label: "Length", text: len } : null);
  const rel = releasedWords(info.releaseDate, info.datePrecision) ?? (info.year ? String(info.year) : null);
  add(rel ? { key: "released", label: "Released", text: rel } : null);
  // Raw tags that only repeat the family name add nothing.
  const fam = info.familyLabel;
  const tags = info.genres.filter((g) => g.trim() && g.trim().toLowerCase() !== fam?.toLowerCase());
  add(fam || tags.length ? { key: "genre", label: "Genre", text: fam ?? "", chips: tags } : null);
  add(country ? { key: "country", label: "Country", text: country } : null);
  add(info.nights > 0
    ? { key: "nights", label: "Brought on", text: `${info.nights} ${info.nights === 1 ? "night" : "nights"}` } : null);
  return rows;
}
