/** Brand mark: the amoeba, small. A wobbling membrane that never repeats, a
 *  nucleus and vacuoles drifting inside, a slow colour cycle, and now and then
 *  a heartbeat -- a spring kick with a ring rippling out. Drawn straight into
 *  the SVG each frame (a dozen points, no canvas), still under reduced motion.
 *  The favicon (public/favicon.svg) is a frozen frame of the same creature. */
import { useEffect, useRef } from "react";

const N = 9;                 // membrane points
const TAU = Math.PI * 2;
const R = 17;                // resting radius in the 64-unit box

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
  const nucleus = useRef<SVGCircleElement>(null);
  const shine = useRef<SVGCircleElement>(null);
  const vac = useRef<Array<SVGCircleElement | null>>([]);
  const ring = useRef<SVGCircleElement>(null);
  const kick = useRef<(power: number) => void>(() => {});

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    // each membrane point has its own two slow waves, and its own pseudopod phase
    const ph = Array.from({ length: N }, () => ({
      a: rnd(0, TAU), b: rnd(0, TAU), fa: rnd(0.35, 0.8), fb: rnd(0.9, 1.7), pod: rnd(0, TAU), pf: rnd(0.12, 0.3),
    }));
    const vph = [0, 1, 2].map(() => ({ a: rnd(0, TAU), r: rnd(3, 8), f: rnd(0.25, 0.6), s: rnd(1.4, 2.6) }));

    let t = rnd(0, 50), last = performance.now();
    let x = 0, v = 0;                         // heartbeat spring
    let rippleAt = -1, rippleAmp = 1;
    let next = last + rnd(1800, 4200);
    let raf = 0;

    kick.current = (power: number) => { v += power; rippleAt = performance.now(); rippleAmp = Math.min(1, power / 9); };

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
      const nx = 32 + Math.sin(t * 0.43) * 3.2, ny = 32 + Math.cos(t * 0.37) * 2.8;
      nucleus.current?.setAttribute("cx", nx.toFixed(2));
      nucleus.current?.setAttribute("cy", ny.toFixed(2));
      nucleus.current?.setAttribute("r", (4.3 * (1 + 0.14 * x + 0.05 * Math.sin(t * 1.3))).toFixed(2));
      shine.current?.setAttribute("cx", (nx - 1.3).toFixed(2));
      shine.current?.setAttribute("cy", (ny - 1.5).toFixed(2));
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
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now; t += dt;
      if (now > next) { kick.current(rnd(5, 9)); next = now + rnd(2500, 7500); }
      v += (-70 * x - 6.5 * v) * dt;         // under-damped: a springy double beat
      x += v * dt;
      draw(now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <a className="logo" href={import.meta.env.BASE_URL} aria-label="Master Dank Collections, home"
      onClick={(e) => { e.preventDefault(); onHome(); }}
      onMouseEnter={() => kick.current(9)}>
      <svg className="logo-mark" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
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
          <radialGradient id="am-nuc" cx="0.4" cy="0.35" r="0.8">
            <stop offset="0" stopColor="#fff3c4" />
            <stop offset="0.55" stopColor="#ff7ad9" />
            <stop offset="1" stopColor="#5b34c8" />
          </radialGradient>
        </defs>
        <g className="am-hue">
          <circle ref={ring} cx="32" cy="32" r="17" fill="none" stroke="url(#am-rim)" strokeWidth="1.1" opacity="0" />
          <path ref={body} fill="url(#am-body)" />
          <path ref={rim} fill="none" stroke="url(#am-rim)" strokeWidth="1.3" strokeLinejoin="round" opacity="0.9" />
          {[0, 1, 2].map((i) => (
            <circle key={i} ref={(el) => { vac.current[i] = el; }} fill="rgba(255,255,255,0.1)"
              stroke="rgba(255,255,255,0.65)" strokeWidth="0.6" />
          ))}
          <circle ref={nucleus} fill="url(#am-nuc)" />
          <circle ref={shine} r="1.2" fill="#fff" opacity="0.8" />
        </g>
      </svg>
      <span className="logo-word">
        <span className="lw-top">Master Dank</span>
        <span className="lw-bot">Collections</span>
      </span>
    </a>
  );
}
