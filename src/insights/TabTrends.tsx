/** Trends: discovery, the year-by-year figures, years that stand out, and
 *  artists rising and fading. New sections go in the list below (see SectionDef
 *  in ./types.ts). */
import { memo } from "react";
import { Sections } from "./shared.tsx";
import { TRENDS_SECTIONS } from "./TrendsSections.tsx";
import { TRENDS_NEW_SECTIONS } from "./TrendsCharts.tsx";
import type { SectionDef, TabProps } from "./types.ts";

const SECTIONS: SectionDef[] = [...TRENDS_NEW_SECTIONS, ...TRENDS_SECTIONS];

export default memo(function TabTrends(props: TabProps) {
  return <Sections sections={SECTIONS} props={props} />;
});
