/** Search, one row per song.
 *
 *  The same song on eight nights used to be eight identical rows. Here it is one
 *  row that says "8 nights"; click it and each play unfolds beneath, one line
 *  per night. The filters ask the questions this library is actually asked:
 *  whose, when, and what kind of night.
 */
import { useMemo, useState } from "react";
import type { Catalog, Track } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import { buildIndex, search, highlight } from "./search.ts";
import { isShown } from "./config.ts";

const MAX_GROUPS = 200;

interface Group {
  key: string;
  songId: string | null;
  title: string;
  artist: string | null;
  variants: string[];
  tracks: Track[];            // every play that survived the filters
  nights: number;
}

const fmtDur = (s: number | null) => {
  if (!s) return "";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
};

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" }) : "undated";

function Marked({ value, query }: { value: string; query: string }) {
  if (!query.trim()) return <>{value}</>;
  return (
    <>{highlight(value, query).map(([part, hit], i) =>
      hit ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>)}</>
  );
}

export default function SongSearch({ cat, onOpen, onTrace }: {
  cat: Catalog;
  onOpen: (t: Track) => void;
  onTrace: (t: Trace) => void;
}) {
  const [query, setQuery] = useState("");
  const [includeAnon, setIncludeAnon] = useState(false);
  const [personId, setPersonId] = useState("");
  const [year, setYear] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const index = useMemo(() => buildIndex(cat), [cat]);
  const events = useMemo(() => new Map(cat.events.map((e) => [e.id, e])), [cat]);
  const songs = useMemo(() => new Map(cat.songs.map((s) => [s.id, s])), [cat]);
  const peopleName = useMemo(
    () => new Map(cat.people.map((p) => [p.id, p.name])), [cat]);

  const years = useMemo(() => [...new Set(
    cat.events.filter((e) => isShown(e) && e.date)
      .map((e) => e.date!.slice(0, 4)))].sort(), [cat]);
  const types = useMemo(() => [...new Set(
    cat.events.flatMap((e) => e.types))].sort(), [cat]);

  const q = query.trim();

  const { groups, plays } = useMemo(() => {
    // Searching ranks tracks; an empty query takes everything, so the landing
    // page can lead with what the library plays most.
    const hits = search(index, query, {
      includeAnon, personId: personId || null, limit: q ? 3000 : 20000,
    });
    const by = new Map<string, Group>();
    let count = 0;
    for (const h of hits) {
      const t = h.track;
      const ev = events.get(t.eventId);
      if (year && ev?.date?.slice(0, 4) !== year) continue;
      if (type && !ev?.types.includes(type)) continue;
      count++;
      const key = t.songId ?? `t:${t.id}`;
      let g = by.get(key);
      if (!g) {
        const song = t.songId ? songs.get(t.songId) : undefined;
        g = {
          key, songId: t.songId,
          title: song?.title ?? t.title ?? "(untitled)",
          artist: song?.artist ?? t.artist,
          variants: song?.variants ?? [],
          tracks: [], nights: 0,
        };
        by.set(key, g);
      }
      g.tracks.push(t);
    }
    const list = [...by.values()];
    for (const g of list) {
      g.nights = new Set(g.tracks.map((t) => t.eventId)).size;
      // Newest play first: that is the one people are usually after.
      g.tracks.sort((a, b) =>
        (events.get(b.eventId)?.date ?? "").localeCompare(events.get(a.eventId)?.date ?? ""));
    }
    // Searching keeps the ranking the scorer gave (insertion order is rank
    // order). With no query, the canon leads.
    if (!q) list.sort((a, b) => b.nights - a.nights || b.tracks.length - a.tracks.length);
    return { groups: list, plays: count };
  }, [index, query, q, includeAnon, personId, year, type, events, songs]);

  const shown = groups.slice(0, MAX_GROUPS);
  const filtered = !!(personId || year || type);

  return (
    <div className="page">
      <h1>Search the collection</h1>
      <p className="sub">
        {cat.stats.songs.toLocaleString()} songs · {cat.stats.artists.toLocaleString()} artists ·
        {" "}{cat.events.filter(isShown).length} nights spanning{" "}
        {cat.events.find((e) => e.date)?.date?.slice(0, 4)}–
        {cat.events.filter((e) => e.date).slice(-1)[0]?.date?.slice(0, 4)}
      </p>

      <div className="searchwrap">
        <span className="searchicon">⌕</span>
        <input
          className="searchbox"
          placeholder="Song, artist, album, person or event…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(null); }}
          autoFocus
          spellCheck={false}
        />
      </div>

      <div className="filters">
        <select aria-label="Brought by" value={personId}
          onChange={(e) => { setPersonId(e.target.value); setOpen(null); }}>
          <option value="">Anyone</option>
          {cat.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Year" value={year}
          onChange={(e) => { setYear(e.target.value); setOpen(null); }}>
          <option value="">Any year</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select aria-label="Kind of night" value={type}
          onChange={(e) => { setType(e.target.value); setOpen(null); }}>
          <option value="">Any night</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {filtered && (
          <button className="tl-clear" style={{ marginLeft: 0 }}
            onClick={() => { setPersonId(""); setYear(""); setType(""); setOpen(null); }}>
            clear filters
          </button>
        )}
        <label>
          <input type="checkbox" checked={includeAnon}
            onChange={(e) => setIncludeAnon(e.target.checked)} />
          Include anonymised ({cat.stats.anonTracks})
        </label>
        <span style={{ marginLeft: "auto" }}>
          {q || filtered
            ? `${groups.length}${groups.length > MAX_GROUPS ? "" : ""} song${groups.length === 1 ? "" : "s"} · ${plays} play${plays === 1 ? "" : "s"}`
            : "most played first · start typing to search"}
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <div className="big">◌</div>
          <div>{q ? <>Nothing matches “{q}”.</> : "Nothing matches those filters."}</div>
          {!includeAnon && cat.stats.anonTracks > 0 && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              {cat.stats.anonTracks} anonymised tracks are hidden — try enabling them.
            </div>
          )}
        </div>
      ) : (
        <div className="rows">
          {shown.map((g) => {
            const isOpen = open === g.key;
            const people = [...new Set(g.tracks.map((t) => t.personId).filter(Boolean))]
              .map((id) => peopleName.get(id!) ?? "").filter(Boolean);
            const dates = g.tracks.map((t) => events.get(t.eventId)?.date).filter(Boolean) as string[];
            dates.sort();
            const span = dates.length
              ? (dates[0].slice(0, 4) === dates[dates.length - 1].slice(0, 4)
                ? dates[0].slice(0, 4)
                : `${dates[0].slice(0, 4)}–${dates[dates.length - 1].slice(2, 4)}`)
              : "";
            const solo = g.tracks.length === 1;
            return (
              <div key={g.key} className={`songgroup${isOpen ? " open" : ""}`}>
                <button className="row" aria-expanded={isOpen}
                  onClick={() => solo ? onOpen(g.tracks[0]) : setOpen(isOpen ? null : g.key)}>
                  <div className="t">
                    <Marked value={g.title} query={q} />
                    {g.variants.slice(0, 2).map((v) => (
                      <span key={v} className="chip variant">{v}</span>
                    ))}
                    {g.nights > 1 && (
                      <span className="chip recurs" title={`Played on ${g.nights} nights`}>
                        {g.nights} nights
                      </span>
                    )}
                    {g.tracks.some((t) => t.flags.includes("anon")) && (
                      <span className="chip anon">anon</span>
                    )}
                  </div>
                  <div className="a"><Marked value={g.artist ?? "—"} query={q} /></div>
                  <div className="p">
                    {people.length
                      ? people.slice(0, 2).join(", ") + (people.length > 2 ? ` +${people.length - 2}` : "")
                      : <span style={{ opacity: 0.45 }}>unknown</span>}
                  </div>
                  <div className="d">{span}</div>
                </button>

                {isOpen && (
                  <div className="plays">
                    {g.tracks.map((t) => {
                      const ev = events.get(t.eventId);
                      const person = t.personId ? peopleName.get(t.personId) : null;
                      return (
                        <button key={t.id} className="play" onClick={() => onOpen(t)}>
                          <span className="when">{ev?.kind === "collection" ? "collection" : fmtDate(ev?.date)}</span>
                          <span className="what">
                            {ev?.title || ev?.types.join(" + ") || ev?.folder}
                          </span>
                          <span className="who">{person ?? "unknown"}</span>
                          <span className="len">{fmtDur(t.durationSec)}</span>
                        </button>
                      );
                    })}
                    {g.songId && g.nights > 1 && (
                      <button className="play trace" onClick={() => {
                        const s = songs.get(g.songId!)!;
                        onTrace({
                          kind: "song", id: s.id, label: `${s.artist} — ${s.title}`,
                          nights: new Set(s.nights),
                        });
                      }}>
                        show these nights on the timeline →
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {groups.length > MAX_GROUPS && (
            <div className="empty" style={{ padding: "18px 0", fontSize: 13 }}>
              Showing the first {MAX_GROUPS} of {groups.length} songs — narrow it with a filter.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
