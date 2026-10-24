/** A song's cover: generative art unique to the song, with the real cover image
 *  fading in over it when there is one. The box has a fixed size, so a slow,
 *  blocked or missing image never shifts the layout (the art just stays).
 *  Decorative: the title and artist are always written next to it. */
import { useState, type CSSProperties } from "react";
import { initialsOf, tileArt } from "./musicstats.ts";
import "./detail.css";

export interface CoverProps {
  songId: string;
  title: string;
  /** Not drawn; kept so callers can pass what they have (and for future alt text). */
  artist?: string;
  /** The image to fade in, or null for art only. */
  url: string | null;
  /** Edge length in px. */
  size: number;
  className?: string;
}

export default function Cover({ songId, title, url, size, className }: CoverProps) {
  const a = tileArt(songId);
  const vars = {
    width: size, height: size, "--cv-font": `${Math.max(11, Math.round(size * 0.3))}px`,
    "--h1": a.h1, "--h2": a.h2, "--ang": a.angle, "--x1": a.x1, "--y1": a.y1, "--x2": a.x2, "--y2": a.y2,
    "--blob": a.blob, "--spin": `${a.spin}deg`,
  } as unknown as CSSProperties;
  return (
    <span className={`cv${className ? ` ${className}` : ""}`} style={vars} aria-hidden="true">
      <span className="cv-blob" />
      <span className="cv-init">{initialsOf(title)}</span>
      {/* keyed by url: a new song starts from "waiting", not from the last one's state */}
      {url && <CoverImg key={url} url={url} />}
    </span>
  );
}

function CoverImg({ url }: { url: string }) {
  const [state, setState] = useState<"wait" | "on" | "failed">("wait");
  if (state === "failed") return null;
  return (
    <img className={`cv-img${state === "on" ? " on" : ""}`} src={url} alt="" loading="lazy" decoding="async"
      referrerPolicy="no-referrer" onLoad={() => setState("on")} onError={() => setState("failed")} />
  );
}
