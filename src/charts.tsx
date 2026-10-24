/** Hand-drawn SVG chart primitives for the Insights tabs. No chart library.
 *
 *  Shared rules, so every chart reads and behaves alike:
 *   - responsive: each chart measures its box (ResizeObserver) and draws in real
 *     pixels, so text is never scaled;
 *   - themed with the CSS tokens (--accent, --ink-dim ...), never hard-coded hue;
 *   - colour is never the only carrier: series also differ by marker shape, line
 *     dash and legend order, every value can be read from a tooltip, and a
 *     visually hidden table repeats the data for screen readers;
 *   - every mark is focusable and shows the same tooltip on hover and on focus;
 *     with `onSelect` it is a button (Enter / Space / click);
 *   - motion (bars growing in) is CSS and switched off by prefers-reduced-motion.
 *
 *  Values must be >= 0. `null` means "no data" and is drawn as a gap, never a zero.
 *  Styles live in src/insights.css (imported by the Insights shell). */
import {
  createContext, useCallback, useContext, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type ReactNode, type RefObject,
} from "react";
import { csvFilename, downloadText, toCsv, type Cell } from "./pagehelpers.ts";
import { fmtCount } from "./format.ts";
import { DownloadIcon } from "./icons.tsx";

// ---------------------------------------------------------------- pure helpers

/** "Nice" axis: a top value and ticks at 1, 2, 5 x 10^n steps. */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, ticks: [0, 1] };
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step);
  return { max: top, ticks };
}

/** Trailing rolling mean over `w` points, skipping gaps; null where the window holds no data. */
export function rolling(values: Array<number | null>, w: number): Array<number | null> {
  return values.map((_, i) => {
    const win = values.slice(Math.max(0, i - w + 1), i + 1).filter((v): v is number => v !== null);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
}

/** WCAG relative luminance and contrast ratio of two "#rrggbb" colours. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const mix = (a: string, b: string, t: number) => {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("");
};

/** Sequential ramp for the heatmap: dark violet -> violet -> cyan. Luminance rises
 *  with the value (checked by the tests), so it reads in greyscale too. */
export const RAMP = ["#2d2468", "#b98cff", "#62e8ff"] as const;
export function rampColour(t: number): string {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return x < 0.5 ? mix(RAMP[0], RAMP[1], x * 2) : mix(RAMP[1], RAMP[2], (x - 0.5) * 2);
}
/** Black or white ink, whichever reads better on `bg`. */
export const inkOn = (bg: string) => (contrast(bg, "#0a0618") >= contrast(bg, "#ffffff") ? "#0a0618" : "#ffffff");

/** Series styling: a token each, plus a shape and a dash so colour is never alone. */
export const SERIES = [
  { token: "var(--accent)", hex: "--accent", shape: "circle", dash: "" },
  { token: "var(--accent-2)", hex: "--accent-2", shape: "square", dash: "7 4" },
  { token: "var(--warn)", hex: "--warn", shape: "diamond", dash: "2 3" },
  { token: "var(--hot)", hex: "--hot", shape: "triangle", dash: "10 3 2 3" },
  { token: "var(--ok)", hex: "--ok", shape: "cross", dash: "4 4" },
] as const;
export type Shape = (typeof SERIES)[number]["shape"];
const seriesOf = (i: number) => SERIES[i % SERIES.length];

const tw = (s: string, px = 11) => s.length * px * 0.6;
const defaultFormat = (v: number) => (Number.isInteger(v) ? fmtCount(v) : v.toFixed(1));

// --------------------------------------------------------------------- plumbing

/** Appended to CSV file names so a download says which range it came from. */
export const RangeTag = createContext("");

/** Width of an element, kept current. 320 until it has been measured. */
export function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.round(el.clientWidth));
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w || 320;
}

export interface Tip { x: number; y: number; title: string; lines: string[] }

/** One tooltip per chart. `bind(title, lines)` gives a mark the handlers that
 *  show it on hover and on keyboard focus. */
export function useTip(wrap: RefObject<HTMLDivElement | null>) {
  const [tip, setTip] = useState<Tip | null>(null);
  const at = useCallback((cx: number, cy: number, title: string, lines: string[]) => {
    const r = wrap.current?.getBoundingClientRect();
    if (r) setTip({ x: cx - r.left, y: cy - r.top, title, lines });
  }, [wrap]);
  const bind = useCallback((title: string, lines: string[] = []) => ({
    onMouseMove: (e: { clientX: number; clientY: number }) => at(e.clientX, e.clientY, title, lines),
    onMouseLeave: () => setTip(null),
    onFocus: (e: { currentTarget: Element }) => {
      const b = e.currentTarget.getBoundingClientRect();
      at(b.left + b.width / 2, b.top, title, lines);
    },
    onBlur: () => setTip(null),
  }), [at]);
  return { tip, bind };
}

/** Everything a chart needs: the box to measure and anchor the tooltip to, its width, the tooltip. */
function useChart() {
  const ref = useRef<HTMLDivElement>(null);
  const W = useWidth(ref);
  return { ref, W, ...useTip(ref) };
}

/** The shared tooltip box; `width` keeps it inside the chart. */
export function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.max(70, Math.min(width - 70, tip.x));
  return (
    <div className="ich-tip" role="tooltip" style={{ left, top: Math.max(tip.y, 54) }}>
      <b>{tip.title}</b>
      {tip.lines.map((l, i) => <span key={i}>{l}</span>)}
    </div>
  );
}

/** What a mark needs to be a button when the chart is clickable. */
function press(onSelect: (() => void) | undefined) {
  if (!onSelect) return {};
  return {
    role: "button" as const,
    onClick: onSelect,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
    },
  };
}

/** The data as a table that only a screen reader sees. */
export function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: Cell[][] }) {
  return (
    <table className="ins-sr">
      <caption>{caption}</caption>
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c ?? "no data"}</td>))}</tr>)}</tbody>
    </table>
  );
}

/** What a clicked mark reports. `series` is the series key; `value` null for a gap. */
export interface ChartPoint { key: string; label: string; series: string; value: number | null }

// ----------------------------------------------------------------------- marks

function Marker({ shape, x, y, r = 4, fill, stroke, ...rest }: {
  shape: Shape; x: number; y: number; r?: number; fill: string; stroke?: string;
} & Record<string, unknown>) {
  const common = { fill, stroke: stroke ?? "var(--panel-solid)", strokeWidth: 1.5, ...rest };
  switch (shape) {
    case "square": return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={1} {...common} />;
    case "diamond": return <path d={`M${x} ${y - r - 1}L${x + r + 1} ${y}L${x} ${y + r + 1}L${x - r - 1} ${y}Z`} {...common} />;
    case "triangle": return <path d={`M${x} ${y - r - 1}L${x + r + 1} ${y + r}L${x - r - 1} ${y + r}Z`} {...common} />;
    case "cross": return <path d={`M${x - r} ${y}H${x + r}M${x} ${y - r}V${y + r}`} fill="none" stroke={fill} strokeWidth={3} {...rest} />;
    default: return <circle cx={x} cy={y} r={r} {...common} />;
  }
}

// ---------------------------------------------------------------------- Legend

export function Legend({ items, className, offset = 0 }: {
  items: Array<{ key: string; label: string; detail?: string }>; className?: string; offset?: number;
}) {
  return (
    <ul className={`ich-legend${className ? " " + className : ""}`}>
      {items.map((it, i) => (
        <li key={it.key}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <Marker shape={seriesOf(offset + i).shape} x={7} y={7} r={4} fill={seriesOf(offset + i).token} />
          </svg>
          <span>{it.label}</span>{it.detail && <i>{it.detail}</i>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------ Spark

/** A tiny line (or area) with no axes. Decorative unless `onSelect` is given. */
export function Spark({ values, labels, area = true, height = 30, format = defaultFormat, ariaLabel, onSelect, className }: {
  values: Array<number | null>;
  labels?: string[];
  area?: boolean;
  height?: number;
  format?: (v: number) => string;
  ariaLabel: string;
  onSelect?: (p: ChartPoint) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const W = useWidth(ref);
  const pad = 3, n = values.length;
  const real = values.filter((v): v is number => v !== null);
  const lo = Math.min(0, ...real), hi = Math.max(...real, lo + 1e-9);
  const x = (i: number) => (n <= 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo || 1)) * (height - 2 * pad);
  // Runs of consecutive points; a gap ends a run.
  const runs: Array<Array<[number, number]>> = [];
  values.forEach((v, i) => {
    if (v === null) { runs.push([]); return; }
    if (!runs.length) runs.push([]);
    runs[runs.length - 1].push([x(i), y(v)]);
  });
  const d = (r: Array<[number, number]>) => r.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
  const lastIdx = values.reduce<number>((a, v, i) => (v === null ? a : i), -1);
  const label = (i: number) => labels?.[i] ?? String(i + 1);
  return (
    <div ref={ref} className={`ich-spark${className ? " " + className : ""}`}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
        {area && runs.filter((r) => r.length > 1).map((r, i) => (
          <path key={"a" + i} d={`${d(r)}L${r[r.length - 1][0].toFixed(1)} ${height - pad}L${r[0][0].toFixed(1)} ${height - pad}Z`}
            className="ich-area" style={{ fill: "var(--accent)" }} />
        ))}
        {runs.filter((r) => r.length > 1).map((r, i) => <path key={i} d={d(r)} className="ich-line" style={{ stroke: "var(--accent)" }} />)}
        {lastIdx >= 0 && values[lastIdx] !== null && (
          <circle cx={x(lastIdx)} cy={y(values[lastIdx]!)} r={2.6} style={{ fill: "var(--accent-2)" }} />
        )}
        {onSelect && values.map((v, i) => v === null ? null : (
          <circle key={i} cx={x(i)} cy={y(v)} r={6} className="ich-hit" tabIndex={0}
            aria-label={`${label(i)}: ${format(v)}`}
            {...press(() => onSelect({ key: label(i), label: label(i), series: "value", value: v }))} />
        ))}
      </svg>
    </div>
  );
}

// -------------------------------------------------------------------- BarChart

export interface BarDatum {
  key: string;
  label: string;
  /** One value per series (a single series is one value). null = no data. */
  values: Array<number | null>;
  /** Marked with a ring and a flag: an outlier, or the bar the text is about. */
  highlight?: boolean;
  /** Extra tooltip lines. */
  note?: string[];
}

export function BarChart({
  data, series = [{ key: "value", label: "Value" }], stacked = false, percent = false, average, format = defaultFormat,
  height = 190, showValues, ariaLabel, onSelect, avgLabel = "average", colour = 0,
}: {
  data: BarDatum[];
  series?: Array<{ key: string; label: string }>;
  /** Stack the series instead of putting them side by side. */
  stacked?: boolean;
  /** Stacked, each bar scaled to 100%: shares instead of totals. */
  percent?: boolean;
  /** A dashed reference line: a number, or "auto" for the mean of the single series. */
  average?: number | "auto" | null;
  format?: (v: number) => string;
  height?: number;
  showValues?: boolean;
  ariaLabel: string;
  avgLabel?: string;
  /** Which palette slot the first series uses (so two charts side by side can differ). */
  colour?: number;
  onSelect?: (p: ChartPoint) => void;
}) {
  const { ref, W, tip, bind } = useChart();
  const n = data.length;
  const totals = data.map((d) => d.values.reduce<number>((a, v) => a + (v ?? 0), 0));
  const rawMax = percent ? 1 : Math.max(0, ...(stacked ? totals : data.flatMap((d) => d.values.map((v) => v ?? 0))));
  const avg = average === "auto"
    ? (() => { const v = data.map((d) => d.values[0]).filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })()
    : average ?? null;
  const scale = niceScale(Math.max(rawMax, avg ?? 0), 4);
  const fmtTick = percent ? (v: number) => `${Math.round(v * 100)}%` : format;
  const L = Math.max(...scale.ticks.map((t) => tw(fmtTick(t)))) + 12, R = avg !== null ? Math.max(8, tw(`${avgLabel} ${format(avg)}`) / 2) : 8, T = 16, B = 24;
  const iw = Math.max(40, W - L - R), ih = height - T - B;
  const band = iw / Math.max(n, 1);
  const k = stacked ? 1 : series.length;
  const bw = Math.max(2, Math.min(56, (band * 0.72) / k));
  const y = (v: number) => T + ih - (v / scale.max) * ih;
  const every = Math.max(1, Math.ceil(Math.max(...data.map((d) => tw(d.label)), 8) / Math.max(band, 1)));
  const key = (d: BarDatum, s: number) => ({ key: d.key, label: d.label, series: series[s].key, value: d.values[s] });

  return (
    <div className="ich" ref={ref}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="group" aria-label={ariaLabel}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="ich-grid" />
            <text x={L - 6} y={y(t)} className="ich-tick" textAnchor="end" dominantBaseline="middle">{fmtTick(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = L + band * i + band / 2;
          const sum = totals[i] || 1;
          let acc = 0;
          return (
            <g key={d.key}>
              {d.values.map((v, s) => {
                if (v === null) return null;
                const val = percent ? v / sum : v;
                const h = Math.max(0, (val / scale.max) * ih);
                const x0 = stacked ? cx - bw / 2 : cx - (bw * k) / 2 + s * bw;
                const top = stacked ? y(acc + val) : y(val);
                if (stacked) acc += val;
                const sr = seriesOf(colour + s);
                const shown = percent ? `${Math.round((v / sum) * 100)}% (${format(v)})` : format(v);
                return (
                  <rect key={s} x={x0} y={top} width={bw} height={Math.max(h, v > 0 ? 1 : 0)} rx={2}
                    className={`ich-bar${d.highlight ? " is-hl" : ""}`} style={{ fill: sr.token }}
                    tabIndex={0} aria-label={`${d.label}${series.length > 1 ? `, ${series[s].label}` : ""}: ${shown}`}
                    {...bind(d.label, [...(series.length > 1 ? [`${series[s].label}: ${shown}`] : [shown]), ...(d.note ?? [])])}
                    {...press(onSelect && (() => onSelect(key(d, s))))} />
                );
              })}
              {d.highlight && (
                <path d={`M${cx} ${y(stacked ? totals[i] : Math.max(...d.values.map((v) => v ?? 0))) - 11}l4 5h-8z`} className="ich-flag" aria-hidden="true" />
              )}
              {showValues && band >= 26 && !stacked && series.length === 1 && d.values[0] !== null && (
                <text x={cx} y={y(d.values[0]!) - 4} className="ich-val" textAnchor="middle">{format(d.values[0]!)}</text>
              )}
              {i % every === 0 && <text x={cx} y={height - 7} className="ich-tick" textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
        {avg !== null && (
          <g>
            <line x1={L} x2={W - R} y1={y(avg)} y2={y(avg)} className="ich-avg" />
            <text x={W - R} y={y(avg) - 4} className="ich-avgtext" textAnchor="end">{avgLabel} {format(avg)}</text>
          </g>
        )}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="ich-axis" />
      </svg>
      <Tooltip tip={tip} width={W} />
      {series.length > 1 && <Legend items={series} offset={colour} />}
      <DataTable caption={ariaLabel} head={["", ...series.map((s) => s.label)]}
        rows={data.map((d) => [d.label, ...d.values.map((v) => (v === null ? null : format(v)))])} />
    </div>
  );
}

// ------------------------------------------------------------------- LineChart

export interface LineSeries { key: string; label: string; values: Array<number | null> }
export interface LineMarker {
  /** The x label it sits on. */
  x: string;
  kind: "outlier" | "break";
  /** Series it belongs to; omit for a break (a vertical line across all). */
  series?: string;
  note?: string;
}

export function LineChart({
  labels, series, rolling: window, markers = [], format = defaultFormat, height = 200, ariaLabel, onSelect, rollingLabel,
}: {
  /** The x categories, in order (years, months ...). Every series has one value per label. */
  labels: string[];
  series: LineSeries[];
  /** Window of a trailing average; shows a toggle that overlays it. */
  rolling?: number;
  rollingLabel?: string;
  /** Outliers get a ring; trend breaks a dashed vertical line and a flag. */
  markers?: LineMarker[];
  format?: (v: number) => string;
  height?: number;
  ariaLabel: string;
  onSelect?: (p: ChartPoint) => void;
}) {
  const { ref, W, tip, bind } = useChart();
  const [smooth, setSmooth] = useState(false);
  const n = labels.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const scale = niceScale(Math.max(0, ...all), 4);
  const L = Math.max(...scale.ticks.map((t) => tw(format(t)))) + 12, R = 12, T = 18, B = 24;
  const iw = Math.max(40, W - L - R), ih = height - T - B;
  const x = (i: number) => (n <= 1 ? L + iw / 2 : L + (i * iw) / (n - 1));
  const y = (v: number) => T + ih - (v / scale.max) * ih;
  const every = Math.max(1, Math.ceil(Math.max(...labels.map((l) => tw(l)), 8) / Math.max(iw / Math.max(n - 1, 1), 1)));
  const path = (vals: Array<number | null>) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const marksOf = (s: string, xl: string) => markers.filter((m) => m.kind === "outlier" && m.x === xl && (!m.series || m.series === s));
  const breaks = markers.filter((m) => m.kind === "break");
  const showMarkers = n <= 40;

  return (
    <div className="ich" ref={ref}>
      {window && window > 1 && (
        <label className="ich-toggle">
          <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
          {rollingLabel ?? `${window}-point average`}
        </label>
      )}
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="group" aria-label={ariaLabel}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="ich-grid" />
            <text x={L - 6} y={y(t)} className="ich-tick" textAnchor="end" dominantBaseline="middle">{format(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => i % every === 0 && <text key={l} x={x(i)} y={height - 7} className="ich-tick" textAnchor="middle">{l}</text>)}
        {breaks.map((b, i) => {
          const xi = labels.indexOf(b.x);
          if (xi < 0) return null;
          return (
            <g key={"b" + i}>
              <line x1={x(xi)} x2={x(xi)} y1={T - 4} y2={T + ih} className="ich-break" />
              <path d={`M${x(xi) - 4} ${T - 12}h8l-4 7z`} className="ich-flag" tabIndex={0} aria-label={`${b.x}: ${b.note ?? "breaks the trend"}`}
                {...bind(b.x, [b.note ?? "breaks the trend"])} />
            </g>
          );
        })}
        {series.map((s, si) => {
          const sr = seriesOf(si);
          const avg = window && window > 1 && smooth ? rolling(s.values, window) : null;
          return (
            <g key={s.key}>
              <path d={path(s.values)} className="ich-line" style={{ stroke: sr.token, strokeDasharray: sr.dash, opacity: avg ? 0.4 : 1 }} />
              {avg && <path d={path(avg)} className="ich-line thick" style={{ stroke: sr.token }} />}
              {s.values.map((v, i) => {
                if (v === null) return null;
                const out = marksOf(s.key, labels[i]);
                const lines = [...out.map((m) => m.note ?? "stands out"), ...(avg && avg[i] !== null ? [`${window}-point average: ${format(avg[i]!)}`] : [])];
                const text = `${labels[i]}${series.length > 1 ? `, ${s.label}` : ""}: ${format(v)}`;
                return (
                  <g key={i}>
                    {out.length > 0 && <circle cx={x(i)} cy={y(v)} r={9} className="ich-ring" aria-hidden="true" />}
                    <g className={showMarkers || out.length ? "ich-pt" : "ich-pt quiet"} tabIndex={0} aria-label={text}
                      {...bind(labels[i], [`${series.length > 1 ? s.label + ": " : ""}${format(v)}`, ...lines])}
                      {...press(onSelect && (() => onSelect({ key: labels[i], label: labels[i], series: s.key, value: v })))}>
                      <circle cx={x(i)} cy={y(v)} r={9} className="ich-hit" />
                      <Marker shape={sr.shape} x={x(i)} y={y(v)} r={3.6} fill={sr.token} />
                    </g>
                  </g>
                );
              })}
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="ich-axis" />
      </svg>
      <Tooltip tip={tip} width={W} />
      {series.length > 1 && <Legend items={series} />}
      <DataTable caption={ariaLabel} head={["", ...series.map((s) => s.label)]}
        rows={labels.map((l, i) => [l, ...series.map((s) => (s.values[i] === null ? null : format(s.values[i]!)))])} />
    </div>
  );
}

// --------------------------------------------------------------------- Heatmap

export interface HeatCell { row: string; col: string; rowLabel: string; colLabel: string; value: number | null }

export function Heatmap({ rows, cols, values, rowKeys, colKeys, format = defaultFormat, ariaLabel, onSelect, valueLabel = "value" }: {
  rows: string[];
  cols: string[];
  /** values[r][c]; null = no data (drawn hatched, not as the lowest colour). */
  values: Array<Array<number | null>>;
  /** Stable keys for onSelect when labels are not enough (defaults to the labels). */
  rowKeys?: string[];
  colKeys?: string[];
  format?: (v: number) => string;
  ariaLabel: string;
  valueLabel?: string;
  onSelect?: (c: HeatCell) => void;
}) {
  const { ref, W, tip, bind } = useChart();
  const max = Math.max(0, ...values.flat().map((v) => v ?? 0));
  const L = Math.max(...rows.map((r) => tw(r)), 10) + 10, T = 22, R = 4;
  const cw = Math.max(10, Math.min(52, (W - L - R) / Math.max(cols.length, 1)));
  const ch = Math.max(18, Math.min(34, cw * 0.8));
  const H = T + rows.length * ch + 4;
  const every = Math.max(1, Math.ceil(Math.max(...cols.map((c) => tw(c)), 8) / cw));
  return (
    <div className="ich" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={ariaLabel}>
        <defs>
          <pattern id="ich-nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="ich-hatch" />
          </pattern>
        </defs>
        {cols.map((c, j) => j % every === 0 && <text key={j} x={L + j * cw + cw / 2} y={T - 7} className="ich-tick" textAnchor="middle">{c}</text>)}
        {rows.map((r, i) => (
          <g key={i}>
            <text x={L - 6} y={T + i * ch + ch / 2} className="ich-tick" textAnchor="end" dominantBaseline="middle">{r}</text>
            {cols.map((c, j) => {
              const v = values[i]?.[j] ?? null;
              const bg = v === null ? null : rampColour(max ? v / max : 0);
              const cell: HeatCell = { row: rowKeys?.[i] ?? r, col: colKeys?.[j] ?? c, rowLabel: r, colLabel: c, value: v };
              const text = `${r}, ${c}: ${v === null ? "no data" : format(v)}`;
              return (
                <g key={j} tabIndex={0} aria-label={text} className="ich-cell"
                  {...bind(`${r} · ${c}`, [v === null ? "no data" : `${valueLabel}: ${format(v)}`])}
                  {...press(onSelect && (() => onSelect(cell)))}>
                  <rect x={L + j * cw + 1} y={T + i * ch + 1} width={cw - 2} height={ch - 2} rx={3}
                    fill={bg ?? "url(#ich-nodata)"} className="ich-cellbox" />
                  {bg && cw >= 24 && (
                    <text x={L + j * cw + cw / 2} y={T + i * ch + ch / 2} textAnchor="middle" dominantBaseline="middle"
                      className="ich-cellval" style={{ fill: inkOn(bg) }}>{format(v!)}</text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <Tooltip tip={tip} width={W} />
      <div className="ich-scale" aria-hidden="true">
        <span>{format(0)}</span>
        <i style={{ background: `linear-gradient(90deg, ${rampColour(0)}, ${rampColour(0.5)}, ${rampColour(1)})` }} />
        <span>{format(max)}</span>
      </div>
      <DataTable caption={ariaLabel} head={["", ...cols]}
        rows={rows.map((r, i) => [r, ...cols.map((_, j) => (values[i]?.[j] == null ? null : format(values[i][j]!)))])} />
    </div>
  );
}

// -------------------------------------------------------------------- Stack100

export interface Part { key: string; label: string; value: number }

/** Shares of a whole as one 100% bar, each part labelled with its size. */
export function Stack100({ parts, format = defaultFormat, ariaLabel, onSelect }: {
  parts: Part[];
  format?: (v: number) => string;
  ariaLabel: string;
  onSelect?: (p: ChartPoint) => void;
}) {
  const { ref, W, tip, bind } = useChart();
  const total = parts.reduce((a, p) => a + p.value, 0);
  let acc = 0;
  return (
    <div className="ich" ref={ref}>
      <svg width={W} height={34} viewBox={`0 0 ${W} 34`} role="group" aria-label={ariaLabel}>
        {total > 0 && parts.map((p, i) => {
          const w = (p.value / total) * W, x0 = acc;
          acc += w;
          const sr = seriesOf(i), share = `${Math.round((p.value / total) * 100)}%`;
          return (
            <g key={p.key} tabIndex={0} aria-label={`${p.label}: ${share} (${format(p.value)})`} className="ich-seg"
              {...bind(p.label, [`${share} · ${format(p.value)}`])}
              {...press(onSelect && (() => onSelect({ key: p.key, label: p.label, series: p.key, value: p.value })))}>
              <rect x={x0 + 1} y={2} width={Math.max(0, w - 2)} height={30} rx={4} style={{ fill: sr.token }} />
              {w > tw(share, 12) + 10 && <text x={x0 + w / 2} y={18} textAnchor="middle" dominantBaseline="middle" className="ich-cellval" style={{ fill: inkOn("#b98cff") }}>{share}</text>}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={W} />
      <Legend items={parts.map((p) => ({ key: p.key, label: p.label, detail: total ? `${Math.round((p.value / total) * 100)}%` : "–" }))} />
      <DataTable caption={ariaLabel} head={["", "count", "share"]}
        rows={parts.map((p) => [p.label, format(p.value), total ? `${Math.round((p.value / total) * 100)}%` : "no data"])} />
    </div>
  );
}

// ------------------------------------------------------------------- ChartCard

export const coverageText = (n: number, of: number, what: string) =>
  `${of ? Math.round((n / of) * 100) : 0}% of ${what} (${fmtCount(n)} of ${fmtCount(of)})`;

/** A panel for one chart: title, the sentence that says how to read it, an
 *  optional coverage badge ("how much of the library is behind this"), a CSV button. */
export function ChartCard({ title, reading, coverage, csv, children, className, actions }: {
  title: string;
  /** One sentence saying what to take from the chart (or how to read it). */
  reading?: ReactNode;
  coverage?: string;
  csv?: { header: string[]; rows: Cell[][]; title?: string };
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  const tag = useContext(RangeTag);
  const rows = csv?.rows.length ?? 0;
  return (
    <section className={`panel chart ichart${className ? " " + className : ""}`} aria-label={title}>
      <div className="charthead">
        <h2>{title}</h2>
        <div className="ich-actions">
          {coverage && <span className="ich-cover" title="How much of the library this chart is based on">{coverage}</span>}
          {actions}
          {csv && rows > 0 && (
            <button className="csvbtn" title="Download these figures as a spreadsheet (CSV)" aria-label={`Download ${title} as CSV`}
              onClick={() => downloadText(csvFilename(csv.title ?? title, tag), toCsv(csv.header, csv.rows))}>
              <DownloadIcon size={14} /> CSV
            </button>
          )}
        </div>
      </div>
      {reading && <p className="ich-reading">{reading}</p>}
      {children}
    </section>
  );
}
