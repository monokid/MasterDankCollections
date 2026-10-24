/** Building blocks the legacy bar-list sections share, and the foldable,
 *  lazily computed section host every tab uses. Moved out of Insights.tsx
 *  unchanged in behaviour. */
import {
  memo, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode,
} from "react";
import { type Trend, type QualityYear } from "../analytics.ts";
import { csvFilename, downloadText, scrollRootOf, sectionAt, toCsv, type Cell } from "../pagehelpers.ts";
import { useSessionState } from "../hooks.ts";
import { ChevronIcon, DownloadIcon } from "../icons.tsx";
import { RangeTag } from "../charts.tsx";
import type { Drill, Row, SectionDef, TabProps } from "./types.ts";

export const TOP = 20;

export function CsvButton({ title, header, rows }: { title: string; header: string[]; rows: Cell[][] }) {
  const tag = useContext(RangeTag);
  if (!rows.length) return null;
  return (
    <button className="csvbtn" title="Download these figures as a spreadsheet (CSV)"
      aria-label={`Download ${title} as CSV`}
      onClick={() => downloadText(csvFilename(title, tag), toCsv(header, rows))}>
      <DownloadIcon size={14} /> CSV
    </button>
  );
}

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
};

/** A ranked list of horizontal bars; every row with a `drill` is a door. */
export const Chart = memo(function Chart({ title, note, rows, onDrill, tall }: {
  title: string; note?: string; rows: Row[]; onDrill: (d: Drill) => void; tall?: boolean;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className={`panel chart${tall ? " tall" : ""}`}>
      <div className="charthead">
        <h2>{title}</h2>
        <CsvButton title={title} header={["label", "detail", "value", "text"]}
          rows={rows.map((r) => [r.label, r.sub, r.value, r.text])} />
      </div>
      {note && <div className="chart-note">{note}</div>}
      {rows.length === 0 && <div className="src">not enough data</div>}
      {rows.map((r, i) => (
        <div key={r.label + i} className={`bar${r.drill ? " clickable" : ""}`}
          onClick={() => r.drill && onDrill(r.drill)}
          role={r.drill ? "button" : undefined} tabIndex={r.drill ? 0 : undefined}
          onKeyDown={(e) => { if (r.drill) activate(() => onDrill(r.drill!))(e); }}
          title={r.drill ? "Open the detail" : undefined}>
          <span className="rank">{i + 1}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
            <span className="label">{r.label}{r.sub && <i className="sublabel">{r.sub}</i>}</span>
          </span>
          <span className="val">{r.text ?? r.value}</span>
        </div>
      ))}
    </div>
  );
});

const BAND_LABEL = { lossless: "lossless", high: "256+ kbps", mid: "160–255 kbps", low: "under 160 kbps" } as const;

/** Every file's quality, a column a year, split into the four rungs. A click on
 *  a column opens the year. */
export function QualityBlock({ years, onDrill }: { years: QualityYear[]; onDrill: (d: Drill) => void }) {
  return (
    <div className="panel chart">
      <div className="charthead">
        <h2>Quality of the files, by year</h2>
        <CsvButton title="Quality of the files, by year"
          header={["year", "files", "lossless", "256+ kbps", "160-255 kbps", "under 160 kbps", "median kbps (lossy)"]}
          rows={years.map((q) => [q.year, q.files, q.lossless, q.high, q.mid, q.low, q.medianKbps])} />
      </div>
      <div className="chart-note">Share of each year's files in each rung. Anonymised copies count: they are files too.</div>
      <div className="stack" role="img" aria-label="File quality by year">
        {years.map((q) => (
          <div key={q.year} className="stack-col clickable" role="button" tabIndex={0}
            title={`${q.year}: ${q.files} files, median ${q.medianKbps ?? "–"} kbps (lossy)`}
            onClick={() => onDrill({ kind: "year", year: q.year })}
            onKeyDown={activate(() => onDrill({ kind: "year", year: q.year }))}>
            <div className="stack-bar">
              {(["lossless", "high", "mid", "low"] as const).map((b) => (
                <div key={b} className={`seg ${b}`} style={{ height: `${(q[b] / q.files) * 100}%` }} />
              ))}
            </div>
            <span>{q.year.slice(2)}</span>
          </div>
        ))}
      </div>
      <div className="legend">
        {(["lossless", "high", "mid", "low"] as const).map((b) => (
          <span key={b}><i className={`seg ${b}`} />{BAND_LABEL[b]}</span>
        ))}
      </div>
    </div>
  );
}

/** One yearly series with the years that break the trend marked, and what each
 *  break says. A click on a reading opens that year. */
export function TrendBlock({ trend, onDrill }: { trend: Trend; onDrill: (d: Drill) => void }) {
  const max = Math.max(...trend.points.map((p) => p.value), 1);
  return (
    <div className="panel chart">
      <div className="charthead">
        <h2>{trend.title}</h2>
        <CsvButton title={trend.title} header={["year", "value", "breaks the trend"]}
          rows={trend.points.map((p) => [p.year, Math.round(p.value * 100) / 100, p.flagged ? "yes" : ""])} />
      </div>
      <div className="spark" role="img" aria-label={`${trend.title} by year`}>
        {trend.points.map((p) => (
          <div key={p.year} className={`spark-col${p.flagged ? " flag" : ""}`}
            title={`${p.year}: ${Math.round(p.value * 100) / 100}${p.flagged ? " (breaks the trend)" : ""}`}>
            <div className="spark-bar" style={{ height: `${Math.max((p.value / max) * 100, p.value ? 6 : 0)}%` }} />
            <span>{p.year.slice(2)}</span>
          </div>
        ))}
      </div>
      {trend.breaks.length === 0 && <div className="reading"><span className="calm">No year stands out from its neighbours.</span></div>}
      {trend.breaks.map((b) => (
        <div key={b.year} className="reading clickable" role="button" tabIndex={0}
          onClick={() => onDrill({ kind: "year", year: b.year })}
          onKeyDown={activate(() => onDrill({ kind: "year", year: b.year }))}>
          {b.reading}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ section host

/** A stand-in the height of a typical section while it waits to scroll in. */
export function Skeleton() {
  return (
    <div className="skel-grid" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="panel skel">
          <span className="skel-line w60" />
          {Array.from({ length: 7 }, (_, k) => <span key={k} className="skel-line" style={{ width: `${92 - k * 9}%` }} />)}
        </div>
      ))}
    </div>
  );
}

/** Computes nothing until it has scrolled within reach (or something asked for
 *  it, like a jump chip), and nothing at all while folded away. */
function Section({ id, label, forced, folded, onToggle, children }: {
  id: string; label: string; forced: boolean; folded: boolean; onToggle: (id: string) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || forced || !el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "700px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, forced]);
  const live = seen || forced;
  return (
    <section ref={ref} id={`ins-${id}`} data-sec={id} className={`inssec${folded ? " is-folded" : ""}`}>
      <h2 className="section">
        <button className="secfold" aria-expanded={!folded} aria-controls={`ins-body-${id}`}
          title={folded ? "Show this section" : "Fold this section away"} onClick={() => onToggle(id)}>
          <ChevronIcon size={16} />{label}
        </button>
      </h2>
      <div id={`ins-body-${id}`} hidden={folded}>
        {!folded && (live ? children : <Skeleton />)}
      </div>
    </section>
  );
}

/** The height of everything pinned above the tab's content (tab strip + KPIs). */
const headHeight = (from: Element | null) =>
  from?.closest(".ins-main")?.querySelector<HTMLElement>(".ins-head")?.offsetHeight ?? 0;

/** A tab's body: its sections in order, each foldable and lazily computed, with
 *  a strip of jump chips and scroll-spy when there is more than one. */
export function Sections({ sections, props }: { sections: SectionDef[]; props: TabProps }) {
  const [foldedIds, setFoldedIds] = useSessionState<string[]>("insights.folded", []);
  const folded = new Set(foldedIds);
  const toggleFold = useCallback((id: string) =>
    setFoldedIds((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id])), [setFoldedIds]);

  const tocRef = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [armedTo, setArmedTo] = useState(-1);          // sections up to this index are forced live
  const [jump, setJump] = useState<string | null>(null);

  useEffect(() => {
    const root = scrollRootOf(tocRef.current);
    if (!root) return;
    let raf = 0;
    const spy = () => {
      raf = 0;
      const secs = [...root.querySelectorAll<HTMLElement>("[data-sec]")];
      const line = root.getBoundingClientRect().top + headHeight(tocRef.current) + (tocRef.current?.offsetHeight ?? 0) + 24;
      const atBottom = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      const i = sectionAt(secs.map((s) => s.getBoundingClientRect().top), line, atBottom);
      setCurrent(i >= 0 ? (secs[i].dataset.sec ?? null) : null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    root.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // A chip: unfold the target, make everything above it real so nothing
  // changes height under the scroll, then scroll once that has rendered.
  const goto = (id: string) => {
    const i = sections.findIndex((s) => s.id === id);
    setFoldedIds((f) => f.filter((x) => x !== id));
    setArmedTo((a) => Math.max(a, i));
    setJump(id);
  };
  useEffect(() => {
    if (!jump) return;
    const root = scrollRootOf(tocRef.current);
    const el = root?.querySelector<HTMLElement>(`#ins-${jump}`);
    setJump(null);
    if (!root || !el) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({
      top: top - headHeight(tocRef.current) - (tocRef.current?.offsetHeight ?? 0) - 6,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [jump]);

  // Keep the current chip in view in the (sideways-scrolling) strip.
  useEffect(() => {
    const strip = tocRef.current?.querySelector<HTMLElement>(".strip");
    const chip = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !chip) return;
    strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2 });
  }, [current]);

  return (
    <>
      {sections.length > 1 && (
        <nav className="instoc ins-chips" ref={tocRef} aria-label="Sections of this tab">
          <div className="strip toc-chips">
            {sections.map((s) => (
              <button key={s.id} className="tocchip" aria-current={current === s.id}
                onClick={() => goto(s.id)}>{s.label}</button>
            ))}
          </div>
        </nav>
      )}
      {sections.map((s, i) => (
        <Section key={s.id} id={s.id} label={s.label} forced={i <= armedTo}
          folded={folded.has(s.id)} onToggle={toggleFold}>
          <s.Body {...props} />
        </Section>
      ))}
    </>
  );
}
