import { useEffect, useRef } from "react";

const ROWS: Array<[keys: string[][], what: string]> = [
  [[["/"]], "Search from anywhere"],
  [[["g"], ["s"]], "Go to Search"],
  [[["g"], ["m"]], "Go to Music"],
  [[["g"], ["t"]], "Go to Timeline"],
  [[["g"], ["b"]], "Go to Browse"],
  [[["g"], ["p"]], "Go to People"],
  [[["g"], ["i"]], "Go to Insights"],
  [[["Esc"]], "Close a track, or this box"],
  [[["?"]], "Show this help"],
];

/** The shortcut list, as a real dialog: focus moves in, Tab stays inside, Esc
 *  or a click outside closes it, and focus goes back where it came from. */
export default function KeyHelp({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = box.current?.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])");
      if (!items?.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); before?.focus?.(); };
  }, [onClose]);

  return (
    <div className="kh-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="kh" ref={box} role="dialog" aria-modal="true" aria-labelledby="kh-title">
        <h2 id="kh-title">Keyboard shortcuts</h2>
        <dl>
          {ROWS.map(([keys, what]) => (
            <div key={what} style={{ display: "contents" }}>
              <dt>{keys.map((k, i) => (
                <span key={i}>{i > 0 && <span className="then">then</span>}<kbd>{k[0]}</kbd></span>
              ))}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <div className="kh-foot">
          <span>Shortcuts pause while you type in a box.</span>
          <button className="btn ghost" ref={close} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
