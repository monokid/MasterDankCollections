/** A night's moon and weather: a compact strip for cards, a larger block for the
 *  night's own page. Weather is optional -- without it only the moon shows. */
import { MoonIcon, WeatherIcon, Thermometer } from "./icons.tsx";
import { moonOnNight } from "./moon.ts";
import { CONDITION_LABEL, conditionOf, eveningOf, type DayWeather } from "./weather.ts";

const deg = (n: number) => `${Math.round(n)}°`;

export default function Sky({ date, weather, large }: {
  date: string; weather?: DayWeather; large?: boolean;
}) {
  const moon = moonOnNight(date);
  const pct = Math.round(moon.illumination * 100);
  const ev = weather ? eveningOf(weather) : null;
  const cond = ev ? conditionOf(ev.code) : null;

  if (!large) {
    return (
      <div className="sky">
        <span className="sky-item" title={`${moon.name}, ${pct}% lit`}>
          <MoonIcon phase={moon.phase} size={20} />
          <span>{moon.name} <i>{pct}%</i></span>
        </span>
        {ev && cond && (
          <span className="sky-item" title={`${CONDITION_LABEL[cond]} around 21:00; day ${deg(weather!.tmin)} to ${deg(weather!.tmax)}`}>
            <WeatherIcon condition={cond} size={20} />
            <span>{deg(ev.temp)} <i>{CONDITION_LABEL[cond]}</i></span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="skyblock">
      <div className="sky-card moon">
        <MoonIcon phase={moon.phase} size={54} />
        <div>
          <div className="sky-k">Moon</div>
          <div className="sky-v">{moon.name}</div>
          <div className="sky-s">{pct}% illuminated</div>
          <div className="sky-meter" aria-hidden><span style={{ width: `${pct}%` }} /></div>
        </div>
      </div>
      {weather && ev && cond ? (
        <div className="sky-card wx">
          <WeatherIcon condition={cond} size={54} />
          <div>
            <div className="sky-k">Weather at 21:00</div>
            <div className="sky-v">{deg(ev.temp)} <span>{CONDITION_LABEL[cond]}</span></div>
            <div className="sky-s">
              <Thermometer size={13} /> day {deg(weather.tmin)} to {deg(weather.tmax)}
            </div>
            <div className="sky-s">
              {weather.precip > 0 ? `${weather.precip} mm rain` : "dry"} · wind up to {Math.round(weather.wind)} km/h
            </div>
          </div>
        </div>
      ) : (
        <div className="sky-card wx none"><div className="sky-s">No weather on record for this night.</div></div>
      )}
      <div className="sky-foot">Hasselt, Limburg · Open-Meteo</div>
    </div>
  );
}
