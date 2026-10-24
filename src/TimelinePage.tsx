import type { Catalog, Track } from "./catalog.ts";
import Timeline, { type Trace } from "./Timeline.tsx";
import NightPanel from "./NightPanel.tsx";
import { TrackRow, fmtDate } from "./rows.tsx";
import { catalogIndex } from "./catalogIndex.ts";
import { isShown } from "./config.ts";
import type { Range } from "./analytics.ts";
import type { EnrichMap } from "./enrich.ts";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every night a traced song/artist/person appears on, as a list under the
 *  timeline, so the lit bars can actually be read. */
function TraceList({ cat, trace, onOpen }: {
  cat: Catalog; trace: Trace; onOpen: (t: Track) => void;
}) {
  const ix = catalogIndex(cat);
  const nights = cat.events
    .filter((e) => trace.nights.has(e.id) && e.date)
    .sort((a, b) => b.date!.localeCompare(a.date!));
  return (
    <>
      <h2 style={{ marginTop: 26 }}>
        {trace.label} · {nights.length} night{nights.length === 1 ? "" : "s"}
      </h2>
      {nights.map((e) => {
        const hits = (ix.tracksOfEvent.get(e.id) ?? []).filter((t) =>
          trace.kind === "song" ? t.songId === trace.id
            : trace.kind === "artist" ? t.artist && slug(t.artist) === trace.id
            : t.personId === trace.id);
        return (
          <div key={e.id}>
            <div className="phasehead" style={{ marginTop: 14 }}>
              <span className="name">{fmtDate(e.date)}</span>
              <span className="meta">
                {e.title ? `${e.title} · ` : ""}{hits.length} track{hits.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="rows">
              {hits.slice(0, 12).map((t) => (
                <TrackRow key={t.id} track={t} cat={cat} query="" onOpen={onOpen} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The Timeline view: the chart, the lit-up list under it, and the side panel for a picked night. */
export default function TimelinePage({
  cat, trace, setTrace, selected, setSelected, range, setRange,
  onInsights, onOpen, onOpenNight, onTrace, enrich,
}: {
  enrich?: EnrichMap | null;
  cat: Catalog;
  trace: Trace | null; setTrace: (t: Trace | null) => void;
  selected: string | null; setSelected: (id: string | null) => void;
  range: Range | null; setRange: (r: Range | null) => void;
  onInsights: () => void;
  onOpen: (t: Track) => void;
  onOpenNight: (id: string) => void;
  onTrace: (t: Trace) => void;
}) {
  return (
    <div className="page wide">
      <h1>The decade</h1>
      <p className="sub">
        Every night at its real date — the gaps are as much the story as the
        clusters. Height is how long the night ran; the lanes show who was there.
      </p>
      <div className={`tlgrid${selected ? " with-panel" : ""}`}>
        <div className="tlmain">
          <Timeline
            cat={cat} trace={trace} onClearTrace={() => setTrace(null)}
            selected={selected} onSelect={setSelected}
            range={range} onRange={setRange} onInsights={onInsights} enrich={enrich} />
          {trace && <TraceList cat={cat} trace={trace} onOpen={onOpen} />}
        </div>
        {selected && (
          <NightPanel
            cat={cat} eventId={selected}
            onClose={() => setSelected(null)}
            onOpenTrack={onOpen}
            onOpenNight={onOpenNight}
            onPerson={(pid) => {
              const p = catalogIndex(cat).person.get(pid);
              onTrace({
                kind: "person", id: pid, label: p?.name ?? pid,
                nights: new Set(cat.events
                  .filter((e) => isShown(e) && e.people.includes(pid))
                  .map((e) => e.id)),
              });
            }} />
        )}
      </div>
    </div>
  );
}
