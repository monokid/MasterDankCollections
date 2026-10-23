import type { Catalog, Track } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import { catalogIndex } from "./catalogIndex.ts";
import { Flags, fmtDate, fmtDur } from "./rows.tsx";

/** One track, with where every field came from. */
export default function TrackDetail({ track, cat, onClose, onTrace }: {
  track: Track; cat: Catalog; onClose: () => void; onTrace: (t: Trace) => void;
}) {
  const ix = catalogIndex(cat);
  const person = track.personId ? ix.person.get(track.personId) : undefined;
  const ev = ix.event.get(track.eventId);
  const phase = track.phaseId ? ix.phase.get(track.phaseId) : undefined;
  const song = track.songId ? ix.song.get(track.songId) : undefined;
  const artist = song ? ix.artist.get(song.id.split("|")[0]) : undefined;
  const twin = track.twinId ? ix.track.get(track.twinId) : undefined;
  const via = (f: string) => <span className="prov">via {track.provenance[f] ?? "unknown"}</span>;
  return (
    <div className="page">
      <button className="backlink" onClick={onClose}>← back</button>
      <div className="panel detail">
        <h1>{track.title ?? "(untitled)"}</h1>
        <p className="sub">{track.artist ?? "unknown artist"} <Flags track={track} /></p>
        <dl>
          <dt>Artist</dt><dd>{track.artist ?? "—"}{via("artist")}</dd>
          <dt>Title</dt><dd>{track.title ?? "—"}{via("title")}</dd>
          {track.album && <><dt>Album</dt><dd>{track.album}</dd></>}
          <dt>Brought by</dt><dd>{person?.name ?? "unknown"}{via("person")}</dd>
          {twin && (
            <>
              <dt>{track.flags.includes("anon") ? "Named as" : "Anonymised as"}</dt>
              <dd>
                {twin.flags.includes("anon")
                  ? <code>{twin.path[twin.path.length - 1]}</code>
                  : `${twin.artist ? twin.artist + " — " : ""}${twin.title}`}
                <span className="prov">paired by running time</span>
              </dd>
            </>
          )}
          {track.playOrder !== null && (
            <><dt>Set order</dt><dd>number {track.playOrder} in this contributor's set</dd></>
          )}
          <dt>Event</dt><dd>{fmtDate(ev?.date ?? null)} · {ev?.folder}{via("event")}</dd>
          {phase && <><dt>Phase</dt><dd>{phase.clean} ({phase.bucket})
            {phase.minutes ? ` · ${phase.minutes} min` : ""}{via("phase")}</dd></>}
          {song && song.nights.length > 1 && (
            <>
              <dt>History</dt>
              <dd>
                played on <b>{song.nights.length} nights</b>, {song.firstPlayed} to{" "}
                {song.lastPlayed}
                {song.variants.length > 0 && <> · as {song.variants.join(", ")}</>}
                <button className="backlink" style={{ marginLeft: 10, marginBottom: 0 }}
                  onClick={() => onTrace({
                    kind: "song", id: song.id,
                    label: `${song.artist} — ${song.title}`,
                    nights: new Set(song.nights),
                  })}>show on timeline →</button>
              </dd>
            </>
          )}
          {artist && artist.nights.length > 1 && (
            <>
              <dt>This artist</dt>
              <dd>
                {artist.songs} song{artist.songs === 1 ? "" : "s"} across{" "}
                <b>{artist.nights.length} nights</b>
                <button className="backlink" style={{ marginLeft: 10, marginBottom: 0 }}
                  onClick={() => onTrace({
                    kind: "artist", id: artist.id, label: artist.name,
                    nights: new Set(artist.nights),
                  })}>show on timeline →</button>
              </dd>
            </>
          )}
          <dt>Length</dt><dd>{fmtDur(track.durationSec) || "—"}</dd>
          {track.source === "spotify"
            ? <><dt>From</dt><dd>a Spotify playlist export — no file in the library</dd></>
            : <>
                <dt>File</dt><dd>{track.ext} · {(track.sizeBytes / 1e6).toFixed(1)} MB</dd>
                <dt>Path</dt><dd><code>{track.path.join(" / ")}</code></dd>
              </>}
          {track.spotifyUri && (
            <>
              <dt>Spotify</dt>
              <dd><a href={`https://open.spotify.com/track/${track.spotifyUri.split(":").pop()}`}
                target="_blank" rel="noreferrer">open in Spotify ↗</a></dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
