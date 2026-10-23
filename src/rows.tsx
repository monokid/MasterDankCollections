import { memo } from "react";
import type { Catalog, Track } from "./catalog.ts";
import { highlight } from "./search.ts";
import { fmtDur } from "./format.ts";
import { lookups, spotifyUrl } from "./pagehelpers.ts";
import { ExternalIcon } from "./icons.tsx";
import "./pages.css";

// The formatters live in format.ts; re-exported because App and others import them from here.
export { fmtDur, fmtSpan, fmtDate } from "./format.ts";

export function Marked({ value, query }: { value: string; query: string }) {
  if (!query.trim()) return <>{value}</>;
  return (
    <>{highlight(value, query).map(([part, hit], i) =>
      hit ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>)}</>
  );
}

export function Flags({ track }: { track: Track }) {
  return (
    <>{track.flags.filter((f) => f !== "untagged").map((f) =>
      <span key={f} className={`chip ${f}`}>{f}</span>)}</>
  );
}

/** The distiller has already deduced the order ("1-2-3", "I-II-III",
 *  "intro-peak-afterglow"); the page just follows it. */
export const namedOf = (list: Track[]) => list.filter((t) => !t.flags.includes("anon"));
/** The order the set was played in, where the lists say. Tracks with no known
 *  place keep the order the folder gave them (the sort is stable). */
export const byPlayOrder = (a: Track, b: Track) => (a.playOrder ?? 1e9) - (b.playOrder ?? 1e9);

export const TrackRow = memo(function TrackRow({ track, cat, query, onOpen, twin }: {
  track: Track; cat: Catalog; query: string; onOpen: (t: Track) => void;
  /** For an anonymised row: its named twin, so the list says what each one is. */
  twin?: Track;
}) {
  const lk = lookups(cat);
  const person = track.personId ? lk.peopleName.get(track.personId) ?? "" : "";
  const ev = lk.events.get(track.eventId);
  const song = track.songId ? lk.songs.get(track.songId) : undefined;
  const recurs = song && song.nights.length > 1 ? song.nights.length : 0;
  const spot = spotifyUrl(track.spotifyUri);
  return (
    // The Spotify link sits beside the row, not inside it: a link in a button is invalid.
    <div className={`rowx${spot ? " has-spot" : ""}`}>
      <button className="row" onClick={() => onOpen(track)}>
        <div className="t">
          <Marked value={track.title ?? "(untitled)"} query={query} />
          {track.variant && <span className="chip variant">{track.variant}</span>}
          {recurs > 0 && (
            <span className="chip recurs" title={`Played on ${recurs} nights`}>
              ×{recurs}
            </span>
          )}
          <Flags track={track} />
        </div>
        <div className="a">
          {twin
            ? <span className="twinhint" title="its named twin">
                = {twin.artist ? `${twin.artist} — ` : ""}{twin.title}
              </span>
            : <Marked value={track.artist ?? "—"} query={query} />}
        </div>
        <div className="p">{person || <span className="faint">unknown</span>}</div>
        <div className="d">{ev?.date?.slice(0, 4) ?? "??"} · {fmtDur(track.durationSec)}</div>
      </button>
      {spot && (
        <a className="spot" href={spot} target="_blank" rel="noreferrer"
          title="Open in Spotify" aria-label={`Open ${track.title ?? "track"} in Spotify`}>
          <ExternalIcon size={15} />
        </a>
      )}
    </div>
  );
});
