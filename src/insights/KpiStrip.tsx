/** The headline figures, pinned under the tab strip on every tab. Each tile is a
 *  door to the 'metric' drill. Wording is neutral: a change is stated, never
 *  coloured good or bad. */
import { memo } from "react";
import { Spark } from "../charts.tsx";
import { formatKpi, type Kpi, type KpiReport } from "../insightstats.ts";
import type { Drill } from "./types.ts";

const Tile = memo(function Tile({ k, slim, onOpen }: { k: Kpi; slim: boolean; onOpen: (d: Drill) => void }) {
  const d = k.deltaVsPrev;
  const value = formatKpi(k.format, k.value);
  return (
    <button className="kpi" onClick={() => onOpen({ kind: "metric", id: k.id })}
      title={`${k.sentence}${d ? "\n" + d.text : ""}\nClick for the years and nights behind it.`}
      aria-label={`${k.label}: ${value}. ${k.sentence}${d ? " " + d.text : ""} Open the detail.`}>
      <span className="kpi-k">{k.label}</span>
      <span className="kpi-v">{value}</span>
      {!slim && (
        <>
          <Spark values={k.yearSeries.map((p) => p.value)} labels={k.yearSeries.map((p) => p.year)}
            format={(v) => formatKpi(k.format, v)} ariaLabel={`${k.label} by year`} height={26} className="kpi-spark" />
          <span className="kpi-d">
            {d ? d.short : "no full year to compare"}
            {k.median !== undefined && k.median !== null && <i> · median {formatKpi(k.format, k.median)}</i>}
          </span>
        </>
      )}
    </button>
  );
});

export default memo(function KpiStrip({ report, slim, onOpen }: {
  report: KpiReport; slim: boolean; onOpen: (d: Drill) => void;
}) {
  return (
    <div className={`kpis${slim ? " is-slim" : ""}`} role="group" aria-label="Headline figures for the chosen range">
      {report.kpis.map((k) => <Tile key={k.id} k={k} slim={slim} onOpen={onOpen} />)}
    </div>
  );
});
