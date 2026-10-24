/** Music: new chart sections first (headline-first), then the long-standing lists
 *  (the canon, longevity, songs played once, solo artists). New sections go in the
 *  lists below (see SectionDef in ./types.ts). */
import { memo } from "react";
import { Sections } from "./shared.tsx";
import { MUSIC_SECTIONS } from "./MusicSections.tsx";
import { ENRICH_ONLY, MUSIC_CHART_SECTIONS } from "./MusicCharts.tsx";
import type { SectionDef, TabProps } from "./types.ts";

const WITH_ENRICH: SectionDef[] = [...MUSIC_CHART_SECTIONS, ...MUSIC_SECTIONS];
const WITHOUT_ENRICH: SectionDef[] = WITH_ENRICH.filter((s) => !ENRICH_ONLY.has(s.id));

export default memo(function TabMusic(props: TabProps) {
  return (
    <>
      {!props.enrich && (
        <p className="mi-note">
          The genre and release-year charts (sounds over time, release decades, the genre by decade map) need the
          music-database layer, which is not loaded, so they are left out.
        </p>
      )}
      <Sections sections={props.enrich ? WITH_ENRICH : WITHOUT_ENRICH} props={props} />
    </>
  );
});
