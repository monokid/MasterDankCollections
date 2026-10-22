import type { Catalog, Track } from "./catalog.ts";
import { highlight } from "./search.ts";

export const fmtDur = (s: number | null) => {
  if (!s) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
};

/** Running time as hours and minutes: "2h 14m", or "34m". */
export const fmtSpan = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

export const fmtDate = (d: string | null) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" }) : "undated";

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

export function TrackRow({ track, cat, query, onOpen, twin }: {
  track: Track; cat: Catalog; query: string; onOpen: (t: Track) => void;
  /** For an anonymised row: its named twin, so the list says what each one is. */
  twin?: Track;
}) {
  const person = track.personId
    ? cat.people.find((p) => p.id === track.personId)?.name ?? "" : "";
  const ev = cat.events.find((e) => e.id === track.eventId);
  const song = track.songId ? cat.songs.find((s) => s.id === track.songId) : undefined;
  const recurs = song && song.nights.length > 1 ? song.nights.length : 0;
  return (
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
      <div className="p">{person || <span style={{ opacity: 0.45 }}>unknown</span>}</div>
      <div className="d">{ev?.date?.slice(0, 4) ?? "??"} · {fmtDur(track.durationSec)}</div>
    </button>
  );
}
