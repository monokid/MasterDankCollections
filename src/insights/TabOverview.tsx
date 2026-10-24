/** Overview: the KPI strip (pinned by the shell) is the hero; under it, three
 *  charts of how the years compare. */
import { memo } from "react";
import { BarChart, ChartCard, LineChart, coverageText, type BarDatum } from "../charts.tsx";
import { fmtCount } from "../format.ts";
import { formatKpi } from "../insightstats.ts";
import type { TabProps } from "./types.ts";

const peak = (years: string[], vals: Array<number | null>) => {
  let best = -1;
  vals.forEach((v, i) => { if (v !== null && (best < 0 || v > vals[best]!)) best = i; });
  return best < 0 ? null : { year: years[best], value: vals[best]! };
};

export default memo(function TabOverview({ ctx, open }: TabProps) {
  const { report } = ctx;
  if (!report.nights.length) {
    return <p className="sub">No nights in this range. Reset the range to see the whole library.</p>;
  }
  const { years } = report;
  const nightsK = report.byId.nights, playsK = report.byId.plays, pplK = report.byId.peoplePerNight;
  const toYear = (p: { key: string }) => open({ kind: "year", year: p.key });

  const nightBars: BarDatum[] = years.map((y, i) => ({ key: y, label: y, values: [nightsK.yearSeries[i].value] }));
  const playBars: BarDatum[] = years.map((y, i) => ({ key: y, label: y, values: [playsK.yearSeries[i].value] }));
  const pn = peak(years, nightsK.yearSeries.map((p) => p.value)), pp = peak(years, playsK.yearSeries.map((p) => p.value));

  const nr = report.newVsReturning;
  const nrBars: BarDatum[] = nr.map((r) => ({
    key: r.year, label: r.year, values: [r.fresh, r.returning],
    note: r.share === null ? ["no earlier nights to compare with"] : [`${Math.round(r.share * 100)}% new`],
  }));
  const named = report.nights.reduce((a, r) => a + r.songIds.length, 0);
  const onNights = report.nights.reduce((a, r) => a + r.songs, 0);
  const lastShare = [...nr].reverse().find((r) => r.share !== null);

  const ppl = pplK.yearSeries;
  const pplPeak = peak(years, ppl.map((p) => p.value));

  return (
    <div className="ins-over">
      <div className="charts">
        <ChartCard title="Nights and plays per year"
          reading={pn && pp ? `Most nights: ${pn.year} (${fmtCount(pn.value)}). Most plays: ${pp.year} (${fmtCount(pp.value)}). A play is one song from one person on one night.` : undefined}
          csv={{ header: ["year", "nights", "plays"], rows: years.map((y, i) => [y, nightsK.yearSeries[i].value, playsK.yearSeries[i].value]) }}>
          <BarChart data={nightBars} series={[{ key: "nights", label: "Nights" }]} height={130} showValues
            ariaLabel="Nights per year" onSelect={toYear} />
          <BarChart data={playBars} series={[{ key: "plays", label: "Plays" }]} colour={1} height={130} average="auto"
            ariaLabel="Plays per year" onSelect={toYear} />
        </ChartCard>

        <ChartCard title="New and returning music, by year"
          reading={lastShare ? `In ${lastShare.year}, ${Math.round(lastShare.share! * 100)}% of the songs on a night had not been heard on any earlier night. The first night in the library has nothing before it and is left out.` : "Needs at least two nights to compare."}
          coverage={coverageText(named, onNights, "songs on a night with an identity")}
          csv={{ header: ["year", "new songs", "heard before"], rows: nr.map((r) => [r.year, r.fresh, r.returning]) }}>
          <BarChart data={nrBars} stacked
            series={[{ key: "fresh", label: "New to the library" }, { key: "returning", label: "Heard before" }]}
            ariaLabel="New and returning songs per year" height={210} onSelect={toYear} />
        </ChartCard>

        <ChartCard title="People per night, by year"
          reading={pplPeak ? `The average night had ${formatKpi("dec1", pplK.value)} people; the highest yearly average was ${formatKpi("dec1", pplPeak.value)} in ${pplPeak.year}.` : undefined}
          csv={{ header: ["year", "people per night"], rows: years.map((y, i) => [y, ppl[i].value === null ? null : Math.round(ppl[i].value! * 100) / 100]) }}>
          <LineChart labels={years} series={[{ key: "ppl", label: "People per night", values: ppl.map((p) => p.value) }]}
            rolling={3} rollingLabel="3-year average" format={(v) => formatKpi("dec1", v)}
            ariaLabel="Average people per night, by year" onSelect={toYear} />
        </ChartCard>
      </div>
    </div>
  );
});
