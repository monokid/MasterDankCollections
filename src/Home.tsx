/** The landing page: the friend group as one living amoeba over the starfield.
 *  The site is private, so touching it (or Enter, or Skip) first asks for the word
 *  (Gate); once the vault is open the screen floods with the creature's colours
 *  (Wash, below) and lands on Search. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EnrichMap } from "./enrich.ts";
import { homeLines, homeSound } from "./timelinesound.ts";
import "./timelinesound.css";
import "./home.css";
import { createAmoeba, type Amoeba } from "./amoeba.ts";
import Gate, { type GateControl } from "./Gate.tsx";
import { hasSession, resume, unlock } from "./vault.ts";

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- debug hook: window.__mdcHome, for driving the transition from tests
type Phase = "idle" | "prompt" | "entering" | "gone";
const hook = {
  phase: "gone" as Phase,
  enter: null as null | (() => void),
  open: null as null | (() => void),
  submit: null as null | ((pw: string) => Promise<boolean>),
  behave: null as null | ((name: string) => boolean),
};
declare global {
  interface Window {
    __mdcHome?: {
      state(): Phase; enter(): void;
      /** Dev builds only. */
      gate?: { open(): void; submit(pw: string): Promise<boolean> };
      /** Dev builds only: run an amoeba behaviour now (bloom, split, reach, jelly, shimmer, sneeze). False if unknown or reduced motion. */
      behave?(name: string): boolean;
    };
  }
}
if (typeof window !== "undefined") {
  window.__mdcHome = { state: () => hook.phase, enter: () => hook.enter?.() };
  if (import.meta.env.DEV) {
    window.__mdcHome.gate = {
      open: () => hook.open?.(),
      submit: (pw) => hook.submit?.(pw) ?? Promise.resolve(false),
    };
    window.__mdcHome.behave = (name) => hook.behave?.(name) ?? false;
  }
}

// ---- the public, aggregate-only teaser (plaintext; no names, no tracks)
interface Teaser {
  nights: number; tracks: number; songs: number; artists: number; contributors: number;
  hours: number; yearFrom: number; yearTo: number; weights: number[];
}
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function parseTeaser(raw: unknown): Partial<Teaser> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<Teaser> = {};
  for (const k of ["nights", "tracks", "songs", "artists", "contributors", "hours", "yearFrom", "yearTo"] as const) {
    if (isNum(r[k])) out[k] = r[k];
  }
  if (Array.isArray(r.weights)) out.weights = r.weights.filter(isNum);
  return Object.keys(out).length ? out : null;
}

const fmt = (n: number) => Math.round(n).toLocaleString();

/** A number that counts up once on load (and just shows itself under reduced motion). */
function Count({ to, delay }: { to: number; delay: number }) {
  const el = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = el.current!;
    if (prefersReducedMotion()) { node.textContent = fmt(to); return; }
    node.textContent = "0";
    let raf = 0;
    const t0 = performance.now() + delay, D = 1500;
    const step = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - t0) / D));
      node.textContent = fmt(to * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, delay]);
  return <b ref={el}>{fmt(to)}</b>;
}

function Stats({ t }: { t: Partial<Teaser> }) {
  const items: { key: string; n?: number; text?: string; label: string }[] = [];
  if (isNum(t.nights)) items.push({ key: "nights", n: t.nights, label: "nights" });
  if (isNum(t.contributors)) items.push({ key: "who", n: t.contributors, label: "contributors" });
  if (isNum(t.songs)) items.push({ key: "songs", n: t.songs, label: "songs" });
  if (isNum(t.artists)) items.push({ key: "artists", n: t.artists, label: "artists" });
  if (isNum(t.hours)) items.push({ key: "hours", n: t.hours, label: "hours of music" });
  if (isNum(t.yearFrom) && isNum(t.yearTo)) {
    items.push({ key: "span", text: t.yearFrom === t.yearTo ? String(t.yearFrom) : `${t.yearFrom}–${t.yearTo}`, label: "" });
  }
  if (!items.length) return null;
  return (
    <p className="home-stats">
      {items.map((it, i) => (
        <span key={it.key} className="stat-item" style={{ ["--i" as string]: i }}>
          {it.n !== undefined ? <Count to={it.n} delay={1300 + i * 150} /> : <b>{it.text}</b>}
          {it.label && ` ${it.label}`}
        </span>
      ))}
    </p>
  );
}

export default function Home({ onEnter, leaving: leavingProp, enrich = null, songTotal }: {
  /** Only there once the vault has opened (so on a return to Home, not the first visit). */
  enrich?: EnrichMap | null;
  songTotal?: number;
  /** The vault is open: start the click-through from this point (viewport px). */
  onEnter: (x: number, y: number) => void;
  /** Optional: Home tracks this itself; accepted so an older caller still compiles. */
  leaving?: boolean;
  /** Ignored: Skip now goes through the gate like everything else. */
  onSkip?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const amoeba = useRef<Amoeba | null>(null);
  const entered = useRef(false);
  const busy = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const touchTimer = useRef(0);
  const gateCtl = useRef<GateControl | null>(null);
  const hostRect = useRef<DOMRect | null>(null);   // read once per resize, not on every pointer move
  const closeTimer = useRef(0);
  const [gate, setGateState] = useState<"closed" | "open" | "closing">("closed");
  const gateRef = useRef(gate);
  const setGate = (g: "closed" | "open" | "closing") => { gateRef.current = g; setGateState(g); };
  const [leaving, setLeaving] = useState(false);
  const [teaser, setTeaser] = useState<Partial<Teaser> | null>(null);
  const [night, setNight] = useState({ k: 0, on: false });
  const soundLines = useMemo(() => homeLines(homeSound(enrich, songTotal)), [enrich, songTotal]);

  useLayoutEffect(() => {
    const a = createAmoeba(hostRef.current!, {
      reduced: prefersReducedMotion(),
      hero: () => heroRef.current?.offsetWidth ?? 0,
      onNight: (k) => setNight((s) => (k > 0 ? { k, on: true } : { ...s, on: false })),
      onCentre: (dx, dy) => {   // the click target follows the wandering body
        heroRef.current?.style.setProperty("--dx", `${dx.toFixed(1)}px`);
        heroRef.current?.style.setProperty("--dy", `${dy.toFixed(1)}px`);
      },
    });
    amoeba.current = a;
    hook.phase = "idle";
    hook.behave = (name) => a.behave(name);
    return () => {
      a.dispose(); amoeba.current = null; hook.phase = "gone";
      hook.enter = hook.open = hook.submit = hook.behave = null;
      window.clearTimeout(touchTimer.current);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  // The host fills the viewport and only changes size on resize; its rect is
  // cached so a pointer move never forces a layout (the hero's position is
  // restyled every frame, which would make each read a fresh layout).
  useLayoutEffect(() => {
    const el = hostRef.current!;
    const ro = new ResizeObserver(() => { hostRect.current = null; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The teaser: aggregate numbers for the footer, and the contributors' shares for the creature.
  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.BASE_URL}data/teaser.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no teaser"))))
      .then((raw) => {
        const t = parseTeaser(raw);
        if (!live || !t) return;
        setTeaser(t);
        const w = t.weights && t.weights.length
          ? t.weights
          : isNum(t.contributors) && t.contributors > 0
            ? Array.from({ length: Math.min(12, Math.round(t.contributors)) }, (_, i) => 1 / (i + 1.6))
            : null;
        if (w) amoeba.current?.setWeights(w);
      })
      .catch(() => { /* no teaser: no stats row, default creature */ });
    return () => { live = false; };
  }, []);

  /** Pointer and click positions, in the viewport's -1..1 space (y up). */
  const toLocal = (cx: number, cy: number) => {
    // While leaving, the host is scaled by CSS; keep the rect from before.
    const r = hostRect.current ??= hostRef.current!.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * 2 - 1, y: -(((cy - r.top) / r.height) * 2 - 1) };
  };

  /** The word was right (or a session was held): flood the screen and land on Search. */
  const proceed = useCallback((x: number, y: number) => {
    if (entered.current) return;                       // double clicks, Enter after click
    entered.current = true;
    hook.phase = "entering";
    setLeaving(true);
    const l = toLocal(x, y);
    amoeba.current?.surge(l.x, l.y);
    if (gateRef.current === "open") {
      setGate("closing");
      closeTimer.current = window.setTimeout(() => setGate("closed"), 500);
    }
    onEnter(x, y);
  }, [onEnter]);

  const openGate = useCallback(() => {
    if (entered.current || gateRef.current !== "closed") return;
    hook.phase = "prompt";
    setGate("open");
  }, []);

  const closeGate = useCallback(() => {
    if (gateRef.current !== "open") return;
    setGate("closed");
    if (!entered.current) hook.phase = "idle";
  }, []);

  /** Touch, click, Enter or Skip: reopen a held session, or ask for the word. */
  const request = useCallback(async (cx?: number, cy?: number) => {
    if (entered.current || busy.current || gateRef.current !== "closed") return;
    const r = heroRef.current!.getBoundingClientRect();
    const x = cx ?? r.left + r.width / 2, y = cy ?? r.top + r.height / 2;
    origin.current = { x, y };
    const l = toLocal(x, y);
    amoeba.current?.burst(l.x, l.y);
    if (hasSession()) {
      busy.current = true;
      let ok = false;
      try { ok = await resume(); } catch { ok = false; }
      busy.current = false;
      if (ok) { proceed(x, y); return; }
    }
    openGate();
  }, [proceed, openGate]);

  /** The gate's call to the vault; a wrong word makes the cell flinch. */
  const attempt = useCallback(async (pw: string) => {
    const ok = await unlock(pw);
    if (!ok) amoeba.current?.flinch();
    return ok;
  }, []);

  useEffect(() => {
    hook.enter = () => { void request(); };
    hook.open = () => {
      const r = heroRef.current!.getBoundingClientRect();
      origin.current ??= { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      openGate();
    };
    hook.submit = async (pw) => {
      hook.open?.();
      await new Promise((res) => setTimeout(res, 60));   // let the panel mount
      return (await gateCtl.current?.submit(pw)) ?? false;
    };
    // Enter anywhere on the page (not on a button, which has its own meaning for it).
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter" && document.activeElement === document.body && gateRef.current === "closed") void request();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [request, openGate]);

  const point = (e: React.PointerEvent) => {
    const l = toLocal(e.clientX, e.clientY);
    amoeba.current?.setPointer(l.x, l.y);
  };

  return (
    <section className={`home${leaving || leavingProp ? " leaving" : ""}`}
      onPointerMove={point}
      onPointerDown={(e) => { window.clearTimeout(touchTimer.current); point(e); }}
      onPointerUp={(e) => {   // a finger lifting is the pointer leaving
        if (e.pointerType === "touch") touchTimer.current = window.setTimeout(() => amoeba.current?.clearPointer(), 700);
      }}
      onPointerCancel={() => amoeba.current?.clearPointer()}
      onPointerLeave={() => amoeba.current?.clearPointer()}>
      <div className="amoeba-host" ref={hostRef} aria-hidden="true" />
      <button className="home-skip" onClick={() => void request()}>Skip to search</button>

      <header className="home-title">
        <h1 className="home-word">
          <span className="hw-top">Master Dank</span>
          <span className="hw-bot">Collections</span>
        </h1>
        <p className="home-tag">a decade of nights, in sound</p>
      </header>

      <div className="home-hero" ref={heroRef}>
        <div className="home-amoeba" role="button" tabIndex={0} aria-label="Enter the collection"
          onClick={(e) => void request(e.detail === 0 ? undefined : e.clientX, e.detail === 0 ? undefined : e.clientY)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void request(); }
          }} />
      </div>

      <footer className="home-foot">
        <p className={`home-night${night.on ? " on" : ""}`} aria-hidden="true">
          {night.k > 0 ? `one night · ${night.k} of us` : " "}
        </p>
        <p className="home-hint"><span className="hint-touch">touch the amoeba</span>
          <span className="hint-key"> · press Enter</span></p>
        {teaser && <Stats t={teaser} />}
        {soundLines.length > 0 && (
          <p className="home-sound">{soundLines.map((l) => <span key={l}>{l}</span>)}</p>
        )}
      </footer>

      {gate !== "closed" && (
        <Gate attempt={attempt} closing={gate === "closing"} control={gateCtl}
          onClose={closeGate}
          returnFocus={() => heroRef.current?.querySelector<HTMLElement>(".home-amoeba") ?? null}
          onSuccess={() => { const o = origin.current; const r = heroRef.current!.getBoundingClientRect(); proceed(o?.x ?? r.left + r.width / 2, o?.y ?? r.top + r.height / 2); }} />
      )}
    </section>
  );
}

// -------------------------------------------------------------------- wash

const FLOOD_MS = 1050;     // colour floods outward from the click
const DISSOLVE_MS = 800;   // ...then dissolves outward to reveal the page behind it
const FEATHER = 260;       // px width of the soft edge

const ease = (x: number) => x * x * (3 - 2 * x);

/** A full-viewport iridescent overlay revealed by a growing circular mask.
 *  Phase 1 it floods in from (x, y); at the peak `onPeak` swaps the view behind
 *  it; phase 2 it dissolves away from the same point. Never captures the pointer. */
export function Wash({ x, y, reduced, onPeak, onDone }: {
  x: number; y: number; reduced: boolean; onPeak: () => void; onDone: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const cbs = useRef({ onPeak, onDone });
  cbs.current = { onPeak, onDone };

  useLayoutEffect(() => { el.current!.style.opacity = "0"; }, []);

  useEffect(() => {
    const node = el.current!;
    let raf = 0, peaked = false, done = false;
    const t0 = performance.now();
    const far = Math.max(Math.hypot(x, y), Math.hypot(innerWidth - x, y),
      Math.hypot(x, innerHeight - y), Math.hypot(innerWidth - x, innerHeight - y)) + FEATHER;
    const setMask = (m: string) => { node.style.maskImage = m; node.style.webkitMaskImage = m; };

    const firePeak = () => { if (!peaked) { peaked = true; cbs.current.onPeak(); } };
    const finish = () => { if (!done) { done = true; firePeak(); cbs.current.onDone(); } };
    // rAF is throttled in background tabs; these guarantee the view switches and the overlay unmounts.
    const total = reduced ? 560 : FLOOD_MS + DISSOLVE_MS;
    const timers = [
      setTimeout(firePeak, (reduced ? 260 : FLOOD_MS) + 120),
      setTimeout(finish, total + 400),
    ];

    const step = (now: number) => {
      if (done) return;
      const e = now - t0;
      if (reduced) {
        // A short crossfade instead of the flood.
        const k = e < 260 ? e / 260 : Math.max(0, 1 - (e - 260 - 40) / 260);
        node.style.opacity = String(Math.min(1, k) * 0.9);
        if (e >= 260) firePeak();
        if (e >= 560) { finish(); return; }
      } else if (e < FLOOD_MS) {
        const r = ease(e / FLOOD_MS) * far;
        node.style.opacity = "1";
        setMask(`radial-gradient(circle at ${x}px ${y}px, #000 ${Math.max(r - FEATHER, 0)}px, transparent ${r}px)`);
      } else {
        firePeak();
        const k = (e - FLOOD_MS) / DISSOLVE_MS;
        if (k >= 1) { finish(); return; }
        const r = ease(k) * far;
        setMask(`radial-gradient(circle at ${x}px ${y}px, transparent ${Math.max(r - FEATHER, 0)}px, #000 ${r}px)`);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
  }, [x, y, reduced]);

  return (
    <div className="wash" ref={el} aria-hidden="true">
      <div className="wash-fx" />
      <div className="wash-fx wash-fx2" />
    </div>
  );
}
