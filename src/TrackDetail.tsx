import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { Catalog, Track } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import { catalogIndex } from "./catalogIndex.ts";
import Cover from "./Cover.tsx";
import { coverUrlOf, type EnrichMap } from "./enrich.ts";
import { familyColour } from "./families.ts";
import { buildWall } from "./musicstats.ts";
import {
  gapSentence, hasFacts, moreFromArtist, neighbours, notFoundLine, poolOf, sourceNote, songFacts,
  type PoolSong,
} from "./songfacts.ts";
import { fmtDur } from "./format.ts";
import { copyText, spotifyUrl } from "./pagehelpers.ts";
import { personColour, TYPE_COLOUR } from "./colours.ts";
import { formatRoute } from "./route.ts";
import { useToast } from "./Toast.tsx";
import {
  artistHistory, dayMonthYear, joinNames, monthYear, songHistory, summaryText, verdictSentence,
  type Mark, type Stats,
} from "./songstats.ts";
import "./detail.css";

const FIRST_ROWS = 8;
const DAY_MS = 86400000;
const dayMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

const BUCKET_WORDS: Record<string, string> = {
  early: "early in a set", peak: "at the peak", late: "late in a set", afterglow: "in the afterglow",
  other: "in a slot with no clear place",
};

/** One track: what the library knows about the song and artist, and where
 *  each field of this file came from. `onOpenNight` / `onOpenTrack` are optional;
 *  without them the links fall back to the hash routes (#/night/.., #/song/..). */
export default function TrackDetail({ track, cat, enrich = null, onClose, onTrace, onOpenNight, onOpenTrack, onOpenArtist, onOpenPerson }: {
  track: Track; cat: Catalog;
  /** Public-database facts; null when none shipped. Partial by nature. */
  enrich?: EnrichMap | null;
  onClose: () => void; onTrace: (t: Trace) => void;
  onOpenNight?: (eventId: string) => void;
  onOpenTrack?: (t: Track) => void;
  /** Open the artist on the Music page / a person on the People page. */
  onOpenArtist?: (artistId: string) => void;
  onOpenPerson?: (personId: string) => void;
}) {
  const ix = catalogIndex(cat);
  const { toast, node: toastNode } = useToast();
  const [showAll, setShowAll] = useState(false);

  const person = track.personId ? ix.person.get(track.personId) : undefined;
  const ev = ix.event.get(track.eventId);
  const phase = track.phaseId ? ix.phase.get(track.phaseId) : undefined;
  const twin = track.twinId ? ix.track.get(track.twinId) : undefined;
  const sid = track.songId ?? twin?.songId ?? null;
  const artistId = sid ? sid.split("|")[0] : null;

  const sh = useMemo(() => (sid ? songHistory(cat, sid) : null), [cat, sid]);
  const ah = useMemo(() => (artistId ? artistHistory(cat, artistId) : null), [cat, artistId]);

  const title = track.title ?? twin?.title ?? null;
  const artistName = track.artist ?? twin?.artist ?? null;
  const via = (f: string) => <span className="prov">via {track.provenance[f] ?? "unknown"}</span>;

  const traceSong = () => {
    if (!sh) return;
    onTrace({
      kind: "song", id: sh.songId, label: `${sh.artist} — ${sh.title}`,
      nights: new Set(sh.nightList.map((n) => n.eventId)),
    });
  };
  const traceArtist = () => {
    if (!ah || !ah.nights) return;
    onTrace({
      kind: "artist", id: ah.artistId, label: ah.name,
      nights: new Set(ah.nightList.map((n) => n.eventId)),
    });
  };

  const copySummary = async () => {
    if (!sh) return;
    let text = summaryText(`${sh.artist} — ${sh.title}`, sh);
    if (ah && ah.songCount > 1) text += `\n\nArtist, ${ah.name}: ${verdictSentence(ah)}`;
    toast((await copyText(text)) ? "Copied the history" : "Could not copy");
  };

  const plain = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  const nightLink = (id: string, children: ReactNode, className?: string) => (
    <a className={className} href={formatRoute({ name: "night", id })}
      onClick={onOpenNight ? (e) => { if (plain(e)) { e.preventDefault(); onOpenNight(id); } } : undefined}>
      {children}
    </a>
  );
  const trackLink = (id: string, children: ReactNode, className?: string) => {
    const t = ix.track.get(id);
    return (
      <a className={className} href={formatRoute({ name: "song", id })}
        onClick={onOpenTrack && t ? (e) => { if (plain(e)) { e.preventDefault(); onOpenTrack(t); } } : undefined}>
        {children}
      </a>
    );
  };

  const artistLink = (children: ReactNode) => (
    <a className="dt-link" href={formatRoute({ name: "music", id: artistId })}
      onClick={onOpenArtist && artistId ? (e) => { if (plain(e)) { e.preventDefault(); onOpenArtist(artistId); } } : undefined}>
      {children}
    </a>
  );
  const personLink = (children: ReactNode) => person ? (
    <a className="dt-link" href={formatRoute({ name: "people", id: person.id })}
      onClick={onOpenPerson ? (e) => { if (plain(e)) { e.preventDefault(); onOpenPerson(person.id); } } : undefined}>
      {children}
    </a>
  ) : children;
  const hasArtistPage = !!artistId && ix.artist.has(artistId);

  const played = sh && sh.nights > 0;

  // ---- enrichment (every piece is optional: null enrich, no record, no match)
  const rec = enrich && sid ? enrich[sid] : undefined;
  const facts = songFacts(rec);
  const coverUrl = coverUrlOf(rec);
  const gap = played ? gapSentence(facts.year, +sh.first!.date.slice(0, 4)) : null;
  const notFound = sid ? notFoundLine(enrich, rec) : null;
  const srcNote = sourceNote(rec);
  const wall = useMemo(() => buildWall(cat), [cat]);
  const pool = useMemo<PoolSong[]>(() => poolOf(wall.songs, enrich), [wall, enrich]);
  const alike = useMemo(
    () => (sid ? neighbours({ songId: sid, year: facts.year, family: facts.family }, pool) : null),
    [sid, facts.year, facts.family, pool],
  );
  const sameArtist = useMemo(
    () => (sid && artistId ? moreFromArtist(sid, pool.filter((s) => s.artistId === artistId)) : []),
    [sid, artistId, pool],
  );
  /** A track to open for each song (prefer one that was brought to a night). */
  const openable = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of cat.tracks) {
      if (!t.songId) continue;
      const cur = m.get(t.songId);
      if (!cur || (!cur.played && t.played)) m.set(t.songId, t);
    }
    return m;
  }, [cat]);
  const simRows = (songs: PoolSong[]) => (
    <ul className="dt-sim">
      {songs.map((s) => {
        const t = openable.get(s.songId);
        if (!t) return null;
        const f = enrich?.[s.songId];
        return (
          <li key={s.songId}>
            {trackLink(t.id, (
              <>
                <Cover songId={s.songId} title={s.title} artist={s.artist} url={coverUrlOf(f)} size={40} />
                <span className="dt-simtext"><b>{s.title}</b><span>{s.artist || "unknown artist"}</span></span>
                <span className="dt-simn">×{s.nights} {s.nights === 1 ? "night" : "nights"}</span>
              </>
            ), "dt-simrow")}
          </li>
        );
      })}
    </ul>
  );
  const spot = spotifyUrl(track.spotifyUri);
  const q = track.audio;

  return (
    <div className="page detail-page">
      <button className="backlink" onClick={onClose}>← back</button>

      <header className="panel dt-head">
        <div className="dt-headrow">
          {sid && <Cover songId={sid} title={title ?? "?"} artist={artistName ?? undefined} url={coverUrl} size={112} />}
          <div>
        <h1>{title ?? "(untitled)"}</h1>
        <p className="dt-artist">
          {artistName && hasArtistPage
            ? (
              <>
                {artistLink(artistName)}
                {ah && ah.nights > 0 && (
                  <> <button className="dt-linkbtn" onClick={traceArtist} title="Show this artist on the timeline">on timeline</button></>
                )}
              </>
            )
            : artistName && ah && ah.nights > 0
              ? <button className="dt-linkbtn" onClick={traceArtist} title="Show this artist on the timeline">{artistName}</button>
              : <span>{artistName ?? "unknown artist"}</span>}
          {person && <span className="dt-by"> · brought by {personLink(person.name)}</span>}
        </p>

        {hasFacts(facts) ? (
          <p className="dt-factsline">
            {facts.year !== null && <span>released {facts.year}</span>}
            {facts.family && (
              <span><i className="dt-fam" style={{ background: familyColour(facts.family) }} />{facts.familyName}</span>
            )}
            {facts.country && <span>{facts.country}</span>}
          </p>
        ) : notFound && <p className="dt-quiet">{notFound}</p>}
          </div>
        </div>

        <p className="dt-verdict" data-verdict={sh?.verdict ?? "unknown"}>
          {sh
            ? verdictSentence(sh)
            : "No song identity: this file could not be matched to a known song, so there is no history to show."}
        </p>

        <div className="dt-chips">
          {played && (
            <>
              <span className="dt-chip">{sh.nights} {sh.nights === 1 ? "night" : "nights"}</span>
              <span className="dt-chip">{sh.people.length} {sh.people.length === 1 ? "person" : "people"}</span>
              <span className="dt-chip">first {sh.first!.date.slice(0, 4)}</span>
              <span className="dt-chip">last {monthYear(sh.last!.date)}</span>
              {sh.recent && <span className="dt-chip dt-recent">recent</span>}
            </>
          )}
          {track.variant && <span className="dt-chip dt-flag">{track.variant}</span>}
          {track.flags.includes("anon") && <span className="dt-chip dt-flag">anonymised copy</span>}
          {track.flags.includes("video") && <span className="dt-chip dt-flag">video</span>}
          {track.flags.includes("album") && <span className="dt-chip dt-flag">album</span>}
        </div>

        <div className="dt-actions">
          {played && <button className="dt-btn" onClick={traceSong}>Show on timeline</button>}
          {sh && <button className="dt-btn" onClick={copySummary}>Copy summary</button>}
          {spot && <a className="dt-btn" href={spot} target="_blank" rel="noreferrer">Open in Spotify ↗</a>}
        </div>
        {srcNote && <p className="dt-quiet">{srcNote}</p>}
      </header>

      {sh && !played && (
        <section className="panel dt-card dt-shelf" aria-label="History">
          <h2>Never brought to a night</h2>
          <p>
            {sh.shelfTracks > 0
              ? `Only on a shelf: ${sh.shelfTracks === 1 ? "one copy sits" : `${sh.shelfTracks} copies sit`} in a collection (favs, a mix or an album pile), so nobody has brought it to a dated night.`
              : "No dated night has this song."}
          </p>
        </section>
      )}

      {played && (
        <div className="dt-grid">
          <section className="panel dt-card" aria-labelledby="dt-fl">
            <h2 id="dt-fl">First &amp; last</h2>
            {sh.nights === 1
              ? <div className="dt-facts"><Fact label={sh.plays > 1 ? "The one night" : "Brought once"} m={sh.first!} nightLink={nightLink} /></div>
              : (
                <div className="dt-facts">
                  <Fact label="First brought" m={sh.first!} nightLink={nightLink} />
                  <Fact label="Last brought" m={sh.last!} nightLink={nightLink}
                    note={sh.sinceLast
                      ? sh.sinceLast.days === 0 ? "on the newest night in the library"
                        : `${sh.sinceLast.label} before the newest night in the library`
                      : undefined} />
                </div>
              )}
            {gap && <p className="dt-note">{gap[0].toUpperCase() + gap.slice(1)}.</p>}
          </section>

          <section className="panel dt-card" aria-labelledby="dt-who">
            <h2 id="dt-who">Who brings it</h2>
            <ul className="dt-people">
              {sh.people.map((p) => (
                <li key={p.personId}>
                  <span className="dt-pname">
                    <i className="dt-dot" style={{ background: p.index >= 0 ? personColour(p.index) : "var(--ink-faint)" }} />
                    {p.name}
                  </span>
                  <span className="dt-bar"><b style={{
                    width: `${(p.plays / sh.people[0].plays) * 100}%`,
                    background: p.index >= 0 ? personColour(p.index) : "var(--ink-faint)",
                  }} /></span>
                  <span className="dt-n">{p.plays}×</span>
                </li>
              ))}
              {sh.unknownPlays > 0 && (
                <li><span className="dt-pname dt-faint">unknown contributor</span><span /><span className="dt-n">{sh.unknownPlays}×</span></li>
              )}
            </ul>
            {sh.signature && (
              <p className="dt-note">{sh.signature.name}'s song: {sh.signature.plays} of {sh.plays} plays are theirs.</p>
            )}
          </section>

          <section className="panel dt-card dt-wide" aria-labelledby="dt-when">
            <h2 id="dt-when">When</h2>
            <YearStrip h={sh} />
            <ul className="dt-gaps">
              {sh.longestGap && (
                <li>Longest gap: <b>{sh.longestGap.label}</b>, {monthYear(sh.longestGap.from)} to {monthYear(sh.longestGap.to)}</li>
              )}
              {sh.sinceLast && (
                <li>Since the last play: <b>{sh.sinceLast.days === 0 ? "none, it was on the newest night" : sh.sinceLast.label}</b>
                  <span className="dt-faint"> (to the newest night in the library, {sh.asOf ? monthYear(sh.asOf) : ""})</span></li>
              )}
              {sh.nights === 1 && <li>Only played once.</li>}
            </ul>
          </section>

          {sh.phases.total >= 3 && (
            <section className="panel dt-card" aria-labelledby="dt-ph">
              <h2 id="dt-ph">Where it lands in a set</h2>
              {sh.phases.dominant && (
                <p className="dt-lede">
                  Usually {BUCKET_WORDS[sh.phases.dominant]}: {sh.phases[sh.phases.dominant]} of {sh.phases.total} sets.
                </p>
              )}
              {!sh.phases.dominant && <p className="dt-lede">No one slot: it turns up all over.</p>}
              <ul className="dt-people">
                {(["early", "peak", "late", "afterglow", "other"] as const)
                  .filter((b) => b !== "other" || sh.phases.other > 0).map((b) => (
                    <li key={b}>
                      <span className="dt-pname">{b}</span>
                      <span className="dt-bar"><b style={{ width: `${(sh.phases[b] / sh.phases.total) * 100}%` }} /></span>
                      <span className="dt-n">{sh.phases[b]}</span>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          <section className="panel dt-card dt-wide" aria-labelledby="dt-all">
            <h2 id="dt-all">Every time it was brought</h2>
            <ol className="dt-list">
              {(showAll ? sh.occurrences : sh.occurrences.slice(0, FIRST_ROWS)).map((o) => {
                const idx = o.personId ? cat.people.findIndex((p) => p.id === o.personId) : -1;
                return (
                  <li key={o.trackId}>
                    {nightLink(o.eventId, (
                      <>
                        <span className="dt-date">{dayMonthYear(o.date)}</span>
                        <span className="dt-types">{o.types.map((t) => (
                          <span key={t} className="dt-chip dt-type" style={{ color: TYPE_COLOUR[t] ?? "var(--accent)" }}>{t}</span>
                        ))}</span>
                        <span className="dt-who">
                          {o.person
                            ? <><i className="dt-dot" style={{ background: idx >= 0 ? personColour(idx) : "var(--ink-faint)" }} />{o.person}</>
                            : <span className="dt-faint">unknown</span>}
                        </span>
                        <span className="dt-phase">{o.phase ? `${o.phase}${o.bucket && o.bucket !== "other" ? ` (${o.bucket})` : ""}` : ""}</span>
                        <span className="dt-pos">
                          {o.playOrder !== null ? `#${o.playOrder}` : ""}
                          {o.variant ? <span className="dt-chip dt-flag">{o.variant}</span> : null}
                        </span>
                      </>
                    ), "dt-row")}
                  </li>
                );
              })}
            </ol>
            {sh.occurrences.length > FIRST_ROWS && (
              <button className="dt-btn" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${sh.occurrences.length}`}
              </button>
            )}
          </section>

          {sh.variants.length > 0 && (
            <section className="panel dt-card" aria-labelledby="dt-var">
              <h2 id="dt-var">Other versions</h2>
              <ul className="dt-simple">
                {sh.variants.map((v) => (
                  <li key={v.variant ?? "plain"}>
                    {trackLink(v.trackId, <b>{v.variant ?? "Original"}</b>, "dt-link")}
                    <span className="dt-faint">
                      {" "}{v.plays}× on {v.nights} {v.nights === 1 ? "night" : "nights"},{" "}
                      {v.first === v.last ? monthYear(v.first) : `${monthYear(v.first)} to ${monthYear(v.last)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {ah && ah.songCount > 1 && (
            <section className="panel dt-card dt-wide" aria-labelledby="dt-art">
              <h2 id="dt-art">More by {ah.name}</h2>
              <p className="dt-lede">{verdictSentence(ah)}</p>
              {ah.signature && (
                <p className="dt-note">{ah.signature.name}'s artist: {ah.signature.plays} of {ah.plays} plays are theirs.</p>
              )}
              {ah.first && ah.last && ah.nights > 1 && (
                <p className="dt-note">
                  First {nightLink(ah.first.eventId, dayMonthYear(ah.first.date), "dt-link")}
                  {ah.first.nightPeople.length ? ` (${joinNames(ah.first.nightPeople)})` : ""}
                  {" · "}last {nightLink(ah.last.eventId, dayMonthYear(ah.last.date), "dt-link")}
                  {ah.last.nightPeople.length ? ` (${joinNames(ah.last.nightPeople)})` : ""}
                </p>
              )}
              <ul className="dt-songs">
                {ah.songs.filter((s) => s.songId !== sid).slice(0, 6).map((s) => (
                  <li key={s.songId}>
                    {trackLink(s.trackId, s.title, "dt-link")}
                    <span className="dt-faint">{s.nights} {s.nights === 1 ? "night" : "nights"}, last {monthYear(s.last)}</span>
                  </li>
                ))}
              </ul>
              <p className="dt-note">
                {ah.songCount} songs brought in all.{" "}
                <button className="dt-linkbtn" onClick={traceArtist}>Show {ah.name} on the timeline →</button>
              </p>
            </section>
          )}
        </div>
      )}

      {(alike || sameArtist.length > 0) && (
        <div className="dt-grid">
          {alike && (
            <section className="panel dt-card" aria-labelledby="dt-like">
              <h2 id="dt-like">Sounds like this</h2>
              <p className="dt-sub">Also in the library: {alike.label}. Least-brought first.</p>
              {simRows(alike.songs)}
            </section>
          )}
          {sameArtist.length > 0 && (
            <section className="panel dt-card" aria-labelledby="dt-more">
              <h2 id="dt-more">More from this artist</h2>
              <p className="dt-sub">Also in the library, by {artistName ?? "the same artist"}.</p>
              {simRows(sameArtist)}
            </section>
          )}
        </div>
      )}

      <details className="panel dt-card dt-file" open={!sh}>
        <summary>This file</summary>
        <dl>
          <dt>Artist</dt><dd>{track.artist ?? "—"}{via("artist")}</dd>
          <dt>Title</dt><dd>{track.title ?? "—"}{via("title")}</dd>
          {track.album && <><dt>Album</dt><dd>{track.album}</dd></>}
          <dt>Brought by</dt><dd>{person ? personLink(person.name) : "unknown"}{via("person")}</dd>
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
          <dt>Event</dt>
          <dd>
            {ev?.date ? dayMonthYear(ev.date) : "undated"} · {ev?.folder}{via("event")}
            {ev?.kind === "event" && <> {nightLink(ev.id, "open the night →", "dt-link")}</>}
          </dd>
          {phase && <><dt>Phase</dt><dd>{phase.clean} ({phase.bucket})
            {phase.minutes ? ` · ${phase.minutes} min` : ""}{via("phase")}</dd></>}
          <dt>Length</dt><dd>{fmtDur(track.durationSec) || "—"}</dd>
          {track.source === "spotify"
            ? <><dt>From</dt><dd>a Spotify playlist export — no file in the library</dd></>
            : (
              <>
                <dt>File</dt><dd>{track.ext} · {(track.sizeBytes / 1e6).toFixed(1)} MB</dd>
                {q && (
                  <>
                    <dt>Quality</dt>
                    <dd>
                      {q.format.toUpperCase()}
                      {q.lossless ? " · lossless" : q.kbps ? ` · ${q.kbps} kbps` : ""}
                      {q.sampleRate ? ` · ${(q.sampleRate / 1000).toFixed(q.sampleRate % 1000 ? 1 : 0)} kHz` : ""}
                      {q.bits ? ` · ${q.bits}-bit` : ""}
                    </dd>
                  </>
                )}
                <dt>Path</dt><dd><code>{track.path.join(" / ")}</code></dd>
              </>
            )}
          {spot && <><dt>Spotify</dt><dd><a href={spot} target="_blank" rel="noreferrer">open in Spotify ↗</a></dd></>}
        </dl>
      </details>
      {toastNode}
    </div>
  );
}

function Fact({ label, m, note, nightLink }: {
  label: string; m: Mark; note?: string;
  nightLink: (id: string, children: ReactNode, className?: string) => ReactNode;
}) {
  return (
    <div className="dt-fact">
      <div className="dt-fl">{label}</div>
      <div className="dt-big">{nightLink(m.eventId, dayMonthYear(m.date), "dt-link")}</div>
      <div className="dt-who">
        {m.nightPeople.length ? `by ${joinNames(m.nightPeople)}` : "by someone unknown"}
        {m.types.map((t) => (
          <span key={t} className="dt-chip dt-type" style={{ color: TYPE_COLOUR[t] ?? "var(--accent)" }}>{t}</span>
        ))}
      </div>
      {note && <div className="dt-faint">{note}</div>}
    </div>
  );
}

/** Plays per year as bars, with a tick for each night underneath. */
function YearStrip({ h }: { h: Stats }) {
  const max = Math.max(1, ...h.years.map((y) => y.plays));
  const step = Math.ceil(h.years.length / 10);
  const t0 = dayMs(`${h.years[0].year}-01-01`);
  const span = dayMs(`${h.years[h.years.length - 1].year}-12-31`) - t0 + DAY_MS;
  const summary = h.years.filter((y) => y.plays).map((y) => `${y.year}: ${y.plays}`).join(", ");
  return (
    <div role="img" aria-label={`Plays per year. ${summary}`} className="dt-strip">
      <div className="dt-bars">
        {h.years.map((y) => (
          <div key={y.year} className="dt-col" title={`${y.year}: ${y.plays} ${y.plays === 1 ? "play" : "plays"}`}>
            <b style={{ height: `${y.plays ? Math.max(6, (y.plays / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="dt-ticks">
        {h.nightList.map((n) => (
          <i key={n.eventId} style={{ left: `${((dayMs(n.date) - t0) / span) * 100}%` }} />
        ))}
      </div>
      <div className="dt-years">
        {h.years.map((y, i) => <span key={y.year}>{i % step === 0 ? y.year : ""}</span>)}
      </div>
    </div>
  );
}
