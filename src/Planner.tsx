/** Planning a night: paste what you mean to bring, see what has been brought.
 *
 *  The verdicts come from src/planner.ts. A row opens the same drilldown as
 *  Insights, hosted beside the table, so "has this been played?" is one click
 *  from "when, and by whom?".
 */
import { useMemo, useRef, useState } from "react";
import type { Catalog } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import DrillPanel, { type Drill } from "./Drill.tsx";
import type { Range } from "./analytics.ts";
import {
  buildPlanIndex, checkList, newOnes, parseExportify, parseList, summarise,
  type Parsed, type PlanRow, type Verdict,
} from "./planner.ts";

const VERDICTS: Verdict[] = ["never", "played", "variant", "clash"];
const WORDS: Record<Verdict, string> = {
  never: "new", played: "played", variant: "other version", clash: "repeat",
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function detail(r: PlanRow): string {
  const bits: string[] = [];
  if (r.verdict === "clash") {
    bits.push(`same song as line ${r.clashWith} of your list`);
  } else if (r.found === "never") {
    bits.push(r.artist
      ? `artist known: ${plural(r.artist.songs, "song")} on ${plural(r.artist.nights, "night")}, last ${r.artist.last ?? "undated"}`
      : "artist not in the library");
    if (r.shelf) bits.push("on a shelf (favs / mix), never on a night");
  } else {
    if (r.label) bits.push(r.label);
    bits.push(r.first === r.last ? `${plural(r.nights, "night")}, ${r.first ?? "undated"}`
      : `${plural(r.nights, "night")}, ${r.first} → ${r.last}`);
    if (r.bringers.length) bits.push("brought by " + r.bringers.join(", "));
    if (r.you) bits.push("you brought it");
  }
  return bits.join(" · ");
}

export default function Planner({ cat, range, onRange, onTrace, onOpenNight }: {
  cat: Catalog;
  range: Range | null;
  onRange: (r: Range | null) => void;
  onTrace: (t: Trace) => void;
  onOpenNight: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ name: string; parsed: Parsed } | null>(null);
  const [filter, setFilter] = useState<Verdict | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stack, setStack] = useState<Drill[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const drill = stack[stack.length - 1] ?? null;
  const open = (d: Drill) => setStack((s) => [...s, d]);

  const ix = useMemo(() => buildPlanIndex(cat), [cat]);
  const parsed = useMemo(() => file ? file.parsed : parseList(text, ix), [file, text, ix]);
  const rows = useMemo(() => checkList(ix, parsed.candidates), [ix, parsed]);
  const { counts, sentence } = useMemo(() => summarise(rows), [rows]);
  const shown = filter ? rows.filter((r) => r.verdict === filter) : rows;

  const take = async (f: File | undefined) => {
    if (!f) return;
    setFile({ name: f.name, parsed: parseExportify(await f.text()) });
    setFilter(null); setCopied(null);
  };

  const copyNew = async () => {
    await navigator.clipboard.writeText(newOnes(rows));
    setCopied(counts.never);
  };

  const target = (r: PlanRow): Drill | null =>
    r.songId && r.found !== "never" ? { kind: "song", id: r.songId }
      : r.artist ? { kind: "artist", id: r.artist.id } : null;

  return (
    <div className={`page wide insights${drill ? " has-drill" : ""}`}>
      <div className="ins-main">
        <h1>Plan a night</h1>
        <p className="sub">
          Paste the songs you mean to bring, one <b>Artist - Title</b> per line, or drop an
          Exportify CSV. Only nights count; a different version (live, remix) counts as played
          and says so.
        </p>

        <div className={`panel pl-input${dragging ? " drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void take(e.dataTransfer.files[0]); }}>
          {file ? (
            <div className="pl-file">
              <b>{file.name}</b> · {plural(file.parsed.candidates.length, "track")}
              <button className="tl-clear" onClick={() => { setFile(null); setCopied(null); }}>use the text box instead</button>
            </div>
          ) : (
            <textarea className="searchbox pl-text" value={text} spellCheck={false}
              onChange={(e) => { setText(e.target.value); setCopied(null); }}
              placeholder={"Nightwish - Ghost Love Score\n02. Heilung – Hamrer Hippyer\nKing Buffalo - Red Star Pt. 2 (Live)"} />
          )}
          <div className="pl-bar">
            <button className="dr-btn ghost" onClick={() => picker.current?.click()}>choose an Exportify CSV</button>
            <input ref={picker} type="file" accept=".csv,text/csv" hidden
              onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />
            <span className="src">or drop one here</span>
          </div>
        </div>

        {parsed.skipped.length > 0 && (
          <div className="chart-note" title={parsed.skipped.join("\n")}>
            {plural(parsed.skipped.length, "line")} skipped (no "Artist - Title"): {parsed.skipped.slice(0, 3).join(" | ")}
            {parsed.skipped.length > 3 && " …"}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="pl-summary">
              <span>{sentence}</span>
              <button className="dr-btn" disabled={!counts.never} onClick={() => void copyNew()}>
                copy the new ones
              </button>
              {copied !== null && <span className="src">copied {plural(copied, "line")}</span>}
            </div>

            <div className="pl-filters">
              <button className={`tl-zoom${filter ? "" : " on"}`} aria-pressed={!filter} onClick={() => setFilter(null)}>
                all {rows.length}
              </button>
              {VERDICTS.filter((v) => counts[v]).map((v) => (
                <button key={v} className={`vchip ${v}${filter === v ? " on" : ""}`} aria-pressed={filter === v}
                  onClick={() => setFilter(filter === v ? null : v)}>
                  {WORDS[v]} {counts[v]}
                </button>
              ))}
            </div>

            <div className="panel pl-table">
              {shown.map((r) => {
                const d = target(r);
                return (
                  <div key={r.cand.line} className={`pl-row${d ? " clickable" : ""}`}
                    role={d ? "button" : undefined} tabIndex={d ? 0 : undefined}
                    title={d ? "Open the detail" : undefined}
                    onClick={() => d && open(d)}
                    onKeyDown={(e) => { if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(d); } }}>
                    <span className="rank">{r.cand.line}</span>
                    <span className="pl-song">
                      <b>{r.cand.title}</b>
                      <i className="sublabel">{r.cand.artists[0]}</i>
                      <span className="pl-detail">{detail(r)}</span>
                    </span>
                    <span className={`vchip ${r.verdict}`}>{WORDS[r.verdict]}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {drill && (
        <DrillPanel cat={cat} drill={drill} range={range} canBack={stack.length > 1}
          onBack={() => setStack((s) => s.slice(0, -1))} onClose={() => setStack([])} onDrill={open}
          onTrace={onTrace} onRange={(r) => { onRange(r); setStack([]); }}
          onOpenNight={onOpenNight} />
      )}
    </div>
  );
}
