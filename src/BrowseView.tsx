import { Suspense, useEffect, useRef, useState } from "react";
import type { Catalog, Track } from "./catalog.ts";
import EventsList from "./Browse.tsx";
import { lazyPage } from "./lazy.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { isShown } from "./config.ts";
import type { WeatherMap } from "./weather.ts";
import Loader from "./Loader.tsx";

/** One night's page is its own chunk: the list of nights does not need it. */
export const NightPage = lazyPage(() => import("./NightPage.tsx"));

/** Browse: the list of nights, or one night when `eventId` is set. */
export default function BrowseView({ cat, weather, onOpen, eventId, setEventId }: {
  cat: Catalog; weather: WeatherMap; onOpen: (t: Track) => void;
  eventId: string | null; setEventId: (id: string | null) => void;
}) {
  // The night we just left, so the list can scroll back to its card. Derived
  // from the change itself, so the browser's Back button gets it too.
  const [from, setFrom] = useState<string | null>(null);
  const prev = useRef(eventId);
  useEffect(() => {
    if (prev.current && !eventId) setFrom(prev.current);
    prev.current = eventId;
  }, [eventId]);

  const found = eventId ? catalogIndex(cat).event.get(eventId) : undefined;
  const ev = found && isShown(found) ? found : null;

  if (!ev) {
    return <EventsList cat={cat} weather={weather} focusId={from} onOpenNight={setEventId} />;
  }
  return (
    <Suspense fallback={<Loader />}>
      <NightPage cat={cat} ev={ev} weather={weather} onOpen={onOpen}
        onBack={() => setEventId(null)} onGoto={setEventId} />
    </Suspense>
  );
}
