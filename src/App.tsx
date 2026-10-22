import { useEffect, useState, useCallback } from "react";
import type { Catalog, Track } from "./catalog.ts";
import SongSearch from "./SongSearch.tsx";
import Starfield from "./Starfield.tsx";
import Logo from "./Logo.tsx";
import Home, { Wash, prefersReducedMotion } from "./Home.tsx";
import Resolver from "./Resolver.tsx";
import TabRail from "./TabRail.tsx";
import "./header.css";
import Timeline, { type Trace } from "./Timeline.tsx";
import Insights from "./Insights.tsx";
import Planner from "./Planner.tsx";
import NightPanel from "./NightPanel.tsx";
import EventsList from "./Browse.tsx";
import NightPage from "./NightPage.tsx";
import { Flags, TrackRow, fmtDate, fmtDur } from "./rows.tsx";
import { isShown, visibleCatalog } from "./config.ts";
import { getBundle, hasSession, resume } from "./vault.ts";
import type { WeatherMap } from "./weather.ts";
import type { Range } from "./analytics.ts";

type View = "home" | "search" | "timeline" | "browse" | "insights" | "plan" | "resolve";

// ------------------------------------------------------------------ browse

function BrowseView({ cat, weather, onOpen, eventId, setEventId }: {
  cat: Catalog; weather: WeatherMap; onOpen: (t: Track) => void;
  eventId: string | null; setEventId: (id: string | null) => void;
}) {
  // The night we just left, so the list can scroll back to its card.
  const [from, setFrom] = useState<string | null>(null);
  const ev = eventId ? cat.events.find((e) => e.id === eventId && isShown(e)) : null;

  if (!ev) {
    return <EventsList cat={cat} weather={weather} focusId={from} onOpenNight={setEventId} />;
  }
  return (
    <NightPage cat={cat} ev={ev} weather={weather} onOpen={onOpen}
      onBack={() => { setFrom(ev.id); setEventId(null); }}
      onGoto={setEventId} />
  );
}


// ------------------------------------------------------------------- detail

/** Every night a traced song/artist/person appears on, as a list under the
 *  timeline, so the lit bars can actually be read. */
function TraceList({ cat, trace, onOpen }: {
  cat: Catalog; trace: Trace; onOpen: (t: Track) => void;
}) {
  const nights = cat.events
    .filter((e) => trace.nights.has(e.id) && e.date)
    .sort((a, b) => b.date!.localeCompare(a.date!));
  return (
    <>
      <h2 style={{ marginTop: 26 }}>
        {trace.label} · {nights.length} night{nights.length === 1 ? "" : "s"}
      </h2>
      {nights.map((e) => {
        const hits = cat.tracks.filter((t) =>
          t.eventId === e.id && (
            trace.kind === "song" ? t.songId === trace.id
              : trace.kind === "artist" ? t.artist && t.artist.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === trace.id
              : t.personId === trace.id));
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

function TrackDetail({ track, cat, onClose, onTrace }: {
  track: Track; cat: Catalog; onClose: () => void; onTrace: (t: Trace) => void;
}) {
  const person = cat.people.find((p) => p.id === track.personId);
  const ev = cat.events.find((e) => e.id === track.eventId);
  const phase = cat.phases.find((p) => p.id === track.phaseId);
  const song = track.songId ? cat.songs.find((s) => s.id === track.songId) : undefined;
  const artist = song ? cat.artists.find((a) => a.id === song.id.split("|")[0]) : undefined;
  const twin = track.twinId ? cat.tracks.find((t) => t.id === track.twinId) : undefined;
  const P = ({ f }: { f: string }) =>
    <span className="prov">via {track.provenance[f] ?? "unknown"}</span>;
  return (
    <div className="page">
      <button className="backlink" onClick={onClose}>← back</button>
      <div className="panel detail">
        <h1>{track.title ?? "(untitled)"}</h1>
        <p className="sub">{track.artist ?? "unknown artist"} <Flags track={track} /></p>
        <dl>
          <dt>Artist</dt><dd>{track.artist ?? "—"}<P f="artist" /></dd>
          <dt>Title</dt><dd>{track.title ?? "—"}<P f="title" /></dd>
          {track.album && <><dt>Album</dt><dd>{track.album}</dd></>}
          <dt>Brought by</dt><dd>{person?.name ?? "unknown"}<P f="person" /></dd>
          {twin && (
            <>
              <dt>{track.flags.includes("anon") ? "Named as" : "Anonymised as"}</dt>
              <dd>
                {twin.flags.includes("anon")
                  ? <code>{twin.path[twin.path.length - 1]}</code>
                  : `${twin.artist ? twin.artist + " — " : ""}${twin.title}`}
                <span className="prov">paired by running time</span>
              </dd>
            </>
          )}
          {track.playOrder !== null && (
            <><dt>Set order</dt><dd>number {track.playOrder} in this contributor's set</dd></>
          )}
          <dt>Event</dt><dd>{fmtDate(ev?.date ?? null)} · {ev?.folder}<P f="event" /></dd>
          {phase && <><dt>Phase</dt><dd>{phase.clean} ({phase.bucket})
            {phase.minutes ? ` · ${phase.minutes} min` : ""}<P f="phase" /></dd></>}
          {song && song.nights.length > 1 && (
            <>
              <dt>History</dt>
              <dd>
                played on <b>{song.nights.length} nights</b>, {song.firstPlayed} to{" "}
                {song.lastPlayed}
                {song.variants.length > 0 && <> · as {song.variants.join(", ")}</>}
                <button className="backlink" style={{ marginLeft: 10, marginBottom: 0 }}
                  onClick={() => onTrace({
                    kind: "song", id: song.id,
                    label: `${song.artist} — ${song.title}`,
                    nights: new Set(song.nights),
                  })}>show on timeline →</button>
              </dd>
            </>
          )}
          {artist && artist.nights.length > 1 && (
            <>
              <dt>This artist</dt>
              <dd>
                {artist.songs} song{artist.songs === 1 ? "" : "s"} across{" "}
                <b>{artist.nights.length} nights</b>
                <button className="backlink" style={{ marginLeft: 10, marginBottom: 0 }}
                  onClick={() => onTrace({
                    kind: "artist", id: artist.id, label: artist.name,
                    nights: new Set(artist.nights),
                  })}>show on timeline →</button>
              </dd>
            </>
          )}
          <dt>Length</dt><dd>{fmtDur(track.durationSec) || "—"}</dd>
          {track.source === "spotify"
            ? <><dt>From</dt><dd>a Spotify playlist export — no file in the library</dd></>
            : <>
                <dt>File</dt><dd>{track.ext} · {(track.sizeBytes / 1e6).toFixed(1)} MB</dd>
                <dt>Path</dt><dd><code>{track.path.join(" / ")}</code></dd>
              </>}
          {track.spotifyUri && (
            <>
              <dt>Spotify</dt>
              <dd><a href={`https://open.spotify.com/track/${track.spotifyUri.split(":").pop()}`}
                target="_blank" rel="noreferrer">open in Spotify ↗</a></dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- app

export default function App() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [view, setView] = useState<View>("home");
  // The click-through from Home: where the colour flood started, until it has dissolved.
  const [wash, setWash] = useState<{ x: number; y: number } | null>(null);
  // Search just surfaced from the wash: animate it in once.
  const [emerge, setEmerge] = useState(false);
  const [detail, setDetail] = useState<Track | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  // The span Insights is narrowed to -- drawn on the timeline, or picked by
  // clicking a year. One piece of state, shared, so the two stay in step.
  const [range, setRange] = useState<Range | null>(null);
  const [selectedNight, setSelectedNight] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherMap>({});

  // Nothing is fetched in the clear: the catalogue arrives only through the
  // vault, after Home has unlocked it. A reload in the same tab session still
  // holds the key, so open the vault quietly and the next Enter will not prompt.
  useEffect(() => {
    if (hasSession()) resume().catch(() => {});
  }, []);

  const enter = useCallback((x: number, y: number) => {
    const b = getBundle();
    if (!b) return;                       // Home only calls this after a successful unlock
    setCat(visibleCatalog(b.catalog));
    setWeather(b.weather as WeatherMap);
    setWash((w) => w ?? { x, y });
  }, []);

  const open = useCallback((t: Track) => { setDetail(t); }, []);
  const close = useCallback(() => setDetail(null), []);

  // Picking a song, artist or person from anywhere jumps to the timeline with
  // its nights lit. That is the point of having a timeline at all.
  const onTrace = useCallback((t: Trace) => {
    setTrace(t); setDetail(null); setView("timeline");
  }, []);

  // Plan and Resolve stay built but are off the menu for now.
  const leftTabs: [View, string][] = [["search", "Search"], ["timeline", "Timeline"]];
  const rightTabs: [View, string][] = [["browse", "Browse"], ["insights", "Insights"]];
  const pick = (v: View) => { setView(v); setDetail(null); setEmerge(false); };

  return (
    <>
      <Starfield />
      <div className="vignette" />
      <div className="shell">
        <header className={`topbar${view === "home" ? " is-home" : ""}`}>
          {cat ? <TabRail items={leftTabs} view={view} dimmed={!!detail} side="left" onPick={pick} /> : <span />}
          <Logo onHome={() => { setView("home"); setDetail(null); setEmerge(false); }} />
          {cat ? <TabRail items={rightTabs} view={view} dimmed={!!detail} side="right" onPick={pick} /> : <span />}
        </header>

        <div className={`scroll${view === "home" ? " is-home" : ""}`}>
          <div className={emerge ? "emerge" : undefined}>
          {!cat || (view === "home" && !detail) ? (
            <Home leaving={wash !== null} onEnter={enter}
              onSkip={() => { if (cat) { setView("search"); setEmerge(false); } }} />
          ) : detail ? <TrackDetail track={detail} cat={cat} onClose={close} onTrace={onTrace} />
            : view === "search" ? <SongSearch cat={cat} onOpen={open} onTrace={onTrace} />
            : view === "timeline" ? (
              <div className="page wide">
                <h1>The decade</h1>
                <p className="sub">
                  Every night at its real date — the gaps are as much the story as the
                  clusters. Height is how long the night ran; the lanes show who was there.
                </p>
                <div className={`tlgrid${selectedNight ? " with-panel" : ""}`}>
                  <div className="tlmain">
                    <Timeline
                      cat={cat} trace={trace}
                      onClearTrace={() => setTrace(null)}
                      selected={selectedNight} onSelect={setSelectedNight}
                      range={range} onRange={setRange}
                      onInsights={() => setView("insights")}
                    />
                    {trace && <TraceList cat={cat} trace={trace} onOpen={open} />}
                  </div>
                  {selectedNight && (
                    <NightPanel
                      cat={cat} eventId={selectedNight}
                      onClose={() => setSelectedNight(null)}
                      onOpenTrack={open}
                      onOpenNight={(id) => { setEventId(id); setView("browse"); }}
                      onPerson={(pid) => {
                        const p = cat.people.find((x) => x.id === pid);
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
            )
            : view === "browse" ? (
              <BrowseView cat={cat} weather={weather} onOpen={open}
                eventId={eventId} setEventId={setEventId} />
            )
            : view === "insights" ? (
              <Insights cat={cat} range={range} onRange={setRange} onTrace={onTrace}
                onOpenNight={(id) => { setEventId(id); setView("browse"); }} />
            )
            : view === "plan" ? (
              <Planner cat={cat} range={range} onRange={setRange} onTrace={onTrace}
                onOpenNight={(id) => { setEventId(id); setView("browse"); }} />
            )
            : <Resolver cat={cat} />}
          </div>
        </div>
      </div>
      {wash && (
        <Wash x={wash.x} y={wash.y} reduced={prefersReducedMotion()}
          onPeak={() => { setView("search"); setDetail(null); setEmerge(true); }}
          onDone={() => setWash(null)} />
      )}
    </>
  );
}
