/** One night, in full: a sticky bar to move between nights and jump between
 *  people, the night's totals and sky, then each person's set with the numbers
 *  that say how their phases divide their time. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Event, Track } from "./catalog.ts";
import { TYPE_COLOUR, personColour } from "./colours.ts";
import { nightStats, type PersonStat } from "./nightstats.ts";
import { byPlayOrder, TrackRow } from "./rows.tsx";
import Sky from "./Sky.tsx";
import type { WeatherMap } from "./weather.ts";
import { fmtCount, fmtDate as short, fmtDateLong as long, fmtHours, fmtSpan, pct, plural } from "./format.ts";
import { copyText, scrollRootOf, sectionAt, setlistText, splitSet } from "./pagehelpers.ts";
import { useToast } from "./Toast.tsx";
import { ChevronIcon, CopyIcon } from "./icons.tsx";
import "./pages.css";

/** Where each night was scrolled to, so coming back from a track lands there. */
const scrollMemory = new Map<string, number>();

const jokeTitle = (e: Event) =>
  e.title && !e.types.includes(e.title.toLowerCase()) ? e.title : "";

const BAR_GAP = 28;   // clearance under the sticky bar when a section is scrolled to

export default function NightPage({ cat, ev, weather, onBack, onGoto, onOpen }: {
  cat: Catalog; ev: Event; weather: WeatherMap;
  onBack: () => void; onGoto: (id: string) => void; onOpen: (t: Track) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  // People whose set is folded away. CSS does the hiding, so a print still has every set.
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const { toast, node: toastNode } = useToast();

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
    const root = barRef.current?.closest(".scroll") as HTMLElement | null;
    const sec = root?.querySelector<HTMLElement>(`[data-person="${pid}"]`);
    if (!root || !sec) return;
    const top = sec.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: top - (barRef.current?.offsetHeight ?? 0) - 8, behavior: reduced ? "auto" : "smooth" });
    setActive(pid);
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

        {sets.map(({ pid, stat, colour, person, others, split }) => {
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
                      {(split.byPhase.get(ph.id) ?? []).map((t) => (
                        <TrackRow key={t.id} track={t} cat={cat} query="" onOpen={onOpen} />
                      ))}
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
                    {loose.map((t) => (
                      <TrackRow key={t.id} track={t} cat={cat} query="" onOpen={onOpen} />
                    ))}
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
                    {others.map((t) => (
                      <TrackRow key={t.id} track={t} cat={cat} query="" onOpen={onOpen}
                        twin={t.twinId ? trackById.get(t.twinId) : undefined} />
                    ))}
                  </div>
                </details>
              )}
              </div>
            </section>
          );
        })}
      </div>
      {toastNode}
    </div>
  );
}
