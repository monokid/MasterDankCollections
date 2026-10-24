/** The night page's playlists: the standard song columns plus a play-order column,
 *  and what each row says when the track has no song behind it. Pure (no React),
 *  so tools/nightlist.test.ts can run it. */
import type { Track } from "./catalog.ts";
import { songColumns, type Column, type LinkSource, type SongInfo } from "./songcols.ts";

/** Where the track fell in its set; null when the lists do not say. */
export const playNumber = (t: Pick<Track, "playOrder">): number | null =>
  typeof t.playOrder === "number" && Number.isFinite(t.playOrder) ? t.playOrder : null;

/** Order, then the standard columns without "nights" (a night is one night). */
export function nightColumns(get: (t: Track) => SongInfo): Column<Track>[] {
  const order: Column<Track> = {
    id: "order", label: "Order", width: "44px", align: "right",
    sortKey: playNumber, text: (t) => { const n = playNumber(t); return n === null ? null : String(n); },
  };
  return [order, ...songColumns<Track>(get).filter((c) => c.id !== "nights")];
}

export interface RowView {
  /** No song identity: a file nothing could name. Drawn as its file name. */
  nameless: boolean;
  /** For an unnamed copy whose named twin is not a song of its own: "= Artist — Title". */
  twinHint: string | null;
  /** Worth offering Spotify/YouTube links: a search for a file name is useless. */
  linkable: boolean;
  /** What the links search for; the track's own Spotify uri wins over the song's. */
  linkSource: LinkSource;
}

export function rowView(track: Track, info: SongInfo, twin?: Track): RowView {
  const nameless = !info.songId;
  const twinHint = twin && nameless && twin.title
    ? `= ${twin.artist ? `${twin.artist} — ` : ""}${twin.title}` : null;
  const spotifyUri = track.spotifyUri ?? info.spotifyUri;
  return {
    nameless, twinHint,
    linkable: !!(info.artist && info.title && !nameless) || !!track.spotifyUri,
    linkSource: { artist: info.artist, title: info.title, spotifyUri },
  };
}
