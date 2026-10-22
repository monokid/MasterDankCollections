/** One night, in full: a sticky bar to move between nights and jump between
 *  people, the night's totals and sky, then each person's set with the numbers
 *  that say how their phases divide their time. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Event, Track } from "./catalog.ts";
import { TYPE_COLOUR, personColour } from "./colours.ts";
import { nightStats, type PersonStat } from "./nightstats.ts";
import { byPlayOrder, fmtSpan, TrackRow } from "./rows.tsx";
import Sky from "./Sky.tsx";
import type { WeatherMap } from "./weather.ts";

const long = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined,
    { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const short = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;
const jokeTitle = (e: Event) =>
  e.title && !e.types.includes(e.title.toLowerCase()) ? e.title : "";

const BAR_GAP = 28;   // clearance under the sticky bar when a section is scrolled to

export default function NightPage({ cat, ev, weather, onBack, onGoto, onOpen }: {
  cat: Catalog; ev: Event; weather: WeatherMap;
  onBack: () => void; onGoto: (id: string) => void; onOpen: (t: Track) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);

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
      ({ personId: pid || null, songs: 0, phases: 0, seconds: 0, byPhase: [] });
    const order = [...byPerson.keys()].map((pid) =>
      stats.persons.find((p) => (p.personId ?? "") === pid) ?? empty(pid));
    order.sort((a, b) => b.songs - a.songs);
    const sets = order.map((stat) => {
      const pid = stat.personId ?? "";
      const list = byPerson.get(pid)!;
      const i = cat.people.findIndex((p) => p.id === pid);
      return {
        pid, stat, colour: i >= 0 ? personColour(i) : "var(--ink-faint)",
        person: i >= 0 ? cat.people[i] : null,
        played: list.filter((t) => t.played).sort(byPlayOrder),
        // what the distiller did not count: anonymised copies of a named list,
        // and playlist entries that repeat a file. Kept apart, not hidden.
        others: list.filter((t) => !t.played).sort(byPlayOrder),
      };
    });
    return { stats, sets, copies: tracks.filter((t) => !t.played).length };
  }, [cat, ev.id]);

  // New night: start at the top.
  useEffect(() => {
    barRef.current?.closest(".scroll")?.scrollTo({ top: 0, behavior: "instant" });
    setActive(null);
  }, [ev.id]);

  // Scroll-spy: the person whose section the bar has passed last.
  useEffect(() => {
    const root = barRef.current?.closest(".scroll") as HTMLElement | null;
    if (!root) return;
    let raf = 0;
    const spy = () => {
      raf = 0;
      const line = root.getBoundingClientRect().top + (barRef.current?.offsetHeight ?? 0) + BAR_GAP;
      let cur: string | null = null;
      for (const s of root.querySelectorAll<HTMLElement>("[data-person]")) {
        if (s.getBoundingClientRect().top <= line) cur = s.dataset.person!;
        else break;
      }
      setActive(cur);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    root.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [ev.id]);

  // Left/right arrows step between nights, unless a field has the keyboard.
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.altKey || k.ctrlKey || k.metaKey || k.shiftKey) return;
      const t = k.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      if (k.key === "ArrowLeft" && prev) { k.preventDefault(); onGoto(prev.id); }
      if (k.key === "ArrowRight" && next) { k.preventDefault(); onGoto(next.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onGoto]);

  const jump = (pid: string) => {
    const root = barRef.current?.closest(".scroll") as HTMLElement | null;
    const sec = root?.querySelector<HTMLElement>(`[data-person="${pid}"]`);
    if (!root || !sec) return;
    const top = sec.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: top - (barRef.current?.offsetHeight ?? 0) - 8, behavior: "smooth" });
  };

  const isNight = ev.kind !== "collection";
  const kinds = ev.types.length ? ev.types : ev.type ? [ev.type] : [];
  const title = jokeTitle(ev);
  const phaseTotal = stats.phases;

  return (
    <div className="nightpage">
      <div className="nightbar" ref={barRef}>
        <div className="nb-row">
          <button className="nb-back" onClick={onBack}>← Browse</button>
          <button className="nb-step" disabled={!prev} onClick={() => prev && onGoto(prev.id)}
            title={prev ? `Earlier night: ${short(prev.date!)} (left arrow)` : "No earlier night"}
            aria-label="Previous night">‹</button>
          <div className="nb-now">
            <b>{isNight && ev.date ? short(ev.date) : ev.folder}</b>
            {kinds.map((t) => (
              <span key={t} className="ktype" style={{ color: TYPE_COLOUR[t] ?? "var(--accent)" }}>{t}</span>
            ))}
          </div>
          <button className="nb-step" disabled={!next} onClick={() => next && onGoto(next.id)}
            title={next ? `Later night: ${short(next.date!)} (right arrow)` : "No later night"}
            aria-label="Next night">›</button>
          <span className="nb-pos">{at >= 0 ? `${at + 1} of ${dated.length}` : ""}</span>
        </div>
        {sets.length > 1 && (
          <div className="nb-people" role="navigation" aria-label="Jump to a person">
            {sets.map((s) => (
              <button key={s.pid || "none"} className="pchip jump" style={{ ["--pc" as string]: s.colour }}
                aria-current={active === (s.pid || "none")} onClick={() => jump(s.pid || "none")}>
                {s.person?.name ?? "Unattributed"}<i>{s.stat.songs}</i>
              </button>
            ))}
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
              <div><b>{stats.songs}</b><span>songs</span></div>
              <div><b>{(stats.seconds / 3600).toFixed(1)}</b><span>hours</span></div>
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

        {sets.map(({ pid, stat, colour, person, played, others }) => {
          const loose = played.filter((t) => !t.phaseId || !stat.byPhase.some((b) => b.key === t.phaseId));
          const named = person?.name ?? "Unattributed";
          return (
            <section key={pid || "none"} className="pset" data-person={pid || "none"}
              style={{ ["--pc" as string]: colour }}>
              <div className="pshead">
                <h2 className="pname"><span className="dot" />{named}</h2>
                <div className="pmetrics">
                  <span><b>{stat.songs}</b> songs</span>
                  <span><b>{stat.phases}</b> {stat.phases === 1 ? "phase" : "phases"}</span>
                  <span><b>{fmtSpan(stat.seconds)}</b></span>
                </div>
              </div>

              {stat.byPhase.length > 1 && (
                <div className="pdiv" aria-label="How the phases divide this set's time">
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
                      {played.filter((t) => t.phaseId === ph.id).map((t) => (
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
