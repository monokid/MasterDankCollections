/** One half of the menu. The header splits its tabs either side of the logo, so
 *  each half is a rail of its own with a liquid indicator that glides under the
 *  active tab -- measured from the live tab so it follows font loading and
 *  resizes -- and sits unlit while the active view is on the other half. */
import { useLayoutEffect, useRef, useState } from "react";

export default function TabRail<V extends string>({ items, view, dimmed, side, onPick }: {
  items: Array<[V, string]>;
  view: V | null;
  /** A track is open on top of the view: no tab is current. */
  dimmed: boolean;
  side: "left" | "right";
  onPick: (v: V) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  const [glide, setGlide] = useState<{ x: number; w: number } | null>(null);
  const here = view !== null && items.some(([v]) => v === view);

  useLayoutEffect(() => {
    const el = nav.current;
    if (!el || !here) { setGlide(null); return; }
    const measure = () => {
      const t = el.querySelector<HTMLElement>(`[data-view="${view}"]`);
      if (t) setGlide({ x: t.offsetLeft, w: t.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.querySelectorAll(".tab").forEach((t) => ro.observe(t));
    return () => ro.disconnect();
  }, [view, here]);

  return (
    <nav className={`tabs ${side}`} ref={nav}>
      {glide && !dimmed && (
        <span className="tabglide" aria-hidden="true"
          style={{ ["--gx" as string]: `${glide.x}px`, ["--gw" as string]: `${glide.w}px` }} />
      )}
      {items.map(([v, label]) => (
        <button key={v} className="tab" data-view={v} aria-current={view === v && !dimmed}
          onClick={() => onPick(v)}>{label}</button>
      ))}
    </nav>
  );
}
