// She sleeps for real: every night from 02:00 until 08:00 Dortmund time.
// There are no random bedtimes, weekend exceptions, or half-awake replies in
// that window. Six hours is her normal full night and does not create a tired
// mood the next morning.
import { nowBerlin, hhmm } from "./util.js";

const DAY_MIN = 24 * 60;

const wrap = (mins) => ((mins % DAY_MIN) + DAY_MIN) % DAY_MIN;

/** Ensure the fixed 02:00-08:00 window is persisted for the current date. */
export function ensureWindow(state, { t = nowBerlin(), mood = null, random = Math.random } = {}) {
  // Preview only, like NEGEV_FORCE_MOOD: pin her night so her 3am behaviour (or the
  // last line before bed) can be watched without waiting up until midnight.
  const forced = process.env.NEGEV_FORCE_SLEEP;
  if (forced === "asleep" || forced === "bedtime" || forced === "justup") {
    const bedMin = wrap(forced === "asleep" ? t.minutes - 120 : forced === "justup" ? t.minutes - 8 * 60 : t.minutes + 2);
    const wakeMin = wrap(forced === "asleep" ? t.minutes + 5 : forced === "justup" ? t.minutes - 12 : t.minutes + 9 * 60);
    state.sleep = { date: t.dateStr, bedMin, wakeMin, hours: 7, why: `forced for a test (${forced})` };
    return state.sleep;
  }
  const fixed = state.sleep?.date === t.dateStr
    && state.sleep.bedMin === 2 * 60
    && state.sleep.wakeMin === 8 * 60
    && Number(state.sleep.hours) === 6;
  if (fixed) return state.sleep;

  state.sleep = {
    ...(state.sleep || {}),
    date: t.dateStr,
    bedMin: 2 * 60,
    wakeMin: 8 * 60,
    hours: 6,
    why: "your fixed full-night schedule",
    // callers persist a freshly fixed window straight away, so a restart cannot
    // reintroduce the old random bedtime.
    fresh: true,
    fixed: true,
  };
  return state.sleep;
}

/**
 * Asleep at this moment? Handles both shapes of night: one that starts before
 * midnight (up at 08:00 means asleep from 23:00) and one that starts after it
 * (asleep from 01:40 until she surfaces at 10:00).
 */
export function isAsleepAt(sched, t = nowBerlin()) {
  if (!sched) return false;
  const m = t.minutes;
  return sched.bedMin > sched.wakeMin
    ? m >= sched.bedMin || m < sched.wakeMin
    : m >= sched.bedMin && m < sched.wakeMin;
}

/** Milliseconds until she is properly up. */
export function untilWakeMs(sched, t = nowBerlin()) {
  const mins = t.minutes < sched.wakeMin ? sched.wakeMin - t.minutes : DAY_MIN - t.minutes + sched.wakeMin;
  return mins * 60000;
}

/** Minutes since she got up, or null when she is not freshly awake. */
export function minutesSinceWaking(sched, t = nowBerlin(), within = 75) {
  if (!sched || t.minutes < sched.wakeMin) return null;
  const m = t.minutes - sched.wakeMin;
  return m <= within ? m : null;
}

/** Minutes until bedtime (0 = right now, and it counts up again after midnight). */
export function minutesUntilBed(sched, t = nowBerlin()) {
  return t.minutes < sched.bedMin ? sched.bedMin - t.minutes : DAY_MIN - t.minutes + sched.bedMin;
}

/** Only less than six hours is short; exactly six hours is fully rested for her. */
export function sleptBadly(sched) {
  return Boolean(sched) && Number(sched.hours) < 6;
}

export function describe(sched) {
  if (!sched) return "no schedule yet";
  return `bed ${hhmm(sched.bedMin)}, up ${hhmm(sched.wakeMin)} (${sched.hours}h)${sched.why ? ` - ${sched.why}` : ""}`;
}
