/** One night, in full: a sticky bar to move between nights and jump between
 *  people, the night's totals and sky, then each person's set with the numbers
 *  that say how their phases divide their time. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Catalog, Event, Track } from "./catalog.ts";
import { TYPE_COLOUR, personColour } from "./colours.ts";
import { nightStats, type PersonStat } from "./nightstats.ts";
import { byPlayOrder, Flags } from "./rows.tsx";
import Sky from "./Sky.tsx";
import type { WeatherMap } from "./weather.ts";
import { fmtCount, fmtDate as short, fmtDateLong as long, fmtHours, fmtSpan, pct, plural } from "./format.ts";
import { copyText, scrollRootOf, sectionAt, setlistText, splitSet } from "./pagehelpers.ts";
import { useToast } from "./Toast.tsx";
import { ChevronIcon, CopyIcon } from "./icons.tsx";
import { coverageLine, factLines, soundOf, worthShowing, type Sound } from "./nightsound.ts";
import { familyColour, familyLabel } from "./families.ts";
import { coverUrlOf, type EnrichMap } from "./enrich.ts";
import Cover from "./Cover.tsx";
import SongLinks, { CellText } from "./SongLinks.tsx";
import ColumnsMenu, { useColumnChoice, useViewportWidth } from "./ColumnsMenu.tsx";
import { gridTemplate, songFactsFor, sortRows, visibleColumns, type Column } from "./songcols.ts";
import { nightColumns, rowView } from "./nightlist.ts";
import { useSessionState } from "./hooks.ts";
import { requestPlay } from "./radio.ts";
import { fmtClock, MAPPING_RULE, simText, simulateNight, type Sim, type SimBlock, type SimRow } from "./nightsim.ts";
import "./pages.css";
import "./nightsound.css";
import "./nightlist.css";
import "./nightsim.css";

const hue = (id: string, salt: number) => {
  let h = salt;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
};

/** A cover on a generative base; a failed image just disappears. */
function Tile({ songId, url, title, onClick }: { songId: string; url: string; title: string; onClick?: () => void }) {
  const [bad, setBad] = useState(false);
  const style = { ["--h1" as string]: hue(songId, 7), ["--h2" as string]: hue(songId, 131), ["--ang" as string]: `${hue(songId, 3)}deg` };
  const img = !bad && (
    <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBad(true)} />
  );
  return onClick
    ? <button className="ns-tile" style={style} title={title} aria-label={`Open ${title}`} onClick={onClick}>{img}</button>
    : <span className="ns-tile" style={style} title={title}>{img}</span>;
}

/** One 100% bar of genre families; every segment is also named in `legend`. */
function FamilyBar({ sound, small }: { sound: Sound; small?: boolean }) {
  const total = sound.familyKnown;
  return (
    <div className={`ns-bar${small ? " small" : ""}`} role="img"
      aria-label={`Genre families: ${sound.families.map((f) => `${familyLabel(f.family)} ${f.count}`).join(", ")}`}>
      {sound.families.map((f) => (
        <span key={f.family} tabIndex={small ? undefined : 0}
          data-tip={`${familyLabel(f.family)} · ${plural(f.count, "song")} · ${pct(f.count / total)}`}
          style={{ flexGrow: f.count, background: familyColour(f.family) }} />
      ))}
    </div>
  );
}

function SoundCard({ sound, onOpen }: { sound: Sound; onOpen: (t: Track) => void }) {
  const facts = factLines(sound);
  const peak = Math.max(1, ...sound.decades.map((d) => d.count));
  return (
    <section className="nsound" aria-label="The sound of this night">
      <h2>The sound of this night</h2>
      <p className="ns-cov">{coverageLine(sound)}</p>
      <div className="ns-grid">
        {sound.covers.length > 0 && (
          <div>
            <h3 className="ns-h">Covers</h3>
            <div className="ns-mosaic">
              {sound.covers.map((c) => (
                <Tile key={c.songId} songId={c.songId} url={c.url}
                  title={c.artist ? `${c.title} · ${c.artist}` : c.title} onClick={() => onOpen(c.track)} />
              ))}
            </div>
          </div>
        )}
        <div>
          {sound.families.length > 0 && (
            <>
              <h3 className="ns-h">Genre families · {sound.familyKnown} of {sound.songs} songs</h3>
              <FamilyBar sound={sound} />
              <ul className="ns-legend">
                {sound.families.map((f) => (
                  <li key={f.family} style={{ ["--fc" as string]: familyColour(f.family) }}>
                    <i />{familyLabel(f.family)} <b>{f.count}</b>
                  </li>
                ))}
              </ul>
            </>
          )}
          {sound.decades.length > 0 && (
            <>
              <h3 className="ns-h" style={{ marginTop: 16 }}>Music from these decades · {sound.yearKnown} songs with a known year</h3>
              <div className="ns-decades" role="img"
                aria-label={sound.decades.map((d) => `${d.decade}: ${plural(d.count, "song")}`).join(", ")}>
                {sound.decades.map((d) => (
                  <div key={d.decade} className="ns-dec" title={`${d.decade}: ${plural(d.count, "song")}`}>
                    <b>{d.count}</b>
                    <div className={`col${d.count ? "" : " zero"}`} style={{ height: `${(d.count / peak) * 62}%` }} />
                    <span>{d.decade}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {facts.length > 0 && <ul className="ns-facts">{facts.map((f) => <li key={f}>{f}</li>)}</ul>}
        </div>
      </div>
    </section>
  );
}

/** One track of a playlist, laid out on the shared column grid. The links sit beside
 *  the row, not inside it: an anchor in a button is invalid. */
const NightRow = memo(function NightRow({ track, cat, enrich, cols, twin, onOpen, sim, who }: {
  track: Track; cat: Catalog; enrich: EnrichMap | null; cols: Column<Track>[]; twin?: Track;
  onOpen: (t: Track) => void;
  /** Only in the simulated night: where the row falls on the running clock, and who played it. */
  sim?: SimRow; who?: Who;
}) {
  const info = songFactsFor(cat, enrich, track);
  const view = rowView(track, info, twin);
  const cell = (c: Column<Track>) => {
    switch (c.id) {
      case "cover":
        return <Cover songId={info.songId ?? track.id} title={info.title} url={coverUrlOf(info.songId ? enrich?.[info.songId] : undefined)} size={36} />;
      case "links":
        return null;
      case "clock":
        return sim && sim.startSec !== null
          ? <span title={sim.startApprox ? "Elapsed time at the start; approximate, an earlier song has no known length" : "Elapsed time at the start"}>
              {sim.startApprox ? "~" : ""}{fmtClock(sim.startSec)}
            </span>
          : <CellText value={null} />;
      case "person":
        return who
          ? <span className="sim-who" style={{ ["--pc" as string]: who.colour }} title={who.name}><i />{who.name}</span>
          : null;
      case "duration":
        return sim?.estimated
          ? <span className="sim-est" title="Length unknown: the night's median stands in">~{fmtClock(sim.durSec)}</span>
          : <CellText value={c.text(track)} title={c.title?.(track)} />;
      case "title":
        return (
          <>
            {info.title}
            {track.variant && <span className="chip variant">{track.variant}</span>}
            {info.nights > 1 && <span className="chip recurs" title={`Played on ${info.nights} nights`}>×{info.nights}</span>}
            <Flags track={track} />
          </>
        );
      case "artist":
        return view.twinHint
          ? <span className="twinhint" title="its named twin">{view.twinHint}</span>
          : <CellText value={c.text(track)} />;
      default:
        return <CellText value={c.text(track)} title={c.title?.(track)} />;
    }
  };
  return (
    <div className="sc-rowwrap">
      <button className="row" onClick={() => onOpen(track)}>
        {cols.map((c) => (
          <div key={c.id} className={`sc-c sc-${c.id}${c.align === "right" ? " r" : ""}`}>{cell(c)}</div>
        ))}
      </button>
      {view.linkable && cols.some((c) => c.id === "links") && <SongLinks song={view.linkSource} className="sc-links" />}
    </div>
  );
});

interface Who { name: string; colour: string }

const blockTitle = (b: SimBlock) =>
  b.kind === "loose" ? "Not in a phase: played at an unknown time"
  : b.kind === "whole" ? "Whole night"
  : b.labels.join(" / ") || "Phase";

/** The simulated night's columns: the clock replaces the play number, and a "Who" column follows the artist. */
function simColumns(base: Column<Track>[]): Column<Track>[] {
  const clock: Column<Track> = { id: "clock", label: "Time", width: "56px", align: "right", sortKey: null, locked: true, text: () => null };
  const person: Column<Track> = { id: "person", label: "Who", width: "minmax(0,0.7fr)", align: "left", sortKey: null, text: () => null };
  const out: Column<Track>[] = [];
  for (const c of base) {
    if (c.id === "order") out.push(clock);
    else { out.push(c); if (c.id === "artist") out.push(person); }
  }
  return out;
}

/** One plausible running order, block by block. Memoised: a reshuffle rebuilds it, nothing else does. */
const SimList = memo(function SimList({ sim, cat, enrich, cols, whoOf, onOpen }: {
  sim: Sim; cat: Catalog; enrich: EnrichMap | null; cols: Column<Track>[];
  whoOf: (pid: string) => Who; onOpen: (t: Track) => void;
}) {
  return (
    <>
      {sim.blocks.map((b) => (
        <section key={b.key} className={`sim-block ${b.kind}`}>
          <div className="phasehead sim-head">
            <span className={`name${b.kind === "loose" ? " dimname" : ""}`}>{blockTitle(b)}</span>
            <span className="meta">
              {plural(b.rows.length, "song")} · {fmtClock(b.seconds)}
              {b.estimatedRows > 0 ? ` (${b.estimatedRows} ~)` : ""}
            </span>
            <span className="sim-contrib">
              {b.personIds.map((pid) => {
                const w = whoOf(pid);
                return <span key={pid} className="sim-who" style={{ ["--pc" as string]: w.colour }}><i />{w.name}</span>;
              })}
            </span>
          </div>
          <div className="rows">
            {b.rows.map((r) => (
              <NightRow key={r.track.id} track={r.track} cat={cat} enrich={enrich} cols={cols} onOpen={onOpen}
                sim={r} who={whoOf(r.track.personId ?? "")} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
});

/** Where each night was scrolled to, so coming back from a track lands there. */
const scrollMemory = new Map<string, number>();

const jokeTitle = (e: Event) =>
  e.title && !e.types.includes(e.title.toLowerCase()) ? e.title : "";

const BAR_GAP = 28;   // clearance under the sticky bar when a section is scrolled to

export default function NightPage({ cat, ev, weather, enrich = null, onBack, onGoto, onOpen }: {
  cat: Catalog; ev: Event; weather: WeatherMap; enrich?: EnrichMap | null;
  onBack: () => void; onGoto: (id: string) => void; onOpen: (t: Track) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // People whose set is folded away. CSS does the hiding, so a print still has every set.
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const { toast, node: toastNode } = useToast();
  const [colSort, setColSort] = useSessionState<{ id: string; dir: "asc" | "desc" } | null>("night.colsort", null);
  const [choice, toggleCol, resetCols] = useColumnChoice("night");
  const width = useViewportWidth();
  const [view, setView] = useSessionState<"person" | "sim">("night.view", "person");
  const [seeds, setSeeds] = useSessionState<Record<string, number>>("night.simseed", {});
  const [simChoice, toggleSimCol, resetSimCols] = useColumnChoice("night-sim");
  const seed = seeds[ev.id] ?? 1;
  const pendingJump = useRef<string | null>(null);
  const [barH, setBarH] = useState(96);
  const allCols = useMemo(() => nightColumns((t) => songFactsFor(cat, enrich, t)), [cat, enrich]);
  const cols = useMemo(() => visibleColumns(allCols, choice, width), [allCols, choice, width]);
  const simAll = useMemo(() => simColumns(allCols), [allCols]);
  const simCols = useMemo(() => visibleColumns(simAll, simChoice, width), [simAll, simChoice, width]);
  const sortCol = colSort ? cols.find((c) => c.id === colSort.id && c.sortKey) : undefined;
  const clickHeader = (c: Column<Track>) => {
    if (!c.sortKey) return;
    if (colSort?.id !== c.id) setColSort({ id: c.id, dir: "asc" });
    else if (colSort.dir === "asc") setColSort({ id: c.id, dir: "desc" });
    else setColSort(null);
  };

  // The column header sticks just under the night bar, whatever height that wraps to.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBarH(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trackById = useMemo(() => new Map(cat.tracks.map((t) => [t.id, t])), [cat]);
  const dated = useMemo(
    () => cat.events.filter((e) => e.kind !== "collection" && e.date)
      .sort((a, b) => a.date!.localeCompare(b.date!)), [cat]);
  const at = dated.findIndex((e) => e.id === ev.id);
  const prev = at > 0 ? dated[at - 1] : null;
  const next = at >= 0 && at < dated.length - 1 ? dated[at + 1] : null;

  const { stats, sets, copies } = useMemo(() => {
    const tracks = cat.tracks.filter((t) => t.eventId === ev.id);
    const phases = cat.phases.filter((p) => p.eventId === ev.id);
    const stats = nightStats(tracks, phases);
    const byPerson = new Map<string, Track[]>();
    for (const t of tracks) {
      const k = t.personId ?? "";
      if (!byPerson.has(k)) byPerson.set(k, []);
      byPerson.get(k)!.push(t);
    }
    const empty = (pid: string): PersonStat =>
      ({ personId: pid || null, label: "", songs: 0, phases: 0, seconds: 0, byPhase: [] });
    const order = [...byPerson.keys()].map((pid) =>
      stats.persons.find((p) => (p.personId ?? "") === pid) ?? empty(pid));
    order.sort((a, b) => b.songs - a.songs);
    const sets = order.map((stat) => {
      const pid = stat.personId ?? "";
      const list = byPerson.get(pid)!;
      const i = cat.people.findIndex((p) => p.id === pid);
      const phaseIds = stat.byPhase.filter((b) => b.phase).map((b) => b.phase!.id);
      const played = list.filter((t) => t.played).sort(byPlayOrder);
      return {
        pid, stat, split: splitSet(played, phaseIds), colour: i >= 0 ? personColour(i) : "var(--ink-faint)",
        person: i >= 0 ? cat.people[i] : null,
        played,
        // what the distiller did not count: anonymised copies of a named list,
        // and playlist entries that repeat a file. Kept apart, not hidden.
        others: list.filter((t) => !t.played).sort(byPlayOrder),
      };
    });
    return { stats, sets, copies: tracks.filter((t) => !t.played).length };
  }, [cat, ev.id]);

  const sound = useMemo(() => soundOf(cat.tracks.filter((t) => t.eventId === ev.id), enrich), [cat, ev.id, enrich]);
  const showSound = worthShowing(sound);
  // Each person's own mix, from their played tracks; only worth a bar with a few songs behind it.
  const personSound = useMemo(() => {
    const m = new Map<string, Sound>();
    if (!showSound) return m;
    for (const s of sets) {
      const x = soundOf(s.played, enrich);
      if (x.familyKnown >= 3) m.set(s.pid, x);
    }
    return m;
  }, [sets, enrich, showSound]);

  const sim = useMemo(
    () => view === "sim"
      ? simulateNight(ev.id, cat.tracks.filter((t) => t.eventId === ev.id), cat.phases.filter((p) => p.eventId === ev.id), seed)
      : null,
    [view, cat, ev.id, seed]);
  const whoMap = useMemo(() => {
    const m = new Map<string, Who>();
    for (const x of sets) m.set(x.pid, { name: x.person?.name ?? (x.stat.label || "Shared"), colour: x.colour });
    return m;
  }, [sets]);
  const whoOf = useCallback((pid: string) => whoMap.get(pid) ?? { name: "Shared", colour: "var(--ink-faint)" }, [whoMap]);

  // A new night starts at the top. The first one shown is the exception: coming
  // back from a track, the page returns to where it was.
  const first = useRef({ id: null as string | null, saved: scrollMemory.get(ev.id) });
  useLayoutEffect(() => {
    const restore = first.current.id === null || first.current.id === ev.id ? first.current.saved : undefined;
    first.current.id = ev.id;
    scrollRootOf(barRef.current)?.scrollTo({ top: restore ?? 0, behavior: "instant" });
    setActive(null);
    setFolded(new Set());
  }, [ev.id]);

  // Scroll-spy: the person whose section the bar has passed last.
  const personIds = sets.map((s) => s.pid || "none");
  const idsKey = personIds.join("|");
  useEffect(() => {
    const root = scrollRootOf(barRef.current);
    if (!root) return;
    let raf = 0;
    const spy = () => {
      raf = 0;
      scrollMemory.set(ev.id, root.scrollTop);
      const line = root.getBoundingClientRect().top + (barRef.current?.offsetHeight ?? 0) + BAR_GAP;
      const secs = root.querySelectorAll<HTMLElement>("[data-person]");
      const tops = [...secs].map((s) => s.getBoundingClientRect().top);
      const atBottom = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      const i = sectionAt(tops, line, atBottom);
      setActive(i >= 0 ? secs[i].dataset.person! : null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    root.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [ev.id, idsKey]);

  // Keep the current person's chip in view when the strip scrolls sideways.
  useEffect(() => {
    const strip = stripRef.current;
    const chip = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !chip) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollTo({
      left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [active]);

  const back = useCallback(() => { scrollMemory.delete(ev.id); onBack(); }, [ev.id, onBack]);

  // Left/right arrows step between nights, Esc goes back, unless a field has the keyboard.
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.altKey || k.ctrlKey || k.metaKey || k.shiftKey) return;
      const t = k.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      if (k.key === "ArrowLeft" && prev) { k.preventDefault(); onGoto(prev.id); }
      if (k.key === "ArrowRight" && next) { k.preventDefault(); onGoto(next.id); }
      if (k.key === "Escape") { k.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onGoto, back]);

  const jump = (pid: string) => {
    // The sections only exist in the per-person view: switch, then jump once they are drawn.
    if (view !== "person") { pendingJump.current = pid; setView("person"); return; }
    const root = barRef.current?.closest(".scroll") as HTMLElement | null;
    const sec = root?.querySelector<HTMLElement>(`[data-person="${pid}"]`);
    if (!root || !sec) return;
    const top = sec.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: top - (barRef.current?.offsetHeight ?? 0) - 8, behavior: reduced ? "auto" : "smooth" });
    setActive(pid);
  };

  useEffect(() => {
    if (view === "person" && pendingJump.current) { const pid = pendingJump.current; pendingJump.current = null; jump(pid); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const reshuffle = () => setSeeds((m) => {
    const cur = m[ev.id] ?? 1;
    let n = 1 + Math.floor(Math.random() * 9999);
    if (n === cur) n = n % 9999 + 1;
    return { ...m, [ev.id]: n };
  });
  const copySim = async () => {
    if (!sim) return;
    const ok = await copyText(simText(sim, (pid) => whoOf(pid ?? "").name, blockTitle));
    toast(ok ? `Copied the simulated setlist (${plural(sim.songs, "song")})` : "Could not copy to the clipboard");
  };

  const allFolded = sets.length > 0 && folded.size === sets.length;
  const toggleFold = (pid: string) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(pid)) n.delete(pid); else n.add(pid);
    return n;
  });
  const copySet = async (name: string, list: Track[]) => {
    const ok = await copyText(setlistText(list));
    toast(ok ? `Copied ${plural(list.length, "line")} from ${name}'s set` : "Could not copy to the clipboard");
  };

  // Sorting is off by default (play order). A header click sorts within each list, never across them.
  const rowsOf = (xs: Track[], withTwin = false) =>
    (sortCol && colSort ? sortRows(xs, sortCol.sortKey!, colSort.dir) : xs).map((t) => (
      <NightRow key={t.id} track={t} cat={cat} enrich={enrich} cols={cols} onOpen={onOpen}
        twin={withTwin && t.twinId ? trackById.get(t.twinId) : undefined} />
    ));

  const head = (use: Column<Track>[], sortable: boolean) => (
    <div className="sc-head" role="row">
      {use.map((c) => {
        const on = sortable && colSort?.id === c.id ? colSort.dir : null;
        return (
          <div key={c.id} role="columnheader" className={`sc-h${c.align === "right" ? " r" : ""}`}
            aria-sort={sortable && c.sortKey ? (on === "asc" ? "ascending" : on === "desc" ? "descending" : "none") : undefined}>
            {sortable && c.sortKey ? (
              <button type="button" className={`sc-hb${on ? " on" : ""}`} onClick={() => clickHeader(c)}
                title={`Sort by ${c.label.toLowerCase()}`}>
                {c.label}<span className="sc-arrow" aria-hidden="true">{on === "asc" ? "▲" : on === "desc" ? "▼" : ""}</span>
              </button>
            ) : c.id === "cover" || c.id === "links" ? <span className="sc-sr">{c.label}</span> : c.label}
          </div>
        );
      })}
    </div>
  );

  const isNight = ev.kind !== "collection";
  const kinds = ev.types.length ? ev.types : ev.type ? [ev.type] : [];
  const title = jokeTitle(ev);
  const phaseTotal = stats.phases;

  return (
    <div className="nightpage">
      <div className="nightbar" ref={barRef}>
        <div className="nb-row">
          <button className="nb-back" onClick={back} title="Back to all nights (Esc)">← Browse</button>
          <button className="nb-step" disabled={!prev} onClick={() => prev && onGoto(prev.id)}
            title={prev ? `Earlier night: ${short(prev.date!)} (left arrow)` : "No earlier night"}
            aria-label="Previous night" aria-keyshortcuts="ArrowLeft">‹</button>
          <div className="nb-now">
            <b>{isNight && ev.date ? short(ev.date) : ev.folder}</b>
            {kinds.map((t) => (
              <span key={t} className="ktype" style={{ color: TYPE_COLOUR[t] ?? "var(--accent)" }}>{t}</span>
            ))}
          </div>
          <button className="nb-step" disabled={!next} onClick={() => next && onGoto(next.id)}
            title={next ? `Later night: ${short(next.date!)} (right arrow)` : "No later night"}
            aria-label="Next night" aria-keyshortcuts="ArrowRight">›</button>
          <span className="nb-pos">
            {at >= 0 ? `${at + 1} of ${dated.length}` : ""}
            <span className="nb-hint" aria-hidden="true"> · <kbd>←</kbd> <kbd>→</kbd> nights · <kbd>Esc</kbd> back</span>
          </span>
        </div>
        {sets.length > 1 && (
          <div className="nb-peoplerow">
            <div className="nb-people strip" ref={stripRef} role="navigation" aria-label="Jump to a person">
              {sets.map((s) => (
                <button key={s.pid || "none"} className="pchip jump" style={{ ["--pc" as string]: s.colour }}
                  aria-current={active === (s.pid || "none")} onClick={() => jump(s.pid || "none")}>
                  {s.person?.name ?? (s.stat.label || "Shared")}<i>{s.stat.songs}</i>
                </button>
              ))}
            </div>
            <button className="nb-fold" onClick={() => setFolded(allFolded ? new Set() : new Set(personIds))}>
              <ChevronIcon size={14} />{allFolded ? "Expand all" : "Collapse all"}
            </button>
          </div>
        )}
      </div>

      <div className="page nhead-wrap">
        <header className="nhead">
          <div className="nh-main">
            <h1 className="nh-date">{isNight && ev.date ? long(ev.date) : ev.folder}</h1>
            <div className="nh-kinds">
              {kinds.map((t) => (
                <span key={t} className="ktype big" style={{ color: TYPE_COLOUR[t] ?? "var(--accent)" }}>{t}</span>
              ))}
              {title && <span className="nh-title">{title}</span>}
            </div>
            <div className="nh-totals">
              <div><b>{fmtCount(stats.songs)}</b><span>songs</span></div>
              <div><b>{fmtHours(stats.seconds)}</b><span>hours</span></div>
              <div><b>{ev.people.length}</b><span>people</span></div>
              <div><b>{phaseTotal}</b><span>phases</span></div>
              <div title="Songs heard here for the first time in the library's history">
                <b>{ev.debuts}</b><span>new songs</span>
              </div>
            </div>
            <p className="nh-folders">
              {ev.folders.length > 1 ? "folders" : "folder"}{" "}
              {(ev.folders.length ? ev.folders : [ev.folder]).map((f, i) => (
                <span key={f}>{i > 0 ? ", " : ""}<code>{f}</code></span>
              ))}
              {ev.undated ? " · no date in folder name" : ""}
              {copies > 0 ? ` · ${copies} more files are anonymised copies of these sets` : ""}
            </p>
          </div>
          {isNight && ev.date && <Sky date={ev.date} weather={weather[ev.date]} large />}
        </header>

        {showSound && <SoundCard sound={sound} onOpen={onOpen} />}

        {sets.length > 0 && (
          <div className="nl-area sc-list"
            style={{ "--cols": gridTemplate(view === "sim" ? simCols : cols), "--sc-top": `${barH}px` } as CSSProperties}>
            <div className="sim-seg" role="group" aria-label="How to lay out the playlist">
              <button type="button" aria-pressed={view === "person"} onClick={() => setView("person")}>Per person</button>
              <button type="button" aria-pressed={view === "sim"} onClick={() => setView("sim")}
                title="Everyone's songs as one running playlist: one plausible order of the night">Simulated night</button>
            </div>
            <div className="nl-tools">
              {view === "sim"
                ? <span>The Time column is the elapsed time when each song starts.</span>
                : <span>Click a heading to sort within each list; again to reverse, once more for play order.</span>}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                <button type="button" className="linkbtn" onClick={() => requestPlay({ mode: "night", eventId: ev.id })}
                  title="Play this night's songs in a random order, 30 seconds each (cosmic radio)">▶ Shuffle this night</button>
                {view === "sim"
                  ? <ColumnsMenu columns={simAll} choice={simChoice} onToggle={toggleSimCol} onReset={resetSimCols} />
                  : <ColumnsMenu columns={allCols} choice={choice} onToggle={toggleCol} onReset={resetCols} />}
              </span>
            </div>
            {sim && (
              <div className="sim-note">
                <p className="sim-lead">
                  <b>A simulation:</b> within each phase the real order was random, so this is one plausible version of the night.
                </p>
                <p>
                  Simulated length <b>{fmtSpan(sim.totalSeconds)}</b> · recorded night length <b>{fmtSpan(ev.durationSec)}</b>
                  {sim.estimatedRows > 0 && ` · ${plural(sim.estimatedRows, "song")} with no known length counted at the median ${fmtClock(sim.medianSec)} (marked ~)`}
                </p>
                {sim.phased ? (
                  <p>
                    {MAPPING_RULE}
                    {sim.looseSongs > 0 && ` Phases do not cover the whole night: ${plural(sim.looseSongs, "song")} (${fmtSpan(sim.looseSeconds)}) sit in no phase, so they have no place on the clock and come last.`}
                  </p>
                ) : sim.songs > 0 && (
                  <p>Phases were not recorded for this night, so everyone's songs are shuffled together as one block.</p>
                )}
                <div className="sim-actions">
                  <button className="copybtn" onClick={reshuffle} title="Pick another random order">Reshuffle</button>
                  <span className="sim-seed" title="The same night with the same number always opens in the same order">shuffle #{sim.seed}</span>
                  <button className="copybtn" onClick={() => void copySim()} disabled={!sim.songs}
                    title="Copy the simulated order as plain text, with the running clock">
                    <CopyIcon size={14} /> Copy simulated setlist
                  </button>
                </div>
              </div>
            )}
            {head(view === "sim" ? simCols : cols, view === "person")}
        {sim && (sim.blocks.length
          ? <SimList sim={sim} cat={cat} enrich={enrich} cols={simCols} whoOf={whoOf} onOpen={onOpen} />
          : <p className="sim-empty">No song of this night is counted as played, so there is nothing to simulate.</p>)}
        {view === "person" && sets.map(({ pid, stat, colour, person, others, split }) => {
          const loose = split.loose;
          const named = person?.name ?? (stat.label || "Shared");
          const key = pid || "none";
          const isFolded = folded.has(key);
          return (
            <section key={key} className={`pset${isFolded ? " is-folded" : ""}`} data-person={key}
              style={{ ["--pc" as string]: colour }}>
              <div className="pshead">
                <h2 className="pname">
                  <button className="pfold" aria-expanded={!isFolded} aria-controls={`set-${key}`}
                    title={isFolded ? "Show this set" : "Fold this set away"} onClick={() => toggleFold(key)}>
                    <ChevronIcon size={18} />
                    <span className="dot" />{named}
                  </button>
                </h2>
                <div className="pmetrics">
                  <span><b>{stat.songs}</b> songs</span>
                  <span><b>{stat.phases}</b> {stat.phases === 1 ? "phase" : "phases"}</span>
                  <span><b>{fmtSpan(stat.seconds)}</b></span>
                  <button className="copybtn" onClick={() => void copySet(named, split.ordered)}
                    disabled={!split.ordered.length}
                    title="Copy this set as plain text, one 'Artist - Title' per line">
                    <CopyIcon size={14} /> Copy setlist
                  </button>
                </div>
              </div>

              <div className="pbody" id={`set-${key}`}>
              {personSound.has(pid) && (
                <div className="ns-person">
                  <FamilyBar sound={personSound.get(pid)!} small />
                  <p>
                    {personSound.get(pid)!.families.slice(0, 4)
                      .map((f) => `${familyLabel(f.family)} ${f.count}`).join(" · ")}
                    {personSound.get(pid)!.families.length > 4 ? " · …" : ""}
                    {` · ${personSound.get(pid)!.familyKnown} of ${personSound.get(pid)!.songs} songs known`}
                  </p>
                </div>
              )}
              {person && split.ordered.length > 0 && split.ordered.every((t) => t.flags.includes("anon")) && (
                <p className="anon-note">
                  Only anonymised files survive for this list, so there are no song names. A playlist
                  export for this night would fill them in.
                </p>
              )}
              {stat.byPhase.length > 1 && (
                <div className="pdiv" role="img"
                  aria-label={`How the phases divide this set's time: ${stat.byPhase
                    .map((b) => `${b.phase?.clean ?? "not in a phase"} ${pct(b.share)}`).join(", ")}`}>
                  {stat.byPhase.map((b, i) => (
                    <span key={b.key || "loose"} style={{ flexGrow: Math.max(b.share, 0.01) * 1000, opacity: 1 - (i % 2) * 0.4 }}
                      title={`${b.phase?.clean ?? "Not in a phase"} · ${plural(b.songs, "song")} · ${fmtSpan(b.seconds)} · ${pct(b.share)}`} />
                  ))}
                </div>
              )}

              {stat.byPhase.filter((b) => b.phase).map((b) => {
                const ph = b.phase!;
                return (
                  <div key={ph.id} className="pphase">
                    <div className="phasehead" style={{ marginTop: 14 }}>
                      <span className={`bucket ${ph.bucket}`}
                        title={ph.inferred ? "Not a folder: the loose tracks of this list, which sit before its other phases"
                          : ph.basis === "number" ? "Ordered by the number in its name"
                          : ph.basis === "word" ? "Ordered by what the word means"
                          : "Nothing in the names says which came first; folder order"}>
                        {ph.bucket}
                      </span>
                      <span className="name">{ph.clean}</span>
                      {ph.basis === "crawl" && stat.phases > 1 && (
                        <span className="meta" title="Order not given by the names">· order unknown</span>
                      )}
                      <span className="meta" title={ph.minutes ? `its folder says ${ph.minutes} min` : undefined}>
                        {plural(b.songs, "song")} · {fmtSpan(b.seconds)}
                      </span>
                      <span className="pshare" title={`${pct(b.share)} of ${named}'s time`}>
                        <span style={{ width: pct(b.share) }} />
                      </span>
                      <span className="meta pct">{pct(b.share)}</span>
                    </div>
                    <div className="rows">
                      {rowsOf(split.byPhase.get(ph.id) ?? [])}
                    </div>
                  </div>
                );
              })}

              {loose.length > 0 && (
                <>
                  {stat.phases > 0 && (
                    <div className="phasehead" style={{ marginTop: 14 }}>
                      <span className="name dimname">Not in a phase</span>
                      <span className="meta">{plural(loose.length, "song")}</span>
                    </div>
                  )}
                  <div className="rows" style={{ marginTop: stat.phases ? 0 : 8 }}>
                    {rowsOf(loose)}
                  </div>
                </>
              )}

              {split.unnamed.length > 0 && (
                <>
                  <div className="phasehead" style={{ marginTop: 14 }}>
                    <span className="name dimname">No name on file</span>
                    <span className="meta">{plural(split.unnamed.length, "file")} · only anonymised copies exist</span>
                  </div>
                  <div className="rows">
                    {rowsOf(split.unnamed)}
                  </div>
                </>
              )}

              {others.length > 0 && (
                <details className="anonlist">
                  <summary>
                    {others.every((t) => t.flags.includes("anon")) ? "Anonymised copies" : "Other copies"}
                    {" "}· {plural(others.length, "track")}
                  </summary>
                  <div className="rows">
                    {rowsOf(others, true)}
                  </div>
                </details>
              )}
              </div>
            </section>
          );
        })}
          </div>
        )}
      </div>
      {toastNode}
    </div>
  );
}
