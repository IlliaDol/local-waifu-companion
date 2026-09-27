// The weather in Dortmund, because her simulated life should match the one
// outside his window too. When it rains, "got soaked walking to the gym" is a
// line he can verify - that is what sells the whole person.
//
// open-meteo.com: free, no API key, no signup. Fetched a few times a day at
// most and cached in state.json; every failure degrades silently to "no weather".
import { CONFIG } from "./config.js";
import { state, saveSoon } from "./memory.js";
import { log } from "./util.js";

const URL = "https://api.open-meteo.com/v1/forecast?latitude=51.5136&longitude=7.4653&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe%2FBerlin&forecast_days=1";

const CODES = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow",
  80: "rain showers", 81: "heavy showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "a thunderstorm", 96: "a thunderstorm with hail", 99: "a heavy thunderstorm with hail",
};

// 2h minimum between live fetches; a cached reading is fine for everything else.
const REFRESH_MS = 2 * 3600000;

function describe(code) {
  return CODES[code] || "weather";
}

export function current() {
  const w = state.weather;
  if (!w || Date.now() - w.at > 6 * 3600000) return null; // older than a few hours: useless
  return w;
}

/** Fresh-but-cached reading, refreshed from the network at most every 2h. */
export async function ensure() {
  const w = state.weather;
  if (w && Date.now() - w.at < REFRESH_MS) return w;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return w || null;
    const data = await res.json();
    const c = data.current || {};
    const d = data.daily || {};
    const fresh = {
      at: Date.now(),
      temp: Math.round(Number(c.temperature_2m ?? 0)),
      code: Number(c.weather_code ?? 0),
      wind: Math.round(Number(c.wind_speed_10m ?? 0)),
      rain: Number(c.precipitation ?? 0),
      max: Math.round(Number(d.temperature_2m_max?.[0] ?? c.temperature_2m ?? 0)),
      min: Math.round(Number(d.temperature_2m_min?.[0] ?? c.temperature_2m ?? 0)),
      pop: Number(d.precipitation_probability_max?.[0] ?? 0),
      desc: describe(Number(c.weather_code ?? 0)),
    };
    // keep the previous reading: the sky TURNING is something she texts about
    if (w && w.temp != null && Date.now() - w.at < 14 * 3600000) {
      fresh.prev = { temp: w.temp, rain: w.rain, desc: w.desc };
    }
    state.weather = fresh;
    saveSoon();
    return fresh;
  } catch (err) {
    log("[weather] fetch failed:", err?.message || String(err));
    return w || null;
  }
}

/** Is any kind of wet coming down or imminent? */
export function isWet(w = current()) {
  return Boolean(w) && (w.rain > 0.2 || w.pop >= 50 || /rain|drizzle|showers|thunder|snow/i.test(w.desc));
}

const wet = (x) => x.rain > 0.2 || /rain|drizzle|showers|thunder|snow/i.test(x.desc || "");

/**
 * How the sky turned since the last reading, as a phrase she can mention -
 * rain starting or stopping, a real temperature swing. Empty when nothing
 * worth mentioning changed. CONSUMES the change: it can only be mentioned
 * once per real turn of the sky, never on repeat for hours.
 */
export function changed(w = current()) {
  if (!w?.prev) return "";
  const p = w.prev;
  let out = "";
  if (!wet(p) && wet(w)) out = `the rain just started in Dortmund (${w.desc}, ${w.temp}C)`;
  else if (wet(p) && !wet(w)) out = `it finally stopped raining and cleared up (${w.desc}, ${w.temp}C)`;
  else if (p.temp - w.temp >= 5) out = `it suddenly dropped ${p.temp - w.temp} degrees since earlier (now ${w.temp}C)`;
  else if (w.temp - p.temp >= 5) out = `it warmed up out of nowhere, ${w.temp}C now`;
  if (out) {
    delete w.prev; // mentioned once is plenty
    saveSoon();
  }
  return out;
}

/**
 * A diary-shaped weather event, or null when the weather is too boring to
 * mention. These slot into her day plan, so her texts about the day line up
 * with what the sky is actually doing.
 */
export function diaryEvent(w = current()) {
  if (!w) return null;
  if (isWet(w)) {
    if (w.temp <= 2) return `sleet everywhere, freezing on the way anywhere`;
    return w.pop >= 70 ? "rain all day, umbrella died again" : "grey and wet, walk cut short";
  }
  if (w.temp >= 28) return "too hot to move, melting in the flat";
  if (w.temp >= 23 && w.code <= 2) return "finally warm, sitting outside";
  if (w.wind >= 45) return "wind howling outside all day";
  return null;
}

/**
 * One line for her internal notes when the weather is worth a mention. Deliberately
 * background-only: it colours what she already has to say, it never hands her a
 * weather topic. Rain start/stop/swing can surface ONCE per turn of the sky
 * (changed() consumes it), plain rain gets a standing clause.
 */
export function noteLine(w = current()) {
  if (!w) return "";
  const turn = changed(w);
  if (turn) return `${turn} - one clause at most, then drop it`;
  if (isWet(w)) return `it is ${w.desc} and ${w.temp}C in Dortmund - if being outside comes up, it happens in this`;
  if (w.temp >= 27) return `it is hot (${w.temp}C) in Dortmund - if the day comes up, the heat is in it`;
  if (w.temp <= 0) return `it is freezing (${w.temp}C) in Dortmund - if the day comes up, the cold is in it`;
  return "";
}
