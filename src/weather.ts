/** What a night's weather looks like to the app. The numbers come from
 *  data/weather.json, sealed into the vault (Open-Meteo history for Hasselt, written by `npm run
 *  weather`); this file only types them and turns WMO codes into words. */

export interface DayWeather {
  code: number;          // WMO code for the whole day
  tmax: number;
  tmin: number;
  precip: number;        // mm over the day
  wind: number;          // km/h, daily maximum
  eveningTemp: number | null;   // 21:00 local, deg C
  eveningCode: number | null;   // 21:00 local, WMO
}

export type WeatherMap = Record<string, DayWeather>;

export type Condition =
  | "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "thunder";

export function conditionOf(code: number): Condition {
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunder";
  return "cloudy";
}

export const CONDITION_LABEL: Record<Condition, string> = {
  clear: "Clear", partly: "Partly cloudy", cloudy: "Overcast", fog: "Fog",
  drizzle: "Drizzle", rain: "Rain", snow: "Snow", thunder: "Thunderstorm",
};

/** The evening is the night; fall back to the day when the hour is missing. */
export function eveningOf(w: DayWeather): { code: number; temp: number } {
  return {
    code: w.eveningCode ?? w.code,
    temp: w.eveningTemp ?? Math.round((w.tmax + w.tmin) / 2),
  };
}
