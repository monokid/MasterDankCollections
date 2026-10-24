/** The Genre / Released chip rows and the small cover thumbnail, shared by Search
 *  and Browse. Logic lives in enrichfilter.ts; this only draws it. */
import { familyColour, familyLabel } from "./families.ts";
import { hashOf, selActive, toggle, type Counts, type Sel } from "./enrichfilter.ts";
import "./enrichfilter.css";

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
  ) => (
    <div className="ef-row" role="group" aria-label={aria}>
      <span className="ef-label">{label}</span>
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
