/** The People tab's long-standing section, moved out of Insights.tsx as it was. */
import { memo, useMemo } from "react";
import { cast } from "../analytics.ts";
import { fmtCount, plural } from "../format.ts";
import { Chart, TOP } from "./shared.tsx";
import type { Row, SectionDef, TabProps } from "./types.ts";

const PeopleSection = memo(function PeopleSection({ cat, range, open }: TabProps) {
  const personRows = useMemo<Row[]>(() => cat.people.map((p) => ({
    label: p.name, value: p.trackCount, text: `${fmtCount(p.trackCount)} tracks`,
    drill: { kind: "person", id: p.id },
  })), [cat]);
  const signature = useMemo<Row[]>(() => cat.people.map((p) => ({
    label: p.name,
    value: cat.artists.filter((a) => a.people.length === 1 && a.people[0] === p.id && a.plays >= 3).length,
    drill: { kind: "person" as const, id: p.id },
  })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value), [cat]);
  const shared = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < cat.people.length; i++) for (let j = i + 1; j < cat.people.length; j++) {
      const a = cat.people[i], b = cat.people[j];
      const n = cat.artists.filter((x) => x.people.includes(a.id) && x.people.includes(b.id)).length;
      if (n > 0) out.push({ label: `${a.name} + ${b.name}`, value: n, text: `${n} artists` });
    }
    return out.sort((x, y) => y.value - x.value).slice(0, TOP);
  }, [cat]);
  const castRows = useMemo<Row[]>(() => cast(cat, range).map((c) => ({
    label: c.year, value: Math.round(c.avgPeople * 10) / 10,
    text: `${c.avgPeople.toFixed(1)} people`, sub: plural(c.nights, "night"),
    drill: { kind: "year", year: c.year },
  })), [cat, range]);
  return (
    <div className="charts">
      <Chart title="Tracks brought" rows={personRows} onDrill={open} />
      <Chart title="Artists nobody else brings" rows={signature} onDrill={open}
        note="Artists played 3+ times and only ever by this one person." />
      <Chart title="Shared taste" rows={shared} onDrill={open}
        note="Artists both people have brought." />
      <Chart title="The cast over time" rows={castRows} onDrill={open}
        note="Average number of contributors per night." />
    </div>
  );
});

export const PEOPLE_SECTIONS: SectionDef[] = [
  { id: "people", label: "People", Body: PeopleSection },
];
