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
 *
 *  How it stays cheap: the bars and lane marks are laid out for the current
 *  zoom only and sit in a group that is *translated* by the pan, so a pan frame
 *  moves one attribute instead of re-rendering every night. The layer is memoised
 *  and only draws the nights near the screen (in half-screen buckets, so panning
 *  within a bucket re-renders nothing). Hover and click are delegated to one
 *  parent, so hovering never touches the layer either.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Event } from "./catalog.ts";
import { cumulative, type Range } from "./analytics.ts";
import { TYPE_COLOUR, nightColour, personColour } from "./colours.ts";
import type { EnrichMap } from "./enrich.ts";
import { familyColour, familyLabel } from "./families.ts";
import { legendCounts, nightSounds, type NightSound } from "./timelinesound.ts";
import { useSessionState } from "./hooks.ts";
import { milestonesOf, SHAPE, type Milestone, type MilestoneKind, type MilestoneLink, type Shape } from "./milestones.ts";
import { BASE_SECONDS, SPEEDS, createPacer } from "./playpace.ts";
import "./timelinesound.css";
import "./milestones.css";

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
const STAGGER_MS = 24;        // the intro builds the bars one after another

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const prefersReduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type View = { z: number; pan: number };

/** How many of the (date-sorted) times are at or before `ms`. */
function countUpTo(times: number[], ms: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ layers

interface LayerProps {
  nights: Event[];
  times: number[];
  people: Catalog["people"];
  attended: Map<string, Set<string>>;
  t0: number; span: number; plotW: number; z: number;
  /** Visible window in ms, already bucketed (see the Timeline body). */
  lo: number; hi: number;
  barW: number; barsH: number; axisY: number; lanesY: number; longest: number;
  trace: Trace | null;
  selected: string | null;
  inRange: Set<string> | null;
  /** While the playhead is out: how many nights it has passed. Null otherwise. */
  upTo: number | null;
  /** Still in the intro: bars arrive one after another. */
  stagger: boolean;
  /** Sound mode: each night's sound. Null in the usual night-type colouring. */
  sounds: Map<string, NightSound> | null;
  /** Sound mode: the family being looked at (legend hover, focus or pin). */
  highlight: string | null;
}

const NEUTRAL = "hsl(240 8% 46%)";
/** Sound mode's colour for a night: its dominant family, or grey when too little is known. */
const soundColour = (s: NightSound | undefined) =>
  s?.enough && s.dominant ? familyColour(s.dominant) : NEUTRAL;

/** Bars and lane marks, at the current zoom, unpanned (the parent translates). */
const NightsLayer = memo(function NightsLayer(p: LayerProps) {
  const { nights, times, people, attended, t0, span, plotW, z, lo, hi, barW, barsH, axisY, lanesY, longest, trace, selected, inRange, upTo, stagger, sounds, highlight } = p;
  const out: React.ReactElement[] = [];
  for (let i = 0; i < nights.length; i++) {
    const ms = times[i];
    if (ms < lo || ms > hi) continue;
    const n = nights[i];
    const x = GUTTER + ((ms - t0) / span) * plotW * z;
    const h = 16 + (n.durationSec / longest) * (barsH - 36);
    const on = (!trace || trace.nights.has(n.id)) && (upTo === null || i < upTo);
    const snd = sounds?.get(n.id);
    const colour = sounds ? soundColour(snd) : nightColour(n);
    const isSel = selected === n.id;
    const lit = !sounds || !highlight || (snd?.enough && snd.dominant === highlight);
    const faded = (inRange && !inRange.has(n.id) ? 0.4 : 1) * (lit ? 1 : 0.18);
    const op = (on ? (isSel ? 1 : 0.84) : 0.1) * faded;
    const who = attended.get(n.id);
    out.push(
      // data-n lets one parent handler do hover and click for every night.
      <g key={n.id} data-n={n.id} className={`tl-night${on ? " on" : ""}`}
        style={{ cursor: "pointer", ["--hov" as string]: faded }}>
        <rect x={x - barW / 2 - 4} y={axisY - h - 10} width={barW + 8} height={h + 14} fill="transparent" />
        <rect className="bar-in tl-barrect"
          x={x - barW / 2} y={axisY - h} width={barW} height={h} rx={3}
          fill={colour} opacity={op}
          filter={isSel || (on && trace) ? "url(#tl-glow)" : undefined}
          stroke={isSel ? "#fff" : "none"} strokeWidth={isSel ? 1.4 : 0}
          style={stagger ? { transitionDelay: `${i * STAGGER_MS}ms` } : undefined} />
        {trace && on && <circle cx={x} cy={axisY - h - 8} r={3.4} fill={colour} />}
        {who && people.map((pp, k) => who.has(pp.id) && (
          <rect key={pp.id} className="bar-in lane-mark"
            x={x - Math.max(barW / 2, 3)} y={lanesY + k * LANE_H + 5}
            width={Math.max(barW, 6)} height={LANE_H - 10} rx={3}
            fill={personColour(k)}
            opacity={(on ? 0.9 : 0.08) * faded
              * (trace?.kind === "person" && trace.id !== pp.id ? 0.25 : 1)}
            style={stagger ? { transitionDelay: `${i * STAGGER_MS + k * 14}ms` } : undefined} />
        ))}
      </g>,
    );
  }
  return <>{out}</>;
});

// -------------------------------------------------------------- milestones

const TICKER_MS = 4500;       // how long a card stays, in playing time
const TICKER_MAX = 3;
const ANNOUNCE_MS = 2200;     // screen readers hear at most one batch per this long

/** A milestone's glyph, centred on (cx, cy). The shape tells the kind apart without colour. */
function Glyph({ shape, kind, cx, cy, r }: { shape: Shape; kind: MilestoneKind; cx: number; cy: number; r: number }) {
  const cls = `ms-glyph ms-k-${kind}`;
  switch (shape) {
    case "circle": return <circle className={cls} cx={cx} cy={cy} r={r} />;
    case "ring": return <circle className={`${cls} line`} cx={cx} cy={cy} r={r - 0.9} />;
    case "diamond": return <path className={cls} d={`M${cx} ${cy - r - 1}L${cx + r + 1} ${cy}L${cx} ${cy + r + 1}L${cx - r - 1} ${cy}Z`} />;
    case "triangle": return <path className={cls} d={`M${cx} ${cy - r}L${cx + r} ${cy + r * 0.8}L${cx - r} ${cy + r * 0.8}Z`} />;
    case "square": return <rect className={cls} x={cx - r * 0.8} y={cy - r * 0.8} width={r * 1.6} height={r * 1.6} />;
    case "plus": return <path className={`${cls} line`} d={`M${cx - r} ${cy}H${cx + r}M${cx} ${cy - r}V${cy + r}`} />;
    case "bar": return <rect className={cls} x={cx - r * 0.45} y={cy - r - 1} width={r * 0.9} height={r * 2 + 2} rx={1} />;
    case "star": return <path className={cls} d={`M${cx} ${cy - r - 1}L${cx + r * 0.35} ${cy - r * 0.35}L${cx + r + 1} ${cy}L${cx + r * 0.35} ${cy + r * 0.35}L${cx} ${cy + r + 1}L${cx - r * 0.35} ${cy + r * 0.35}L${cx - r - 1} ${cy}L${cx - r * 0.35} ${cy - r * 0.35}Z`} />;
  }
}
const MsIcon = ({ kind, size = 14 }: { kind: MilestoneKind; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className={`ms-k-${kind}`}>
    <Glyph shape={SHAPE[kind]} kind={kind} cx={7} cy={7} r={4.4} />
  </svg>
);

/** One small glyph per milestone night, under the axis. Sits inside the pan group, like the bars. */
const MilestoneMarks = memo(function MilestoneMarks({ nights, times, byNight, t0, span, plotW, z, lo, hi, axisY, upTo }: {
  nights: Event[]; times: number[]; byNight: Map<string, Milestone[]>;
  t0: number; span: number; plotW: number; z: number; lo: number; hi: number; axisY: number; upTo: number | null;
}) {
  const out: React.ReactElement[] = [];
  for (let i = 0; i < nights.length; i++) {
    const ms = byNight.get(nights[i].id);
    if (!ms || times[i] < lo || times[i] > hi || (upTo !== null && i >= upTo)) continue;
    const x = GUTTER + ((times[i] - t0) / span) * plotW * z;
    const label = `${nights[i].date}: ${ms.map((m) => m.text).join("; ")}`;
    out.push(
      <g key={nights[i].id} data-n={nights[i].id} className="ms-mark" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx={x} cy={axisY + 9} r={8} fill="transparent" />
        <Glyph shape={SHAPE[ms[0].kind]} kind={ms[0].kind} cx={x} cy={axisY + 9} r={4} />
        {ms.length > 1 && <Glyph shape={SHAPE[ms[1].kind]} kind={ms[1].kind} cx={x + 8} cy={axisY + 9} r={2.6} />}
      </g>,
    );
  }
  return <>{out}</>;
});

/** The overview strip's bars: static unless the trace changes. */
const MiniBars = memo(function MiniBars({ nights, times, t0, span, plotW, longest, trace, sounds, highlight }: {
  nights: Event[]; times: number[]; t0: number; span: number; plotW: number; longest: number; trace: Trace | null;
  sounds: Map<string, NightSound> | null; highlight: string | null;
}) {
  return (
    <>
      {nights.map((n, i) => {
        const h = 6 + (n.durationSec / longest) * 30;
        const x = GUTTER + ((times[i] - t0) / span) * plotW;
        return (
          <rect key={n.id} x={x - 1.2} y={44 - h} width={2.4} height={h}
            fill={sounds ? soundColour(sounds.get(n.id)) : nightColour(n)}
            opacity={(trace && !trace.nights.has(n.id) ? 0.15 : 0.8)
              * (sounds && highlight && !(sounds.get(n.id)?.enough && sounds.get(n.id)?.dominant === highlight) ? 0.2 : 1)} />
        );
      })}
    </>
  );
});

// --------------------------------------------------------------- component

export default function Timeline({
  cat, trace, onClearTrace, selected, onSelect, range, onRange, onInsights, enrich = null, onMilestoneLink,
}: {
  cat: Catalog;
  trace: Trace | null;
  onClearTrace: () => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  range: Range | null;
  onRange: (r: Range | null) => void;
  onInsights: () => void;
  /** Genre and year per song; absent until the vault has opened, and partial. */
  enrich?: EnrichMap | null;
  /** Open the person, artist or song a milestone is about. Without it, milestone rows have no such link. */
  onMilestoneLink?: (link: MilestoneLink) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  const [vh, setVh] = useState(() => window.innerHeight);
  const [view, setView] = useState<View>({ z: 1, pan: 0 });
  const viewRef = useRef<View>({ z: 1, pan: 0 });      // what is on screen right now
  const target = useRef<View>({ z: 1, pan: 0 });       // where it is heading
  const startLoop = useRef<() => void>(() => {});
  const [hover, setHover] = useState<string | null>(null);
  const [mode, setMode] = useState<"pan" | "select">("pan");
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [settled, setSettled] = useState(false);      // the intro has finished
  const [playhead, setPlayhead] = useState<number | null>(null);
  const phRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speedSaved, setSpeed] = useSessionState<number>("timeline.speed", 1);
  const speed = (SPEEDS as readonly number[]).includes(speedSaved) ? speedSaved : 1;
  const [pauseMs, setPauseMs] = useSessionState<boolean>("timeline.pauseOnMilestones", true);

  const drag = useRef<{
    kind: "pan" | "select"; x0: number; pan0: number; lastX: number; lastT: number;
    v: number; moved: boolean; t0ms: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const commit = (v: View) => { viewRef.current = v; setView(v); };
  /** Head for a new view; the loop below eases there and then goes back to sleep. */
  const aim = useCallback((v: View) => { target.current = v; startLoop.current(); }, []);
  const setPh = (v: number | null) => { phRef.current = v; setPlayhead(v); };

  // ------------------------------------------------------------------ data

  const { nights, at } = useMemo(() => cumulative(cat), [cat]);
  const people = cat.people;
  const times = useMemo(() => nights.map((n) => Date.parse(n.date!)), [nights]);
  const attended = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of nights) m.set(e.id, new Set(e.people));
    return m;
  }, [nights]);
  // Sound mode: only offered when enrichment exists. The choice is remembered for the tab session.
  const [colourBy, setColourBy] = useSessionState<"type" | "sound">("timeline.colourBy", "type");
  const [pinFam, setPinFam] = useState<string | null>(null);
  const [lookFam, setLookFam] = useState<string | null>(null);
  const allSounds = useMemo(() => (enrich ? nightSounds(cat.tracks, enrich) : null), [cat, enrich]);
  const sounds = enrich && colourBy === "sound" ? allSounds : null;
  const highlight = sounds ? lookFam ?? pinFam : null;
  const legend = useMemo(() => {
    if (!allSounds) return [];
    return legendCounts(nights.map((n) => allSounds.get(n.id)).filter((s): s is NightSound => !!s));
  }, [allSounds, nights]);
  const thinNights = useMemo(
    () => (allSounds ? nights.filter((n) => !allSounds.get(n.id)?.enough).length : 0), [allSounds, nights]);
  const byId = useMemo(() => new Map(nights.map((n) => [n.id, n])), [nights]);
  const personName = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);

  const { t0, span } = useMemo(() => {
    if (!times.length) return { t0: 0, span: 1 };
    const first = times[0];
    const last = times[times.length - 1];
    const pad = (last - first) * 0.03 + 30 * DAY;
    return { t0: first - pad, span: last - first + pad * 2 };
  }, [times]);
  const longest = useMemo(() => Math.max(...nights.map((n) => n.durationSec), 1), [nights]);

  // -------------------------------------------------------------- geometry

  const plotW = Math.max(width - GUTTER, 200);
  const inner = plotW * view.z;
  const barsH = clamp(Math.round(vh * 0.3), 170, 300);
  const axisY = barsH + 12;
  const lanesY = axisY + 34;
  const totalH = lanesY + people.length * LANE_H + 10;

  /** x on screen for a date, in a given view (default: the one on screen). */
  const xOf = (ms: number, v: View = view) => GUTTER + ((ms - t0) / span) * plotW * v.z + v.pan;
  /** x inside the translated group: zoom applied, pan not. */
  const xIn = (ms: number) => GUTTER + ((ms - t0) / span) * plotW * view.z;
  const msAt = (x: number, v: View = view) => t0 + ((x - GUTTER - v.pan) / (plotW * v.z)) * span;
  const maxPan = (z: number) => Math.max(0, plotW * z - plotW);
  const clampPan = (p: number, z: number) => clamp(p, -maxPan(z), 0);

  // ------------------------------------------------------------- lifecycle

  const [introMs] = useState(() => 80 + nights.length * STAGGER_MS + 1000);
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
    // Once the intro is over the bars stop carrying their staggered delays,
    // or every later change (play, trace) would arrive up to seconds late.
    const t2 = setTimeout(() => setSettled(true), introMs);
    return () => {
      ro.disconnect(); window.removeEventListener("resize", measure);
      later.forEach(clearTimeout); clearTimeout(t); clearTimeout(t2);
    };
  }, [introMs]);

  // Zoom and pan ease toward their targets, so nothing ever jumps. The loop
  // only runs while there is distance left to cover.
  useEffect(() => {
    let raf = 0;
    const reduced = prefersReduced();
    const tick = () => {
      raf = 0;
      const tg = target.current, v = viewRef.current;
      const dz = tg.z - v.z, dp = tg.pan - v.pan;
      if (reduced || (Math.abs(dz) < 0.002 && Math.abs(dp) < 0.4)) {
        if (v.z !== tg.z || v.pan !== tg.pan) commit({ z: tg.z, pan: tg.pan });
        return;
      }
      commit({ z: v.z + dz * 0.2, pan: v.pan + dp * 0.2 });
      raf = requestAnimationFrame(tick);
    };
    startLoop.current = () => { if (!raf) raf = requestAnimationFrame(tick); };
    return () => { cancelAnimationFrame(raf); startLoop.current = () => {}; };
  }, []);

  // The window got narrower or wider: keep the pan inside the new bounds.
  useEffect(() => {
    const tg = target.current;
    const pan = clampPan(tg.pan, tg.z);
    if (pan !== tg.pan) aim({ z: tg.z, pan });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotW]);

  // A non-passive wheel listener: React's own onWheel cannot preventDefault.
  // Vertical scroll zooms around the pointer; a sideways swipe pans.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const tg = target.current;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        aim({ z: tg.z, pan: clamp(tg.pan - e.deltaX, -Math.max(0, plotW * tg.z - plotW), 0) });
        return;
      }
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - GUTTER;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;      // Firefox reports lines, not pixels
      const z = clamp(tg.z * Math.exp(-dy * 0.0016), 1, MAX_ZOOM);
      const ratio = z / tg.z;
      aim({ z, pan: clamp(cx - (cx - tg.pan) * ratio, -Math.max(0, plotW * z - plotW), 0) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [plotW, aim]);

  // Milestones, over the whole library (never the range or the zoom): see src/milestones.ts.
  const allMs = useMemo(() => milestonesOf(cat), [cat]);
  const msByNight = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const x of allMs) { const l = m.get(x.eventId); if (l) l.push(x); else m.set(x.eventId, [x]); }
    return m;
  }, [allMs]);

  // Playback: the playhead sweeps the decade, easing down on nights with milestones (src/playpace.ts).
  // Under reduced motion it does not dwell: the sweep is as it always was, only slower.
  const reducedMotion = useMemo(() => prefersReduced(), []);
  const pacer = useMemo(() => createPacer({
    start: t0, end: t0 + span, baseSeconds: BASE_SECONDS,
    stops: nights.flatMap((n, i) => {
      const ms = msByNight.get(n.id);
      return ms ? [{ pos: times[i], chars: ms.reduce((c, m) => c + m.text.length + (m.detail?.length ?? 0), 0) }] : [];
    }),
  }), [nights, times, msByNight, t0, span]);
  const dwellPause = pauseMs && !reducedMotion;
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 100); last = now;       // a hidden tab must not leap
      const r = pacer.step(dt, { speed, pause: dwellPause });
      setPh(r.pos);
      if (r.done) { setPlaying(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, dwellPause, pacer]);

  // While playing, keep the playhead in view.
  useEffect(() => {
    if (playhead === null || !playing || target.current.z <= 1.01) return;
    const tg = target.current;
    const x = xOf(playhead, tg);
    if (x < GUTTER + 40 || x > width - 80) {
      aim({ z: tg.z, pan: clampPan(tg.pan - (x - (GUTTER + plotW * 0.3)), tg.z) });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead]);

  const startPlay = () => {
    if (phRef.current === null || phRef.current >= t0 + span - 1) { setPh(t0); pacer.seek(t0); }
    setPlaying(true);
  };
  const stopPlay = () => { setPlaying(false); setPh(null); pacer.seek(t0); };
  const changeSpeed = (d: number) => {
    const i = (SPEEDS as readonly number[]).indexOf(speed) + d;
    if (i >= 0 && i < SPEEDS.length) setSpeed(SPEEDS[i]);
  };

  // ------------------------------------------------------------ interaction

  const revealNight = (id: string) => {
    const i = nights.findIndex((n) => n.id === id);
    if (i < 0) return;
    const tg = target.current;
    const x = xOf(times[i], tg);
    if (x < GUTTER + 30 || x > width - 30) {
      aim({ z: tg.z, pan: clampPan(tg.pan - (x - (GUTTER + plotW / 2)), tg.z) });
    }
  };

  const zoomBy = (f: number) => {
    const tg = target.current;
    const z = clamp(tg.z * f, 1, MAX_ZOOM);
    const c = plotW / 2, ratio = z / tg.z;
    aim({ z, pan: clampPan(c - (c - tg.pan) * ratio, z) });
  };
  const resetView = () => aim({ z: 1, pan: 0 });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") { onSelect(null); setMode("pan"); setDraft(null); drag.current = null; return; }
    if (e.key === "[" || e.key === "]") { e.preventDefault(); changeSpeed(e.key === "]" ? 1 : -1); return; }
    if (e.key === " ") { e.preventDefault(); playing ? setPlaying(false) : startPlay(); return; }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.8); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.8); return; }
    if (e.key === "0") { e.preventDefault(); resetView(); return; }
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (!nights.length) return;
    const i = nights.findIndex((n) => n.id === (selected ?? hover));
    const j = e.key === "Home" ? 0 : e.key === "End" ? nights.length - 1
      : clamp(i < 0 ? 0 : i + step, 0, nights.length - 1);
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
      setHover(null);                                 // no tooltip while dragging
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
      commit({ z: viewRef.current.z, pan });          // follow the pointer exactly
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
      aim({ z: tg.z, pan: clampPan(tg.pan + d.v * 260, tg.z) });
    }
  };

  const cancel = () => { drag.current = null; setDraft(null); };

  const nightOf = (e: React.SyntheticEvent): string | null =>
    (e.target as Element).closest?.("[data-n]")?.getAttribute("data-n") ?? null;
  const overNight = (e: React.MouseEvent) => {
    if (drag.current?.moved) return;
    const id = nightOf(e);
    if (id && id !== hover) setHover(id);
  };
  const clickNight = (e: React.MouseEvent) => {
    if (suppressClick.current) return;
    const id = nightOf(e);
    if (id) onSelect(selected === id ? null : id);
  };

  // Minimap: click or drag to move the window.
  const mini = useRef<SVGSVGElement>(null);
  const miniTo = (clientX: number) => {
    const r = mini.current!.getBoundingClientRect();
    const frac = clamp((clientX - r.left - GUTTER) / plotW, 0, 1);
    const tg = target.current;
    aim({ z: tg.z, pan: clampPan(-(frac * plotW * tg.z - plotW / 2), tg.z) });
  };

  // --------------------------------------------------------------- derived

  const hovered = hover ? byId.get(hover) ?? null : null;
  const selectedNight = selected ? byId.get(selected) ?? null : null;
  const inRangeSet = useMemo(() => {
    if (!range) return null;
    return new Set(nights.filter((n) => n.date! >= range.from && n.date! <= range.to).map((n) => n.id));
  }, [nights, range]);
  const rangeStats = useMemo(() => {
    const ns = nights.filter((n) => inRangeSet?.has(n.id));
    return { nights: ns.length, hours: ns.reduce((s, n) => s + n.durationSec, 0) / 3600 };
  }, [nights, inRangeSet]);

  const selectedSound = (() => {
    const s = sounds && selectedNight ? sounds.get(selectedNight.id) : null;
    if (!s) return "";
    return s.enough && s.dominant
      ? `, mostly ${familyLabel(s.dominant)} (${Math.round(s.share * 100)}%)`
      : ", not enough known songs to say what it sounded like";
  })();

  const upTo = playhead === null ? null : countUpTo(times, playhead);
  const now = playhead === null ? null : at[(upTo ?? 0) - 1] ?? { nights: 0, songs: 0, canon: 0, people: 0 };

  // ------------------------------------------------------------ milestones
  const nightIdx = useMemo(() => new Map(nights.map((n, i) => [n.id, i])), [nights]);
  const reduced = reducedMotion;
  const [msOpen, setMsOpen] = useSessionState<boolean>("timeline.milestonesOpen", true);
  const [ticker, setTicker] = useState<{ m: Milestone; until: number }[]>([]);
  const clock = useRef(0);                       // real time spent playing, ms: stands still while paused
  const lastTick = useRef(0);
  const lastUp = useRef(0);
  const [announce, setAnnounce] = useState("");
  const pending = useRef<string[]>([]);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const atEnd = playhead !== null && playhead >= t0 + span - 1;
  const tickerRuns = playing || atEnd;

  // Nights the playhead has just passed bring their milestones onto the ticker.
  useEffect(() => {
    if (upTo === null) { lastUp.current = 0; setTicker([]); return; }
    const from = lastUp.current;
    lastUp.current = upTo;
    if (upTo < from) { setTicker([]); return; }
    if (upTo === from) return;
    const fresh: Milestone[] = [];
    for (let i = upTo - 1; i >= from; i--) fresh.push(...(msByNight.get(nights[i]?.id) ?? []));
    if (!fresh.length) return;
    if (!reduced) {
      // On screen at least TICKER_MS of real time, and through the whole dwell plus a beat to read it.
      const dw = pacer.dwell;
      const until = clock.current + Math.max(TICKER_MS, dw ? dw.total - dw.elapsed + 1500 : 0);
      setTicker((old) => [...fresh.map((m) => ({ m, until })), ...old].slice(0, TICKER_MAX));
    }
    // Screen readers: batch what arrived, at most one announcement per ANNOUNCE_MS.
    pending.current.push(...fresh.slice().reverse().map((m) => `${m.date.slice(0, 4)}, ${m.text}`));
    if (!announceTimer.current) {
      announceTimer.current = setTimeout(() => {
        announceTimer.current = null;
        const p = pending.current; pending.current = [];
        if (p.length) setAnnounce(p.slice(0, 2).join(". ") + (p.length > 2 ? `. And ${p.length - 2} more.` : "."));
      }, ANNOUNCE_MS);
    }
  }, [upTo, msByNight, nights, reduced, pacer]);
  useEffect(() => () => { if (announceTimer.current) clearTimeout(announceTimer.current); }, []);

  // Cards fade by wall-clock time that only runs while playing, and never while the playhead is
  // dwelling: pausing stops the clock, so they wait.
  useEffect(() => {
    if (!tickerRuns || reduced) return;
    lastTick.current = performance.now();
    const id = setInterval(() => {
      const t = performance.now();
      clock.current += t - lastTick.current; lastTick.current = t;
      setTicker((old) => {
        const dwelling = playing && pacer.dwell !== null;
        const keep = old.filter((c) => dwelling || clock.current < c.until);
        return keep.length === old.length ? old : keep;
      });
    }, 200);
    return () => clearInterval(id);
  }, [tickerRuns, reduced, pacer, playing]);

  const shownMs = useMemo(
    () => (upTo === null ? allMs : allMs.filter((m) => (nightIdx.get(m.eventId) ?? 0) < upTo)),
    [allMs, nightIdx, upTo]);
  const msYears = useMemo(() => {
    const g: { year: string; items: Milestone[] }[] = [];
    for (const m of shownMs) {
      const y = m.date.slice(0, 4);
      if (!g.length || g[g.length - 1].year !== y) g.push({ year: y, items: [] });
      g[g.length - 1].items.push(m);
    }
    return g;
  }, [shownMs]);
  const jumpTo = (id: string) => { onSelect(id); revealNight(id); };

  const years = useMemo(() => {
    const a = new Date(t0).getUTCFullYear(), b = new Date(t0 + span).getUTCFullYear();
    const all: number[] = [];
    for (let y = a; y <= b; y++) all.push(y);
    const every = Math.max(1, Math.ceil((all.length * 52) / Math.max(inner, 1)));
    return all.filter((_, i) => i % every === 0);
  }, [t0, span, inner]);

  const barW = clamp((plotW * view.z) / Math.max(nights.length, 1) * 0.42, 5, 22);

  // The nights worth drawing: the screen plus half a screen each side, snapped
  // to half-screen steps so a pan inside one step leaves the layer untouched.
  const visSpan = span / view.z;
  const bucket = visSpan / 2;
  const leftMs = t0 - (view.pan / (plotW * view.z)) * span;
  const lo = Math.floor((leftMs - visSpan * 0.5) / bucket) * bucket;
  const hi = Math.ceil((leftMs + visSpan * 1.5) / bucket) * bucket;

  const atMin = view.z <= 1.001;
  const atMax = view.z >= MAX_ZOOM - 0.01;
  const homeView = atMin && Math.abs(view.pan) < 0.5;

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
            {nights.length} nights · drag to pan · scroll to zoom · click a night to open it
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className={`tl-zoom${mode === "select" ? " on" : ""}`}
          aria-pressed={mode === "select"}
          onClick={() => setMode(mode === "select" ? "pan" : "select")}
          title="Drag across the timeline to pick a range (or hold shift while dragging)">
          select range
        </button>
        <button className="tl-zoom" aria-label="Zoom out" title="Zoom out (−)" aria-disabled={atMin}
          onClick={() => zoomBy(1 / 1.8)}>−</button>
        <button className="tl-zoom" title="Show the whole decade (0)" aria-disabled={homeView}
          onClick={resetView}>reset</button>
        <button className="tl-zoom" aria-label="Zoom in" title="Zoom in (+)" aria-disabled={atMax}
          onClick={() => zoomBy(1.8)}>+</button>
        <span className="tl-sep" />
        <button className={`tl-play${playing ? " on" : ""}`}
          onClick={() => (playing ? setPlaying(false) : startPlay())}>
          {playing ? "❚❚ pause" : playhead !== null ? "▶ resume" : "▶ play the decade"}
        </button>
        {playhead !== null && (
          <button className="tl-zoom" aria-label="Stop and clear the playhead" onClick={stopPlay}>■</button>
        )}
        <span className="tl-speed" role="group" aria-label="Playback speed" title="Playback speed ( [ slower, ] faster )">
          {SPEEDS.map((v) => (
            <button key={v} className={`tl-zoom${speed === v ? " on" : ""}`} aria-pressed={speed === v}
              onClick={() => setSpeed(v)}>{v}×</button>
          ))}
        </span>
        <label className="tl-pausechk" title="Slow down on nights with milestones so they can be read">
          <input type="checkbox" checked={pauseMs} onChange={(e) => setPauseMs(e.target.checked)} />
          Pause on milestones
        </label>
        {playhead !== null && (
          <span className="tl-progress" aria-label="Playback position">
            {new Date(playhead).getUTCFullYear()} · night {Math.min(Math.max(upTo ?? 0, 1), nights.length)} of {nights.length}
          </span>
        )}
      </div>

      {enrich && (
        <div className="tl-sound">
          <span className="tl-dim" id="tl-colourby">Colour by</span>
          <span role="group" aria-labelledby="tl-colourby" className="tls-toggle">
            <button className={`tl-zoom${colourBy === "type" ? " on" : ""}`} aria-pressed={colourBy === "type"}
              title="The kind of night: roll, trip and so on"
              onClick={() => setColourBy("type")}>Night type</button>
            <button className={`tl-zoom${colourBy === "sound" ? " on" : ""}`} aria-pressed={colourBy === "sound"}
              title="The genre family most of the night's known songs belong to"
              onClick={() => setColourBy("sound")}>Sound</button>
          </span>
          {colourBy === "sound" && (
            <>
              <ul className="tls-legend" aria-label="Genre families, with the number of nights each leads">
                {legend.map(({ family, nights: k }) => (
                  <li key={family}>
                    <button className={`tls-chip${pinFam === family ? " on" : ""}`}
                      aria-pressed={pinFam === family}
                      title={`${k} night${k === 1 ? "" : "s"} led by ${familyLabel(family)}. Click to show only those.`}
                      onMouseEnter={() => setLookFam(family)} onMouseLeave={() => setLookFam(null)}
                      onFocus={() => setLookFam(family)} onBlur={() => setLookFam(null)}
                      onClick={() => setPinFam(pinFam === family ? null : family)}>
                      <i className="tls-sw" style={{ background: familyColour(family) }} aria-hidden="true" />
                      {familyLabel(family)} <b>{k}</b>
                    </button>
                  </li>
                ))}
                <li className="tls-thin">
                  <i className="tls-sw grey" aria-hidden="true" />
                  not enough known <b>{thinNights}</b>
                </li>
              </ul>
              <span className="tl-dim tls-note">
                Genres are known for part of the library; a night needs 30% of its songs known to take a colour.
              </span>
            </>
          )}
        </div>
      )}

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
        role="group"
        aria-roledescription="timeline"
        aria-label={`Timeline of ${nights.length} nights. Arrow keys step through the nights, plus and minus zoom, zero resets, space plays or pauses, left and right bracket change speed, escape clears.`}
        onKeyDown={onKey}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
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

            {/* everything below is laid out for this zoom and slid sideways by the pan */}
            <g transform={`translate(${view.pan} 0)`}>
              {years.map((y) => {
                const x = xIn(Date.UTC(y, 0, 1));
                return (
                  <g key={y}>
                    <line x1={x} y1={0} x2={x} y2={totalH} stroke="rgba(150,120,255,0.07)" />
                    <text x={x + 5} y={axisY + 20} className="tl-year">{y}</text>
                  </g>
                );
              })}

              {range && (() => {
                const x1 = xIn(Date.parse(range.from)), x2 = xIn(Date.parse(range.to));
                return <rect x={x1} y={0} width={Math.max(x2 - x1, 2)} height={totalH} className="tl-range" />;
              })()}
              {draft && (() => {
                const x1 = xIn(Math.min(draft.a, draft.b)), x2 = xIn(Math.max(draft.a, draft.b));
                return <rect x={x1} y={0} width={Math.max(x2 - x1, 1)} height={totalH} className="tl-range draft" />;
              })()}

              <g onMouseOver={overNight} onClick={clickNight}>
                <NightsLayer
                  nights={nights} times={times} people={people} attended={attended}
                  t0={t0} span={span} plotW={plotW} z={view.z} lo={lo} hi={hi}
                  barW={barW} barsH={barsH} axisY={axisY} lanesY={lanesY} longest={longest}
                  trace={trace} selected={selected} inRange={inRangeSet} upTo={upTo}
                  stagger={!settled} sounds={sounds} highlight={highlight} />
                <MilestoneMarks
                  nights={nights} times={times} byNight={msByNight} t0={t0} span={span} plotW={plotW}
                  z={view.z} lo={lo} hi={hi} axisY={axisY} upTo={upTo} />
              </g>

              {playhead !== null && (() => {
                const x = xIn(playhead);
                return (
                  <g>
                    <line x1={x} y1={0} x2={x} y2={totalH} className="tl-head" />
                    <circle cx={x} cy={axisY} r={5} className="tl-headdot" />
                  </g>
                );
              })()}
            </g>
          </g>
        </svg>

        {playhead !== null && ticker.length > 0 && (
          <div className={`ms-ticker${tickerRuns ? "" : " paused"}`} aria-hidden="true"
            style={{ left: clamp(xOf(playhead) + 14, GUTTER + 8, Math.max(width - 250, GUTTER + 8)) }}>
            {ticker.map(({ m }) => (
              <div key={m.id} className={`ms-card ms-k-${m.kind}`}>
                <MsIcon kind={m.kind} />
                <span><b>{m.text}</b>{m.detail && <span className="ms-sub">{m.detail}</span>}</span>
              </div>
            ))}
          </div>
        )}

        {hovered && (
          <div className="tl-tip" style={{
            left: clamp(xOf(Date.parse(hovered.date!)), GUTTER + 150, Math.max(width - 150, GUTTER + 150)),
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
            {sounds && (() => {
              const s = sounds.get(hovered.id);
              if (!s) return <div className="tl-dim">no song data for this night</div>;
              return s.enough && s.dominant ? (
                <div className="tls-tip">
                  mostly <b style={{ color: familyColour(s.dominant) }}>{familyLabel(s.dominant)}</b> ({Math.round(s.share * 100)}%
                  {" "}of {s.known} known songs)
                  {s.decade ? ` · median decade ${s.decade}s` : ""}
                </div>
              ) : (
                <div className="tls-tip">
                  not enough known ({s.known} of {s.total} songs, {Math.round(s.coverage * 100)}%)
                  {s.decade ? ` · median decade ${s.decade}s` : ""}
                </div>
              );
            })()}
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
        role="img" aria-label="Overview of every night. Click or drag to move the view."
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); miniTo(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons === 1) miniTo(e.clientX); }}>
        <text x={14} y={30} className="tl-lane">overview</text>
        <rect x={GUTTER} y={6} width={plotW} height={40} rx={6} className="tl-minibg" />
        <MiniBars nights={nights} times={times} t0={t0} span={span} plotW={plotW} longest={longest} trace={trace}
          sounds={sounds} highlight={highlight} />
        {range && (
          <rect x={GUTTER + ((Date.parse(range.from) - t0) / span) * plotW} y={6}
            width={Math.max(((Date.parse(range.to) - Date.parse(range.from)) / span) * plotW, 2)} height={40}
            className="tl-range" />
        )}
        <rect className="tl-window"
          x={GUTTER + clamp(-view.pan / (plotW * view.z), 0, 1) * plotW} y={4}
          width={Math.max(plotW / view.z, 8)} height={44} rx={6} />
      </svg>

      <p className="tl-help">
        <b>Drag</b> to pan · <b>scroll</b> or <b>+ −</b> to zoom · <b>shift-drag</b> selects a range ·
        {" "}<b>← →</b> step through nights (click the chart first) · <b>space</b> plays or pauses · <b>[</b> <b>]</b> slower or faster · <b>0</b> resets · <b>esc</b> clears
      </p>
      <section className="ms-panel" aria-labelledby="ms-title">
        <h3 className="ms-title" id="ms-title">
          <button className="ms-toggle" aria-expanded={msOpen} aria-controls="ms-body"
            onClick={() => setMsOpen(!msOpen)}>
            <span className="ms-caret" aria-hidden="true">▶</span>
            Milestones
            <span className="ms-count">
              {upTo === null ? allMs.length : `${shownMs.length} of ${allMs.length} so far`}
            </span>
          </button>
        </h3>
        {msOpen && (
          <div className="ms-body" id="ms-body">
            {msYears.length === 0 && (
              <p className="ms-empty">{allMs.length ? "None yet. They appear as the playhead passes each night." : "No milestones in this library."}</p>
            )}
            {msYears.map((g) => (
              <div key={g.year}>
                <div className="ms-year" role="presentation">{g.year}</div>
                <ul className="ms-list" aria-label={`Milestones in ${g.year}`}>
                  {g.items.map((m) => {
                    const lk = m.link && m.link.type !== "night" && onMilestoneLink ? m.link : null;
                    return (
                      <li key={m.id} className={`ms-item ms-k-${m.kind}`}>
                        <button className="ms-row" onClick={() => jumpTo(m.eventId)}
                          title="Show this night on the timeline">
                          <MsIcon kind={m.kind} />
                          <span className="ms-date">{m.date}</span>
                          <span><span className="ms-text">{m.text}</span>
                            {m.detail && <span className="ms-detail"> · {m.detail}</span>}</span>
                        </button>
                        {lk && (
                          <button className="ms-link" onClick={() => onMilestoneLink!(lk)}
                            aria-label={`Open ${lk.type}: ${m.text}`}>
                            {lk.type === "person" ? "person" : lk.type === "artist" ? "artist" : "song"} →
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
      <span className="tl-sr" aria-live="polite">
        {selectedNight ? `Selected ${selectedNight.date}${selectedNight.title ? `, ${selectedNight.title}` : ""}${selectedSound}` : ""}
      </span>
      <span className="tl-sr" aria-live="polite" role="status">{announce}</span>
    </div>
  );
}
