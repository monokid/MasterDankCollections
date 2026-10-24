/** The "Columns" button and its popover, plus the hooks that remember the choice.
 *  Remembered per page id: in the session (useSessionState) and in localStorage,
 *  so it also survives a new tab. Every storage access is wrapped: a blocked
 *  store just means the choice lasts as long as the page. */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useSessionState } from "./hooks.ts";
import { cleanChoice, isOn, NO_CHOICE, toggleColumn, type Choice, type Column } from "./songcols.ts";
import "./songcols.css";

const LS = (pageId: string) => `mdc:cols:${pageId}`;

function readLocal(pageId: string): Choice {
  try {
    const raw = localStorage.getItem(LS(pageId));
    return raw ? cleanChoice(JSON.parse(raw)) : NO_CHOICE;
  } catch { return NO_CHOICE; }
}
function writeLocal(pageId: string, c: Choice) {
  try {
    if (c.show.length || c.hide.length) localStorage.setItem(LS(pageId), JSON.stringify(c));
    else localStorage.removeItem(LS(pageId));
  } catch { /* blocked: session memory only */ }
}

/** [choice, toggle(column), reset] for one page. */
export function useColumnChoice(pageId: string): [Choice, (c: Pick<Column<never>, "id" | "defaultOn">) => void, () => void] {
  const [saved, setSaved] = useSessionState<Choice | null>(`cols.${pageId}`, null);
  // Session value wins; a fresh tab falls back to what localStorage remembers.
  const [choice, setChoice] = useState<Choice>(() => (saved ? cleanChoice(saved) : readLocal(pageId)));
  const apply = useCallback((next: Choice) => {
    setChoice(next); setSaved(next); writeLocal(pageId, next);
  }, [pageId, setSaved]);
  const toggle = useCallback((c: Pick<Column<never>, "id" | "defaultOn">) => apply(toggleColumn(c, choice)), [apply, choice]);
  const reset = useCallback(() => apply(NO_CHOICE), [apply]);
  return [choice, toggle, reset];
}

/** Viewport width, updated on resize (matchMedia-free so it is trivial to follow). */
export function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1400 : window.innerWidth));
  useEffect(() => {
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setW(window.innerWidth)); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, []);
  return w;
}

export default function ColumnsMenu({ columns, choice, onToggle, onReset }: {
  /** All of the page's columns; `locked` ones are not listed. */
  columns: Array<Pick<Column<never>, "id" | "label" | "locked" | "defaultOn">>;
  choice: Choice;
  onToggle: (c: Pick<Column<never>, "id" | "defaultOn">) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useId();
  const changed = choice.show.length + choice.hide.length > 0;

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
    <span className="cm" ref={box}>
      <button ref={btn} type="button" className="linkbtn cm-btn" aria-haspopup="true" aria-expanded={open}
        aria-controls={open ? pop : undefined} onClick={() => setOpen((o) => !o)}>
        Columns{changed && <span className="cm-dot" aria-label="customised" />}
      </button>
      {open && (
        <div className="cm-pop" id={pop} role="group" aria-label="Show columns">
          {columns.filter((c) => !c.locked).map((c) => (
            <label key={c.id} className="cm-item">
              <input type="checkbox" checked={isOn(c, choice)} onChange={() => onToggle(c)} />
              {c.label}
            </label>
          ))}
          <button type="button" className="linkbtn cm-reset" disabled={!changed} onClick={onReset}>reset</button>
        </div>
      )}
    </span>
  );
}
