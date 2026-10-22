/** The decade as one continuous, living axis.
 *
 *  Nights sit at their real date, because the spacing is information -- ten
 *  nights in 2016 and one in 2017 is the shape of the thing. Height is running
 *  time, colour is the kind of night. Beneath the bars, one lane per
 *  contributor shows who was there; beneath that, a minimap of the whole decade.
 *
 *  What you can do with it:
 *    - drag to pan (it glides), scroll to zoom (it eases), arrows to step
 *    - click a night to open its set beside the timeline
 *    - shift-drag, or "Select range", to pick a span; Insights then reads it
 *    - press play and the decade builds up: nights, songs, the canon, the cast
 *    - select a song, artist or person elsewhere and its nights light up
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Event } from "./catalog.ts";
import { cumulative, type Range } from "./analytics.ts";
import { TYPE_COLOUR, nightColour, personColour } from "./colours.ts";

export interface Trace {
  kind: "song" | "artist" | "person";
  id: string;
  label: string;
  nights: Set<string>;
}

const DAY = 86400000;
const GUTTER = 96;            // room on the left for lane names
const MAX_ZOOM = 140;
const LANE_H = 22;
const PLAY_SECONDS = 26;      // the whole decade, at 1x



const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export default function Timeline({
  cat, trace, onClearTrace, selected, onSelect, range, onRange, onInsights,
}: {
  cat: Catalog;
  trace: Trace | null;
  onClearTrace: () => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  range: Range | null;
  onRange: (r: Range | null) => void;
  onInsights: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  const [vh, setVh] = useState(() => window.innerHeight);
  const [view, setView] = useState({ z: 1, pan: 0 });
  const target = useRef({ z: 1, pan: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [mode, setMode] = useState<"pan" | "select">("pan");
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const drag = useRef<{
    kind: "pan" | "select"; x0: number; pan0: number; lastX: number; lastT: number;
    v: number; moved: boolean; t0ms: number;
  } | null>(null);
  const suppressClick = useRef(false);

  // ------------------------------------------------------------------ data

  const { nights, at } = useMemo(() => cumulative(cat), [cat]);
  const people = cat.people;
  const attended = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of nights) m.set(e.id, new Set(e.people));
    return m;
  }, [nights]);
  const personName = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);

  const { t0, span } = useMemo(() => {
    if (!nights.length) return { t0: 0, span: 1 };
    const first = Date.parse(nights[0].date!);
    const last = Date.parse(nights[nights.length - 1].date!);
    const pad = (last - first) * 0.03 + 30 * DAY;
    return { t0: first - pad, span: last - first + pad * 2 };
  }, [nights]);
  const longest = useMemo(() => Math.max(...nights.map((n) => n.durationSec), 1), [nights]);

  // -------------------------------------------------------------- geometry

  const plotW = Math.max(width - GUTTER, 200);
  const inner = plotW * view.z;
  const barsH = clamp(Math.round(vh * 0.3), 170, 300);
  const axisY = barsH + 12;
  const lanesY = axisY + 34;
  const totalH = lanesY + people.length * LANE_H + 10;

  const xOf = useCallback((ms: number, v = view) =>
    GUTTER + ((ms - t0) / span) * plotW * v.z + v.pan, [t0, span, plotW, view]);
  const msAt = useCallback((x: number, v = view) =>
    t0 + ((x - GUTTER - v.pan) / (plotW * v.z)) * span, [t0, span, plotW, view]);
  const maxPan = (z: number) => Math.max(0, plotW * z - plotW);
  const clampPan = (p: number, z: number) => clamp(p, -maxPan(z), 0);

  // ------------------------------------------------------------- lifecycle

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // One observer is not enough: a pane that is hidden when this mounts reports
    // zero and may never report again. So also re-measure on window resize and a
    // moment after mount, and never accept a zero width -- an empty plot is
    // worse than a briefly wrong one.
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
      setVh(window.innerHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    window.addEventListener("resize", measure);
    const later = [150, 600, 1500].map((ms) => setTimeout(measure, ms));
    const t = setTimeout(() => setReady(true), 80);
    return () => {
      ro.disconnect(); window.removeEventListener("resize", measure);
      later.forEach(clearTimeout); clearTimeout(t);
    };
  }, []);

  // Zoom and pan ease toward their targets, so nothing ever jumps.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const tg = target.current;
      setView((v) => {
        const dz = tg.z - v.z, dp = tg.pan - v.pan;
        if (Math.abs(dz) < 0.002 && Math.abs(dp) < 0.4) {
          return v.z === tg.z && v.pan === tg.pan ? v : { z: tg.z, pan: tg.pan };
        }
        return { z: v.z + dz * 0.2, pan: v.pan + dp * 0.2 };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A non-passive wheel listener: React's own onWheel cannot preventDefault.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - GUTTER;
      const tg = target.current;
      const z = clamp(tg.z * Math.exp(-e.deltaY * 0.0016), 1, MAX_ZOOM);
      const ratio = z / tg.z;
      target.current = { z, pan: clamp(cx - (cx - tg.pan) * ratio, -Math.max(0, plotW * z - plotW), 0) };
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [plotW]);

  // Playback: the playhead sweeps the decade.
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = now - last; last = now;
      setPlayhead((p) => {
        const next = (p ?? t0) + (dt / 1000) * (span / PLAY_SECONDS) * speed;
        if (next >= t0 + span) { setPlaying(false); return t0 + span; }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, t0, span]);

  // While playing, keep the playhead in view.
  useEffect(() => {
    if (playhead === null || !playing || view.z <= 1.01) return;
    const x = xOf(playhead);
    if (x < GUTTER + 40 || x > width - 80) {
      const tg = target.current;
      target.current = {
        z: tg.z,
        pan: clampPan(tg.pan - (x - (GUTTER + plotW * 0.3)), tg.z),
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead]);

  const startPlay = () => {
    if (playhead === null || playhead >= t0 + span - 1) setPlayhead(t0);
    setPlaying(true);
  };
  const stopPlay = () => { setPlaying(false); setPlayhead(null); };

  // ------------------------------------------------------------ interaction

  const revealNight = useCallback((id: string) => {
    const e = nights.find((n) => n.id === id);
    if (!e) return;
    const x = xOf(Date.parse(e.date!));
    if (x < GUTTER + 30 || x > width - 30) {
      const tg = target.current;
      target.current = { z: tg.z, pan: clampPan(tg.pan - (x - (GUTTER + plotW / 2)), tg.z) };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nights, xOf, width, plotW]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onSelect(null); return; }
    if (e.key === " ") { e.preventDefault(); playing ? setPlaying(false) : startPlay(); return; }
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = nights.findIndex((n) => n.id === (selected ?? hover));
    const j = clamp(i < 0 ? 0 : i + (e.key === "ArrowRight" ? 1 : -1), 0, nights.length - 1);
    onSelect(nights[j].id);
    revealNight(nights[j].id);
  };

  const rel = (e: React.PointerEvent) =>
    e.clientX - wrapRef.current!.getBoundingClientRect().left;

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const x = rel(e);
    if (x < GUTTER) return;
    const sel = mode === "select" || e.shiftKey;
    drag.current = {
      kind: sel ? "select" : "pan", x0: x, pan0: target.current.pan,
      lastX: x, lastT: performance.now(), v: 0, moved: false, t0ms: msAt(x),
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const x = rel(e);
    if (!d.moved && Math.abs(x - d.x0) > 4) {
      d.moved = true;
      wrapRef.current!.setPointerCapture(e.pointerId);
    }
    if (!d.moved) return;
    if (d.kind === "select") {
      setDraft({ a: d.t0ms, b: msAt(x) });
    } else {
      const now = performance.now();
      const dt = Math.max(now - d.lastT, 1);
      d.v = 0.8 * d.v + 0.2 * ((x - d.lastX) / dt);
      d.lastX = x; d.lastT = now;
      const tg = target.current;
      const pan = clampPan(d.pan0 + (x - d.x0), tg.z);
      target.current = { z: tg.z, pan };
      setView((v) => ({ z: v.z, pan }));            // follow the pointer exactly
    }
  };

  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
    try { wrapRef.current!.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (d.kind === "select") {
      const x = rel(e);
      const a = Math.min(d.t0ms, msAt(x)), b = Math.max(d.t0ms, msAt(x));
      setDraft(null);
      if (b - a > 3 * DAY) onRange({ from: iso(a), to: iso(b) });
      setMode("pan");
    } else {
      // Let go and it keeps gliding, the way a flicked map does.
      const tg = target.current;
      target.current = { z: tg.z, pan: clampPan(tg.pan + d.v * 260, tg.z) };
    }
  };

  const zoomBy = (f: number) => {
    const tg = target.current;
    const z = clamp(tg.z * f, 1, MAX_ZOOM);
    const c = plotW / 2, ratio = z / tg.z;
    target.current = { z, pan: clampPan(c - (c - tg.pan) * ratio, z) };
  };
  const resetView = () => { target.current = { z: 1, pan: 0 }; };

  // Minimap: click or drag to move the window.
  const mini = useRef<SVGSVGElement>(null);
  const miniTo = (clientX: number) => {
    const r = mini.current!.getBoundingClientRect();
    const frac = clamp((clientX - r.left - GUTTER) / plotW, 0, 1);
    const tg = target.current;
    target.current = { z: tg.z, pan: clampPan(-(frac * plotW * tg.z - plotW / 2), tg.z) };
  };

  // --------------------------------------------------------------- derived

  const hovered = hover ? nights.find((n) => n.id === hover) ?? null : null;
  const inRangeSet = useMemo(() => {
    if (!range) return null;
    return new Set(nights.filter((n) => n.date! >= range.from && n.date! <= range.to).map((n) => n.id));
  }, [nights, range]);
  const rangeStats = useMemo(() => {
    const ns = nights.filter((n) => inRangeSet?.has(n.id));
    return { nights: ns.length, hours: ns.reduce((s, n) => s + n.durationSec, 0) / 3600 };
  }, [nights, inRangeSet]);

  const upTo = playhead === null ? nights.length
    : nights.reduce((n, e, i) => (Date.parse(e.date!) <= playhead ? i + 1 : n), 0);
  const now = playhead === null ? null : at[upTo - 1] ?? { nights: 0, songs: 0, canon: 0, people: 0 };

  const years = useMemo(() => {
    const a = new Date(t0).getUTCFullYear(), b = new Date(t0 + span).getUTCFullYear();
    const all: number[] = [];
    for (let y = a; y <= b; y++) all.push(y);
    const every = Math.max(1, Math.ceil((all.length * 52) / Math.max(inner, 1)));
    return all.filter((_, i) => i % every === 0);
  }, [t0, span, inner]);

  const lit = (e: Event, i: number) =>
    (!trace || trace.nights.has(e.id)) && (playhead === null || i < upTo);

  const barW = clamp((plotW * view.z) / Math.max(nights.length, 1) * 0.42, 5, 22);
  const miniW = plotW;
  const mx = (ms: number) => GUTTER + ((ms - t0) / span) * miniW;

  // ----------------------------------------------------------------- view

  return (
    <div className={`timeline${ready ? " ready" : ""}`}>
      <div className="tl-bar">
        {trace ? (
          <span className="tl-trace">
            <b>{trace.label}</b>
            <span className="tl-dim"> on {trace.nights.size} night{trace.nights.size === 1 ? "" : "s"}</span>
            <button className="tl-clear" onClick={onClearTrace}>clear</button>
          </span>
        ) : (
          <span className="tl-dim">
            {nights.length} nights · drag to pan · scroll to zoom · ← → to step · space to play
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className={`tl-zoom${mode === "select" ? " on" : ""}`}
          onClick={() => setMode(mode === "select" ? "pan" : "select")}
          title="Drag across the timeline to pick a range (or hold shift)">
          select range
        </button>
        <button className="tl-zoom" onClick={() => zoomBy(1 / 1.8)}>−</button>
        <button className="tl-zoom" onClick={resetView}>reset</button>
        <button className="tl-zoom" onClick={() => zoomBy(1.8)}>+</button>
        <span className="tl-sep" />
        <button className={`tl-play${playing ? " on" : ""}`}
          onClick={() => (playing ? setPlaying(false) : startPlay())}>
          {playing ? "❚❚ pause" : playhead !== null ? "▶ resume" : "▶ play the decade"}
        </button>
        {playhead !== null && (
          <>
            <button className="tl-zoom" onClick={() => setSpeed(speed === 1 ? 2.5 : 1)}>
              {speed === 1 ? "1×" : "2.5×"}
            </button>
            <button className="tl-zoom" onClick={stopPlay}>■</button>
          </>
        )}
      </div>

      {now && playhead !== null && (
        <div className="tl-readout">
          <span className="when">
            {new Date(playhead).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
          </span>
          <span><b>{now.nights}</b> nights</span>
          <span><b>{now.songs.toLocaleString()}</b> songs heard</span>
          <span><b>{now.canon}</b> in the canon <i>(3+ nights)</i></span>
          <span><b>{now.people}</b> contributors</span>
        </div>
      )}

      {range && (
        <div className="tl-rangebar">
          <span>
            <b>{range.from}</b> → <b>{range.to}</b> · {rangeStats.nights} night{rangeStats.nights === 1 ? "" : "s"} · {rangeStats.hours.toFixed(0)} h
          </span>
          <button className="tl-zoom" onClick={onInsights}>insights for this range →</button>
          <button className="tl-clear" style={{ marginLeft: 0 }} onClick={() => onRange(null)}>clear range</button>
        </div>
      )}

      <div
        ref={wrapRef}
        className={`tl-canvas ${mode === "select" ? "selecting" : ""}`}
        style={{ height: totalH }}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => setHover(null)}
      >
        <svg width={width} height={totalH} style={{ display: "block" }}>
          <defs>
            <clipPath id="tl-plot">
              <rect x={GUTTER} y={0} width={plotW} height={totalH} />
            </clipPath>
            <filter id="tl-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3.2" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          <line x1={GUTTER} y1={axisY} x2={width} y2={axisY} stroke="rgba(150,120,255,0.3)" />

          {/* lane labels, in the gutter, outside the clip */}
          {people.map((p, i) => {
            const on = trace?.kind === "person" && trace.id === p.id;
            return (
              <g key={p.id}>
                <circle cx={14} cy={lanesY + i * LANE_H + LANE_H / 2} r={3.4} fill={personColour(i)}
                  opacity={trace && !on ? 0.35 : 1} />
                <text x={26} y={lanesY + i * LANE_H + LANE_H / 2 + 4} className={`tl-lane${on ? " on" : ""}`}>
                  {p.name}
                </text>
              </g>
            );
          })}

          <g clipPath="url(#tl-plot)">
            {people.map((p, i) => (
              <line key={p.id} x1={GUTTER} x2={width}
                y1={lanesY + i * LANE_H + LANE_H / 2} y2={lanesY + i * LANE_H + LANE_H / 2}
                stroke="rgba(150,120,255,0.07)" />
            ))}

            {years.map((y) => {
              const x = xOf(Date.UTC(y, 0, 1));
              if (x < GUTTER - 40 || x > width + 40) return null;
              return (
                <g key={y}>
                  <line x1={x} y1={0} x2={x} y2={totalH} stroke="rgba(150,120,255,0.07)" />
                  <text x={x + 5} y={axisY + 20} className="tl-year">{y}</text>
                </g>
              );
            })}

            {range && (() => {
              const x1 = xOf(Date.parse(range.from)), x2 = xOf(Date.parse(range.to));
              return <rect x={x1} y={0} width={Math.max(x2 - x1, 2)} height={totalH} className="tl-range" />;
            })()}
            {draft && (() => {
              const x1 = xOf(Math.min(draft.a, draft.b)), x2 = xOf(Math.max(draft.a, draft.b));
              return <rect x={x1} y={0} width={Math.max(x2 - x1, 1)} height={totalH} className="tl-range draft" />;
            })()}

            {nights.map((n, i) => {
              const x = xOf(Date.parse(n.date!));
              if (x < GUTTER - 30 || x > width + 30) return null;
              const h = 16 + (n.durationSec / longest) * (barsH - 36);
              const on = lit(n, i);
              const colour = nightColour(n);
              const isSel = selected === n.id;
              const faded = inRangeSet && !inRangeSet.has(n.id) ? 0.4 : 1;
              const op = (on ? (hover === n.id || isSel ? 1 : 0.84) : 0.1) * faded;
              return (
                <g key={n.id}
                  onMouseEnter={() => setHover(n.id)}
                  onClick={() => { if (!suppressClick.current) onSelect(isSel ? null : n.id); }}
                  style={{ cursor: "pointer" }}>
                  <rect x={x - barW / 2 - 4} y={axisY - h - 10} width={barW + 8} height={h + 14} fill="transparent" />
                  <rect className="bar-in"
                    x={x - barW / 2} y={axisY - h} width={barW} height={h} rx={3}
                    fill={colour} opacity={op}
                    filter={isSel || (on && trace) ? "url(#tl-glow)" : undefined}
                    stroke={isSel ? "#fff" : "none"} strokeWidth={isSel ? 1.4 : 0}
                    style={{ transitionDelay: `${i * 24}ms` }} />
                  {trace && on && <circle cx={x} cy={axisY - h - 8} r={3.4} fill={colour} />}
                </g>
              );
            })}

            {nights.map((n, i) => {
              const x = xOf(Date.parse(n.date!));
              if (x < GUTTER - 30 || x > width + 30) return null;
              const on = lit(n, i);
              const who = attended.get(n.id)!;
              const faded = inRangeSet && !inRangeSet.has(n.id) ? 0.4 : 1;
              return (
                <g key={n.id} onClick={() => { if (!suppressClick.current) onSelect(selected === n.id ? null : n.id); }}
                  onMouseEnter={() => setHover(n.id)} style={{ cursor: "pointer" }}>
                  {people.map((p, k) => who.has(p.id) && (
                    <rect key={p.id} className="bar-in lane-mark"
                      x={x - Math.max(barW / 2, 3)} y={lanesY + k * LANE_H + 5}
                      width={Math.max(barW, 6)} height={LANE_H - 10} rx={3}
                      fill={personColour(k)}
                      opacity={(on ? 0.9 : 0.08) * faded
                        * (trace?.kind === "person" && trace.id !== p.id ? 0.25 : 1)}
                      style={{ transitionDelay: `${i * 24 + k * 14}ms` }} />
                  ))}
                </g>
              );
            })}

            {playhead !== null && (() => {
              const x = xOf(playhead);
              return (
                <g>
                  <line x1={x} y1={0} x2={x} y2={totalH} className="tl-head" />
                  <circle cx={x} cy={axisY} r={5} className="tl-headdot" />
                </g>
              );
            })()}
          </g>
        </svg>

        {hovered && (
          <div className="tl-tip" style={{
            left: clamp(xOf(Date.parse(hovered.date!)), GUTTER + 110, width - 110),
          }}>
            <b>{new Date(hovered.date! + "T00:00:00").toLocaleDateString(undefined,
              { year: "numeric", month: "short", day: "numeric" })}</b>
            {hovered.title ? <span className="tl-dim"> · {hovered.title}</span> : null}
            <div className="tl-dim">
              {hovered.playedCount} tracks · {(hovered.durationSec / 3600).toFixed(1)}h
              {hovered.debuts ? ` · ${hovered.debuts} debuts` : ""}
            </div>
            <div className="tl-dim">
              {hovered.people.map((id) => personName.get(id)).filter(Boolean).join(", ")}
            </div>
            {hovered.types.length > 0 && (
              <div className="tl-types">
                {hovered.types.map((t) => (
                  <span key={t} className="tl-type" style={{ color: TYPE_COLOUR[t] }}>{t}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <svg ref={mini} className="tl-mini" width={width} height={52}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); miniTo(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons === 1) miniTo(e.clientX); }}>
        <text x={14} y={30} className="tl-lane">overview</text>
        <rect x={GUTTER} y={6} width={miniW} height={40} rx={6} className="tl-minibg" />
        {nights.map((n) => {
          const h = 6 + (n.durationSec / longest) * 30;
          return (
            <rect key={n.id} x={mx(Date.parse(n.date!)) - 1.2} y={44 - h} width={2.4} height={h}
              fill={nightColour(n)} opacity={trace && !trace.nights.has(n.id) ? 0.15 : 0.8} />
          );
        })}
        {range && (
          <rect x={mx(Date.parse(range.from))} y={6}
            width={Math.max(mx(Date.parse(range.to)) - mx(Date.parse(range.from)), 2)} height={40}
            className="tl-range" />
        )}
        <rect className="tl-window"
          x={GUTTER + clamp(-view.pan / (plotW * view.z), 0, 1) * miniW} y={4}
          width={Math.max(miniW / view.z, 8)} height={44} rx={6} />
      </svg>
    </div>
  );
}
