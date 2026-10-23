/** Brand mark: the amoeba, small. A wobbling membrane that never repeats, a
 *  handful of coloured subcells and vacuoles drifting inside, blending where they cross, a slow colour cycle, and now and then
 *  a heartbeat -- a spring kick with a ring rippling out. Drawn straight into
 *  the SVG each frame (a dozen points, no canvas), still under reduced motion.
 *  The favicon (public/favicon.svg) is a frozen frame of the same creature. */
import { useEffect, useRef } from "react";

const N = 9;                 // membrane points
const TAU = Math.PI * 2;
const R = 17;                // resting radius in the 64-unit box
const SUBS = 5;              // coloured subcells inside
// one gradient per subcell, in the app's palette
const HUES: Array<[string, string]> = [["#7be9ff", "#1f7ae0"], ["#ffd27a", "#ff7a3d"], ["#9dffb0", "#19b86b"], ["#ff9be0", "#c424a8"], ["#c9a8ff", "#6a3be0"]];

/** A closed Catmull-Rom spline through the points, as cubic Beziers. */
function blob(p: Array<[number, number]>): string {
  const n = p.length;
  let d = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + "Z";
}

export default function Logo({ onHome }: { onHome: () => void }) {
  const body = useRef<SVGPathElement>(null);
  const rim = useRef<SVGPathElement>(null);
  const cells = useRef<Array<SVGCircleElement | null>>([]);
  const grains = useRef<Array<SVGCircleElement | null>>([]);
  const vac = useRef<Array<SVGCircleElement | null>>([]);
  const ring = useRef<SVGCircleElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const kick = useRef<(power: number) => void>(() => {});

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    // each membrane point has its own two slow waves, and its own pseudopod phase
    const ph = Array.from({ length: N }, () => ({
      a: rnd(0, TAU), b: rnd(0, TAU), fa: rnd(0.35, 0.8), fb: rnd(0.9, 1.7), pod: rnd(0, TAU), pf: rnd(0.12, 0.3),
    }));
    const vph = [0, 1].map(() => ({ a: rnd(0, TAU), r: rnd(4, 9), f: rnd(0.25, 0.6), s: rnd(1.8, 2.8) }));
    // several coloured subcells, each on its own slow orbit; where they cross, they blend
    const sub = Array.from({ length: SUBS }, (_, i) => ({
      a: rnd(0, TAU), r: rnd(2.5, 9.5), f: rnd(0.18, 0.5) * (i % 2 ? 1 : -1), s: rnd(2.3, 4.1), w: rnd(0.8, 1.6), p: rnd(0, TAU),
    }));
    const gr = Array.from({ length: 7 }, () => ({ a: rnd(0, TAU), r: rnd(3, 12), f: rnd(0.1, 0.35), p: rnd(0, TAU) }));

    let t = rnd(0, 50), last = performance.now();
    let x = 0, v = 0;                         // heartbeat spring
    let rippleAt = -1, rippleAmp = 1;
    let next = last + rnd(1800, 4200);
    let raf = 0;

    kick.current = (power: number) => { v = Math.min(v + power, 14); rippleAt = performance.now(); rippleAmp = Math.min(1, power / 9); };

    const draw = (now: number) => {
      const s = 1 + x * 0.11;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < N; i++) {
        const q = ph[i];
        const pod = Math.pow(Math.max(0, Math.sin(t * q.pf + q.pod)), 3) * 4.2;   // a pseudopod swelling now and then
        const wob = 1 + 0.11 * Math.sin(t * q.fa + q.a) + 0.06 * Math.sin(t * q.fb + q.b);
        const r = (R * wob + pod) * s + x * 1.6 * Math.sin(i * 2.1 + t);
        const ang = (i / N) * TAU + t * 0.07;
        pts.push([32 + Math.cos(ang) * r, 32 + Math.sin(ang) * r * 0.94]);
      }
      const d = blob(pts);
      body.current?.setAttribute("d", d);
      rim.current?.setAttribute("d", d);
      sub.forEach((q, i) => {
        const el = cells.current[i];
        if (!el) return;
        const a = q.a + t * q.f;
        el.setAttribute("cx", (32 + Math.cos(a) * q.r * q.w).toFixed(2));
        el.setAttribute("cy", (32 + Math.sin(a * 1.3 + q.p) * q.r * 0.85).toFixed(2));
        el.setAttribute("r", (q.s * (1 + 0.16 * Math.sin(t * 0.9 + q.p) + 0.18 * x)).toFixed(2));
      });
      gr.forEach((q, i) => {
        const el = grains.current[i];
        if (!el) return;
        const a = q.a + t * q.f;
        el.setAttribute("cx", (32 + Math.cos(a) * q.r).toFixed(2));
        el.setAttribute("cy", (32 + Math.sin(a * 0.8 + q.p) * q.r * 0.8).toFixed(2));
      });
      vph.forEach((q, i) => {
        const a = q.a + t * q.f, el = vac.current[i];
        if (!el) return;
        el.setAttribute("cx", (32 + Math.cos(a) * q.r).toFixed(2));
        el.setAttribute("cy", (32 + Math.sin(a * 1.2) * q.r * 0.8).toFixed(2));
        el.setAttribute("r", (q.s * (1 + 0.1 * Math.sin(t * 1.1 + i))).toFixed(2));
      });
      // the ring that ripples out on a heartbeat
      const age = rippleAt < 0 ? 9 : (now - rippleAt) / 1000;
      const rg = ring.current;
      if (rg) {
        if (age < 1.3) {
          const k = age / 1.3;
          rg.setAttribute("r", (R * 0.9 + k * 16).toFixed(2));
          rg.setAttribute("opacity", ((1 - k) * 0.55 * rippleAmp).toFixed(3));
        } else rg.setAttribute("opacity", "0");
      }
    };

    if (reduced) { draw(performance.now()); return; }
    // The header is hidden (not unmounted) while Home is showing; don't animate
    // a creature nobody can see. Checked twice a second, not every frame.
    let hidden = false, checked = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - checked > 500) {
        checked = now;
        hidden = document.hidden || (svg.current !== null && getComputedStyle(svg.current).visibility === "hidden");
      }
      if (hidden) { last = now; return; }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now; t += dt;
      if (now > next) { kick.current(rnd(5, 9)); next = now + rnd(2500, 7500); }
      v += (-70 * x - 6.5 * v) * dt;         // under-damped: a springy double beat
      x += v * dt;
      draw(now);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <a className="logo" href={import.meta.env.BASE_URL} aria-label="Master Dank Collections, home"
      onClick={(e) => { e.preventDefault(); onHome(); }}
      onMouseEnter={() => kick.current(9)}>
      <svg ref={svg} className="logo-mark" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <defs>
          <radialGradient id="am-body" cx="0.38" cy="0.32" r="0.85">
            <stop offset="0" stopColor="#7be9ff" stopOpacity="0.95" />
            <stop offset="0.45" stopColor="#b98cff" stopOpacity="0.9" />
            <stop offset="0.8" stopColor="#ff6fbf" stopOpacity="0.85" />
            <stop offset="1" stopColor="#ffb86b" stopOpacity="0.8" />
          </radialGradient>
          <linearGradient id="am-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="0.5" stopColor="#62e8ff" />
            <stop offset="1" stopColor="#ff7ad9" />
          </linearGradient>
          {HUES.map(([lo, hi], i) => (
            <radialGradient key={i} id={`am-c${i}`} cx="0.38" cy="0.34" r="0.8">
              <stop offset="0" stopColor={lo} />
              <stop offset="1" stopColor={hi} />
            </radialGradient>
          ))}
        </defs>
        <g className="am-hue">
          <circle ref={ring} cx="32" cy="32" r="17" fill="none" stroke="url(#am-rim)" strokeWidth="1.1" opacity="0" />
          <path ref={body} fill="url(#am-body)" />
          <path ref={rim} fill="none" stroke="url(#am-rim)" strokeWidth="1.3" strokeLinejoin="round" opacity="0.9" />
          {[0, 1].map((i) => (
            <circle key={i} ref={(el) => { vac.current[i] = el; }} fill="rgba(255,255,255,0.08)"
              stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
          ))}
          {Array.from({ length: SUBS }, (_, i) => (
            <circle key={`c${i}`} ref={(el) => { cells.current[i] = el; }} fill={`url(#am-c${i})`}
              opacity="0.82" style={{ mixBlendMode: "screen" }} />
          ))}
          {Array.from({ length: 7 }, (_, i) => (
            <circle key={`g${i}`} ref={(el) => { grains.current[i] = el; }} r="0.75" fill="#fff" opacity="0.55" />
          ))}
        </g>
      </svg>
      <span className="logo-word">
        <span className="lw-top">Master Dank</span>
        <span className="lw-bot">Collections</span>
      </span>
    </a>
  );
}
