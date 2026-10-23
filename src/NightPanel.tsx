/** One night, laid out beside the timeline.
 *
 *  Clicking a bar opens this instead of navigating away, so you can hop from
 *  night to night -- arrow keys work too -- and read each set in place:
 *  contributor by contributor, phases in order, in the order it was played.
 */
import { ownerlessLabel } from "./nightstats.ts";
import { useMemo } from "react";
import type { Catalog, Track } from "./catalog.ts";
import { fmtDateLong, fmtHours, fmtDur, plural } from "./format.ts";
import { byPlayOrder } from "./rows.tsx";
import "./pages.css";

export default function NightPanel({ cat, eventId, onClose, onOpenTrack, onOpenNight, onPerson }: {
  cat: Catalog;
  eventId: string;
  onClose: () => void;
  onOpenTrack: (t: Track) => void;
  onOpenNight: (id: string) => void;
  onPerson: (personId: string) => void;
}) {
  const ev = cat.events.find((e) => e.id === eventId);

  const { sets, anonCopies } = useMemo(() => {
    const tracks = cat.tracks.filter((t) => t.eventId === eventId);
    const named = tracks.filter((t) => !t.flags.includes("anon"));
    const phase = new Map(cat.phases.map((p) => [p.id, p]));
    const byPerson = new Map<string, Track[]>();
    for (const t of named) {
      const k = t.personId ?? "";
      if (!byPerson.has(k)) byPerson.set(k, []);
      byPerson.get(k)!.push(t);
    }
    const sets = [...byPerson.entries()].map(([pid, list]) => {
      const person = cat.people.find((p) => p.id === pid);
      const sorted = [...list].sort(byPlayOrder);
      const groups = new Map<string, Track[]>();
      for (const t of sorted) {
        const k = t.phaseId ?? "";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(t);
      }
      const ordered = [...groups.entries()].sort((a, b) =>
        (a[0] ? phase.get(a[0])!.position : 1e9) - (b[0] ? phase.get(b[0])!.position : 1e9));
      return { pid, name: person?.name ?? ownerlessLabel(list), you: !!person?.isYou, count: list.length, groups: ordered, phase };
    }).sort((a, b) => b.count - a.count);
    return { sets, anonCopies: tracks.length - named.length };
  }, [cat, eventId]);

  const songNights = useMemo(
    () => new Map(cat.songs.map((s) => [s.id, s.nights.length])), [cat]);

  if (!ev) return null;
  const date = ev.date ? fmtDateLong(ev.date) : ev.folder;

  return (
    <aside className="nightpanel" aria-label="Night detail">
      <div className="np-head">
        <div>
          <div className="np-date">{date}</div>
          <div className="np-sub">
            {/* "Roll" over "roll" is the same word twice; show the joke name only when it adds something */}
            {ev.title && !ev.types.includes(ev.title.toLowerCase()) ? `${ev.title} · ` : ""}
            {ev.types.join(" + ") || ev.type || "night"}
          </div>
        </div>
        <button className="np-x" onClick={onClose} aria-label="Close night detail" title="Close">✕</button>
      </div>

      <div className="np-stats">
        <div><b>{ev.playedCount}</b><span>tracks</span></div>
        <div><b>{fmtHours(ev.durationSec)}</b><span>hours</span></div>
        <div><b>{ev.people.length}</b><span>people</span></div>
        <div><b>{ev.debuts}</b><span>debuts</span></div>
      </div>

      <button className="np-open" onClick={() => onOpenNight(ev.id)}>open the full night →</button>

      <div className="np-body">
        {sets.map((s) => (
          <section key={s.pid || "none"} className="np-set">
            <button className="np-who" onClick={() => s.pid && onPerson(s.pid)}
              title="Light up every night this person was at">
              {s.name}
              <span>{plural(s.count, "track")}</span>
            </button>
            {s.groups.map(([pid, tracks]) => {
              const ph = pid ? s.phase.get(pid) : null;
              return (
                <div key={pid || "loose"}>
                  {ph && (
                    <div className="np-phase">
                      <span className={`bucket ${ph.bucket}`}>{ph.bucket}</span>
                      {ph.clean}
                      {ph.inferred && <i> (the rest of the list)</i>}
                    </div>
                  )}
                  {tracks.map((t) => {
                    const n = t.songId ? songNights.get(t.songId) ?? 1 : 1;
                    return (
                      <button key={t.id} className="np-track" onClick={() => onOpenTrack(t)}>
                        <span className="t">
                          {t.title ?? "(untitled)"}
                          {n > 1 && <span className="chip recurs">×{n}</span>}
                        </span>
                        <span className="a">{t.artist ?? ""}</span>
                        <span className="d">{fmtDur(t.durationSec)}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </section>
        ))}
        {anonCopies > 0 && (
          <div className="np-note">{anonCopies} more files are anonymised copies of these sets.</div>
        )}
      </div>
    </aside>
  );
}
