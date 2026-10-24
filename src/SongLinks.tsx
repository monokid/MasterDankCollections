/** Two small buttons that open a song on Spotify and YouTube in a new tab.
 *  Nothing is contacted while drawing: the links are plain anchors, followed only
 *  on a click. Clicks stop here so a row click (which opens the song) is not
 *  also fired. Put it OUTSIDE any <button> (an anchor inside a button is invalid). */
import type { MouseEvent, ReactNode } from "react";
import { spotifyHref, youtubeHref, UNKNOWN, UNKNOWN_LABEL, type LinkSource } from "./songcols.ts";
import "./songcols.css";

const stop = (e: MouseEvent) => e.stopPropagation();

export function SpotifyIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.18" />
      <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M6.6 9.2c3.6-1 7.6-.7 10.9 1.1" />
        <path d="M7.3 12.6c3-.8 6.1-.5 8.7.9" />
        <path d="M8 15.8c2.4-.6 4.7-.3 6.8.8" />
      </g>
    </svg>
  );
}

export function YouTubeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" fill="currentColor" opacity="0.18" />
      <path d="M10 9.2v5.6l5-2.8z" fill="currentColor" />
    </svg>
  );
}

export default function SongLinks({ song, className }: { song: LinkSource; className?: string }) {
  const sp = spotifyHref(song), yt = youtubeHref(song);
  const spLabel = sp.exact ? "Open in Spotify" : "Search on Spotify";
  return (
    <span className={`sl${className ? ` ${className}` : ""}`}>
      <a className={`sl-a sl-sp${sp.exact ? " exact" : ""}`} href={sp.href} target="_blank" rel="noopener noreferrer"
        aria-label={spLabel} title={spLabel} onClick={stop}>
        <SpotifyIcon />
      </a>
      <a className="sl-a sl-yt" href={yt.href} target="_blank" rel="noopener noreferrer"
        aria-label="Search on YouTube" title="Search on YouTube" onClick={stop}>
        <YouTubeIcon />
      </a>
    </span>
  );
}

/** A cell's text, or an em-dash that screen readers read as "unknown". */
export function CellText({ value, title, children }: { value: string | null; title?: string; children?: ReactNode }) {
  return value
    ? <span title={title}>{children ?? value}</span>
    : <span className="sc-unknown" role="img" aria-label={UNKNOWN_LABEL}>{UNKNOWN}</span>;
}
