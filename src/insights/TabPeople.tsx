/** People. New sections go in the list below (see SectionDef in ./types.ts). */
import { memo } from "react";
import { Sections } from "./shared.tsx";
import { PEOPLE_SECTIONS } from "./PeopleSections.tsx";
import { PEOPLE_CHART_SECTIONS } from "./PeopleCharts.tsx";
import type { SectionDef, TabProps } from "./types.ts";

const SECTIONS: SectionDef[] = [...PEOPLE_CHART_SECTIONS, ...PEOPLE_SECTIONS];

export default memo(function TabPeople(props: TabProps) {
  return <Sections sections={SECTIONS} props={props} />;
});
