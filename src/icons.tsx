/** Small line icons in the cosmic style: thin strokes, a soft glow, and only
 *  currentColor, so a parent's `color` themes them. No emoji. */
import type { ReactNode } from "react";
import { PHASE_NAMES } from "./moon.ts";
import type { Condition } from "./weather.ts";

function Svg({ size, children, title }: { size: number; children: ReactNode; title?: string }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"
      role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

// ------------------------------------------------------------------- moon

const R = 9, C = 12;

/** The lit part of the disc. In the northern hemisphere the right edge lights
 *  first (waxing) and the left edge is the last to go (waning). The terminator
 *  is an ellipse of the same height whose width follows cos of the phase angle. */
function litPath(phase: number): string | null {
  if (phase === 0) return null;
  const waxing = phase < 4;
  const k = Math.cos((phase / 8) * 2 * Math.PI);          // 1 new .. -1 full
  const rx = Math.abs(k) * R;
  const top = `${C} ${C - R}`, bottom = `${C} ${C + R}`;
  if (phase === 4) return `M${top} A${R} ${R} 0 0 1 ${bottom} A${R} ${R} 0 0 1 ${top}Z`;
  const limb = waxing ? 1 : 0;                              // sweep along the lit edge
  const term = rx < 0.01
    ? `L${top}`
    : `A${rx.toFixed(2)} ${R} 0 0 ${k > 0 ? 1 - limb : limb} ${top}`;
  return `M${top} A${R} ${R} 0 0 ${limb} ${bottom} ${term}Z`;
}

export function MoonIcon({ phase, size = 22, title }: { phase: number; size?: number; title?: string }) {
  const lit = litPath(phase);
  return (
    <Svg size={size} title={title ?? PHASE_NAMES[phase]}>
      <circle cx={C} cy={C} r={R} className="ico-dark" strokeOpacity={0.45} />
      {lit && <path d={lit} fill="currentColor" fillOpacity={0.88} stroke="none" />}
      <circle cx={C} cy={C} r={R} strokeOpacity={0.75} />
    </Svg>
  );
}

// ---------------------------------------------------------------- weather

const CLOUD = "M7.5 18.5H17A3.5 3.5 0 0 0 17.4 11.5A5.5 5.5 0 0 0 6.9 12.7A3 3 0 0 0 7.5 18.5Z";

const Cloud = ({ dy = 0 }: { dy?: number }) => (
  <path d={CLOUD} className="ico-dark" transform={`translate(0 ${dy})`} />
);

const Sun = ({ cx = 12, cy = 12, r = 3.6, rays = 8, reach = 2.6 }: {
  cx?: number; cy?: number; r?: number; rays?: number; reach?: number;
}) => (
  <>
    <circle cx={cx} cy={cy} r={r} />
    {Array.from({ length: rays }, (_, i) => {
      const a = (i / rays) * 2 * Math.PI;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      return <line key={i} x1={cx + c * (r + 1.7)} y1={cy + s * (r + 1.7)}
        x2={cx + c * (r + 1.7 + reach)} y2={cy + s * (r + 1.7 + reach)} />;
    })}
  </>
);

export const CONDITION_ICON: Record<Condition, (p: { size: number }) => ReactNode> = {
  clear: ({ size }) => <Svg size={size}><Sun /></Svg>,
  partly: ({ size }) => (
    <Svg size={size}>
      <Sun cx={9} cy={9} r={3} rays={6} reach={1.8} />
      <g transform="translate(2.5 1.5) scale(.8)"><Cloud /></g>
    </Svg>
  ),
  cloudy: ({ size }) => <Svg size={size}><Cloud /></Svg>,
  fog: ({ size }) => (
    <Svg size={size}>
      <path d="M7 10.5A5 5 0 0 1 17 10.5" strokeOpacity={0.8} />
      <line x1={4} y1={13.5} x2={20} y2={13.5} />
      <line x1={6} y1={17} x2={18} y2={17} />
      <line x1={9} y1={20.5} x2={15} y2={20.5} />
    </Svg>
  ),
  drizzle: ({ size }) => (
    <Svg size={size}>
      <Cloud dy={-3} />
      <line x1={9} y1={18} x2={8.4} y2={19.4} /><line x1={13} y1={18} x2={12.4} y2={19.4} />
      <line x1={17} y1={18} x2={16.4} y2={19.4} />
    </Svg>
  ),
  rain: ({ size }) => (
    <Svg size={size}>
      <Cloud dy={-3} />
      <line x1={9} y1={17.5} x2={7.8} y2={21} /><line x1={13} y1={17.5} x2={11.8} y2={21} />
      <line x1={17} y1={17.5} x2={15.8} y2={21} />
    </Svg>
  ),
  snow: ({ size }) => (
    <Svg size={size}>
      <Cloud dy={-3} />
      {[8.5, 12.5, 16.5].map((x, i) => (
        <g key={x} transform={`translate(${x} ${i === 1 ? 20.4 : 19})`}>
          <line x1={-1.2} y1={0} x2={1.2} y2={0} /><line x1={0} y1={-1.2} x2={0} y2={1.2} />
          <line x1={-0.85} y1={-0.85} x2={0.85} y2={0.85} /><line x1={-0.85} y1={0.85} x2={0.85} y2={-0.85} />
        </g>
      ))}
    </Svg>
  ),
  thunder: ({ size }) => (
    <Svg size={size}>
      <Cloud dy={-3} />
      <path d="M12.8 14.5L9.8 18.8H12.6L11.2 22.2L15.2 17.6H12.4Z" fill="currentColor" fillOpacity={0.35} />
    </Svg>
  ),
};

export function WeatherIcon({ condition, size = 22, title }: {
  condition: Condition; size?: number; title?: string;
}) {
  const Icon = CONDITION_ICON[condition];
  return <span className="ico-wrap" title={title}>{Icon({ size })}</span>;
}

export function Thermometer({ size = 20 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M10 14.2V5.5a2 2 0 0 1 4 0v8.7a4 4 0 1 1-4 0Z" />
      <line x1={12} y1={9} x2={12} y2={16.2} strokeOpacity={0.9} />
      <circle cx={12} cy={17.3} r={1.5} fill="currentColor" stroke="none" />
    </Svg>
  );
}
