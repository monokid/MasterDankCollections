/** The Genre / Released chip rows and the small cover thumbnail, shared by Search
 *  and Browse. Logic lives in enrichfilter.ts; this only draws it. */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { familyColour, familyLabel } from "./families.ts";
import { hashOf, selActive, toggle, type Counts, type Sel } from "./enrichfilter.ts";
import { badgeLabel } from "./searchbar.ts";
import "./enrichfilter.css";
import "./searchbar.css";

export default function EnrichChips({ universe, counts, sel, onChange, hint }: {
  /** Every family / decade that exists, in display order (enrichfilter.universe). */
  universe: { families: Array<[string, number]>; decades: Array<[string, number]> };
  /** Faceted counts for the current view; a missing key counts as 0. */
  counts: { families: Counts; decades: Counts };
  sel: Sel;
  onChange: (s: Sel) => void;
  /** One line of help shown under the rows. */
  hint?: string;
}) {
  const row = (
    label: string, aria: string, items: Array<[string, number]>, picked: string[], c: Counts,
    set: (next: string[]) => void, colour: boolean,
  ) => <ChipRow label={label} aria={aria} items={items} picked={picked} counts={c} set={set} colour={colour} />;

  return (
    <div className="ef-chips">
      {universe.families.length > 0 &&
        row("Genre", "Genre family", universe.families, sel.families, counts.families,
          (families) => onChange({ ...sel, families }), true)}
      {universe.decades.length > 0 &&
        row("Released", "Decade of release", universe.decades, sel.decades, counts.decades,
          (decades) => onChange({ ...sel, decades }), false)}
      <div className="ef-foot">
        {selActive(sel) && (
          <button type="button" className="tl-clear nomargin" onClick={() => onChange({ families: [], decades: [] })}>
            clear
          </button>
        )}
        {hint && <span className="ef-hint">{hint}</span>}
      </div>
    </div>
  );
}

function ChipRow({ label, aria, items, picked, counts: c, set, colour }: {
  label: string; aria: string; items: Array<[string, number]>; picked: string[]; counts: Counts;
  set: (next: string[]) => void; colour: boolean;
}) {
  return (
    <div className="ef-row" role="group" aria-label={aria}>
      {label && <span className="ef-label">{label}</span>}
      {items.map(([v]) => {
        const n = c.get(v) ?? 0;
        const on = picked.includes(v);
        return (
          <button key={v} type="button" className={`fchip${n === 0 && !on ? " ef-zero" : ""}`}
            aria-pressed={on} disabled={n === 0 && !on}
            style={colour ? { ["--fc" as string]: familyColour(v) } : undefined}
            onClick={() => set(toggle(picked, v))}>
            {colour && <span className="ef-dot" style={{ background: familyColour(v) }} aria-hidden="true" />}
            {colour ? familyLabel(v) : v} <i>{n.toLocaleString("en-GB")}</i>
          </button>
        );
      })}
    </div>
  );
}

/** A square cover: a gradient drawn from the song id underneath, the real image
 *  over it when there is one and it loads (a failed load just reveals the gradient). */
export function Thumb({ songId, url, size = 38 }: { songId: string; url: string | null; size?: number }) {
  const h = hashOf(songId);
  const a = h % 360, b = (a + 40 + ((h >>> 9) % 120)) % 360;
  return (
    <span className="ef-thumb" aria-hidden="true"
      style={{ width: size, height: size, background: `linear-gradient(${(h >>> 4) % 180}deg, hsl(${a} 55% 38%), hsl(${b} 60% 24%))` }}>
      {url && (
        <img src={url} loading="lazy" decoding="async" referrerPolicy="no-referrer" alt=""
          onError={(e) => { e.currentTarget.style.display = "none"; }} />
      )}
    </span>
  );
}

type Universe = { families: Array<[string, number]>; decades: Array<[string, number]> };
type Facets = { families: Counts; decades: Counts };

/** A bar button ("Genre ▾", "Genre · 2 ▾") and the panel it opens. Closes on Esc
 *  (focus returns to the button), a click outside, or focus leaving. The panel is
 *  anchored to the whole bar (.sb-bar is the positioned parent), so it can never
 *  run off the viewport on a narrow screen. */
function ChipPopover({ name, count, children }: { name: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);
  return (
    <span className="sb-popwrap" ref={box}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (open && to && !box.current?.contains(to)) setOpen(false);
      }}>
      <button ref={btn} type="button" className={`sb-btn${count ? " on" : ""}${open ? " open" : ""}`}
        aria-haspopup="true" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}>
        {badgeLabel(name, count)}<span className="sb-caret" aria-hidden="true">▾</span>
      </button>
      {open && <div className="sb-pop" id={id} role="group" aria-label={name}>{children}</div>}
    </span>
  );
}

/** The Genre and Released filters as two compact popover buttons for the Search
 *  bar. Same chips and counts as EnrichChips; `hint` is the quiet footer, once. */
export function EnrichPopovers({ universe, counts, sel, onChange, hint }: {
  universe: Universe; counts: Facets; sel: Sel; onChange: (s: Sel) => void; hint?: string;
}) {
  const pop = (
    name: string, aria: string, items: Array<[string, number]>, picked: string[], c: Counts,
    set: (next: string[]) => void, colour: boolean,
  ) => (
    <ChipPopover name={name} count={picked.length}>
      <div className="ef-chips sb-grid">
        <ChipRow label="" aria={aria} items={items} picked={picked} counts={c} set={set} colour={colour} />
      </div>
      <div className="ef-foot sb-foot">
        {picked.length > 0 && (
          <button type="button" className="linkbtn" onClick={() => set([])}>clear</button>
        )}
        {hint && <span className="ef-hint">{hint}</span>}
      </div>
    </ChipPopover>
  );
  return (
    <>
      {universe.families.length > 0 &&
        pop("Genre", "Genre family", universe.families, sel.families, counts.families,
          (families) => onChange({ ...sel, families }), true)}
      {universe.decades.length > 0 &&
        pop("Released", "Decade of release", universe.decades, sel.decades, counts.decades,
          (decades) => onChange({ ...sel, decades }), false)}
    </>
  );
}
