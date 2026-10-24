/** Nights & sound: outliers and file quality. New sections go in the list below
 *  (see SectionDef in ./types.ts). */
import { memo } from "react";
import { Sections } from "./shared.tsx";
import { NIGHTS_SECTIONS } from "./NightsSections.tsx";
import { NIGHTS_NEW_SECTIONS } from "./NightsCharts.tsx";
import type { SectionDef, TabProps } from "./types.ts";

const SECTIONS: SectionDef[] = [...NIGHTS_NEW_SECTIONS, ...NIGHTS_SECTIONS];

export default memo(function TabNights(props: TabProps) {
  return <Sections sections={SECTIONS} props={props} />;
});
