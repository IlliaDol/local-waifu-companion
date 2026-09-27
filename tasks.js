// Things she actually does, not just remembers.
//
// Two kinds:
//   explicit  - "remind me to call mom at 6"      -> she texts him at 6
//   implicit  - a pinned fact with a day in it     -> she checks in on the day
//               ("my exam is on monday")             ("how did the exam go?!")
//
// Everything lives in state.json (tasks), survives restarts, and fires through
// her proactive loop so the message is in her voice and timed like her own
// texts - never a clockwork notification. This module is the clock and the
// ledger only; what she says is decided in proactive.js.
import { nowBerlin, rand } from "./util.js";
// memory.js never imports tasks.js, so this is a one-way edge, not a cycle.
import * as mem from "./memory.js";

const DAY_MIN = 24 * 60;

// ---------------------------------------------------------------- time words
const WEEKDAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

const HL = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i; // 6pm / 6:30 pm
const H24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/; // 18:07

/** "6pm" | "18:07" | "6 in the evening" -> minutes of day, or null. */
export function parseClockTime(text, t = nowBerlin()) {
  const s = String(text || "").toLowerCase();
  const m12 = s.match(HL);
  if (m12) {
    let h = Number(m12[1]) % 12;
    if (m12[3].toLowerCase() === "pm") h += 12;
    return h * 60 + Number(m12[2] || 0);
  }
  const m24 = s.match(H24);
  if (m24) return Number(m24[1]) * 60 + Number(m24[2]);
  const bare = s.match(/\bat (\d{1,2})\b/); // "remind me at 7" - the next 7 o'clock
  if (bare) {
    const h = Number(bare[1]);
    if (h >= 0 && h <= 23) {
      // ambiguous without am/pm: both readings are candidates, the next one wins
      const options = h < 12 ? [h * 60, (h + 12) * 60] : [h * 60];
      const future = options.filter((v) => v > t.minutes);
      return (future.length ? future : options).sort((a, b) => a - b)[0];
    }
  }
  const vague = s.match(/\b(in the )?(morning|afternoon|evening|night)\b/);
  if (vague) return { morning: 540, afternoon: 900, evening: 1140, night: 1290 }[vague[2]];
  return null;
}

/** Which date a weekday word points at: next occurrence, counting today. */
export function nextWeekday(word, t = nowBerlin()) {
  const want = WEEKDAYS[String(word || "").toLowerCase()];
  if (want === undefined) return null;
  const diff = (want - t.weekday + 7) % 7;
  return { dayOffset: diff, date: addDays(t.dateStr, diff) };
}

export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Days from today (0) until dateStr; negative if it already passed. */
export function daysUntil(dateStr, t = nowBerlin()) {
  const [y1, m1, d1] = String(t.dateStr).split("-").map(Number);
  const [y2, m2, d2] = String(dateStr).split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// ------------------------------------------------------------- parsing
/**
 * "remind me to call mom at 6" -> task, or null when he is not asking.
 * The stored `what` keeps his words; she is a girlfriend, not a TODO app.
 */
export function parseTask(text, t = nowBerlin()) {
  const body = String(text || "").replace(/^\/(remind|task)\b\s*/i, "").trim();
  const m = body.match(/^(?:can you\s+|please\s+)?remind me\s+(?:to\s+|about\s+|that\s+)?([\s\S]+)$/i);
  if (!m) return null;
  let what = m[1].trim().replace(/[.\s]+$/, "");
  if (!what) return null;

  const task = { what, whenMin: null, whenLabel: "", date: t.dateStr, byWhom: "him" };
  const time = parseClockTime(what, t);

  // day words: today / tomorrow / on monday / next monday
  const dayM = what.match(/\b(today|tonight|tomorrow|on (sun|mon|tues|tue|wed|thurs|thur|fri|sat)\w*|next (sun|mon|tues|tue|wed|thurs|thur|fri|sat)\w*)\b/i);
  let offset = null;
  let label = "";
  if (dayM) {
    const w = dayM[1].toLowerCase();
    if (w === "today" || w === "tonight") {
      offset = 0;
      label = w === "tonight" ? "tonight" : "today";
    } else if (w === "tomorrow") {
      offset = 1;
      label = "tomorrow";
    } else {
      const wd = nextWeekday(w.replace(/^on |^next /, ""), t);
      offset = wd ? wd.dayOffset : null;
      if (wd) label = dayM[1].toLowerCase();
      if (offset === 0) label = "today";
      if (offset === 1) label = "tomorrow";
    }
  }

  if (time !== null || offset !== null) {
    if (typeof time === "number" && Number.isFinite(time)) {
      task.whenMin = time;
      // "call mom" alone -> today; "at 1" while it is 23:00 -> she assumes tomorrow
      task.date = addDays(t.dateStr, offset ?? (time <= t.minutes ? 1 : 0));
      task.whenLabel = label || (offset ? label : "today");
      if (!offset && time <= t.minutes && task.date !== t.dateStr) task.whenLabel = "tomorrow";
    } else if (time && time.morning) {
      task.whenMin = time.morning;
      task.date = addDays(t.dateStr, offset ?? (time.morning <= t.minutes ? 1 : 0));
      task.whenLabel = label || "later";
    } else if (offset !== null) {
      // a day but no clock time: she pings him in the morning of that day
      task.whenMin = 10 * 60;
      task.date = addDays(t.dateStr, offset);
      task.whenLabel = label;
    }
  } else if (time !== null && typeof time === "object") {
    // "in the morning" only
    task.whenMin = time.morning;
    task.date = addDays(t.dateStr, time.morning <= t.minutes ? 1 : 0);
    task.whenLabel = "tomorrow";
  } else {
    // no time at all: "remind me to call mom" -> she pings this evening
    task.whenMin = 19 * 60 + Math.floor(rand(0, 90));
    task.whenLabel = "this evening";
  }

  task.what = what
    .replace(HL, "")
    .replace(H24, "")
    .replace(/\b(at|by|before)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, "")
    .replace(/\b(today|tonight|tomorrow)\b/ig, "")
    .replace(/\b(on|next|at|by|before)\s+(sun|mon|tues|tue|wed|thurs|thur|fri|sat)\w*/ig, "")
    .replace(/\b(in the )?(morning|afternoon|evening|night)\b/ig, "")
    .replace(/\s+(at|by|before|on)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
  // "remind me at 7" with nothing to actually remind him of - she asks, not guesses
  if (!task.what || task.what.length < 2) return null;
  return task;
}

/**
 * Does a pinned fact carry a day? "my exam is on monday" -> a date to check in
 * on. Returns the task-shaped entry or null. Numbers like "17" and "2pm" and
 * month names are deliberately not treated as days.
 */
export function parseFactDay(fact, t = nowBerlin()) {
  const s = String(fact || "").toLowerCase();
  const m = s.match(/\b(?:on|this|next|coming)\s+(sun|mon|tues|tue|wed|thurs|thur|fri|sat)(?:day|nesday|rsday|urday)?\b/);
  if (!m) return null;
  const wd = nextWeekday(m[1], t);
  if (!wd) return null;
  return { what: String(fact), date: wd.date, whenMin: 10 * 60 + Math.floor(rand(0, 120)), kind: "fact-day", byWhom: "her" };
}

// ------------------------------------------------------------ persistence
export function addTask(task) {
  const s = memState();
  if (!s.tasks) s.tasks = [];
  if (s.tasks.some((x) => x.what === task.what && x.date === task.date && x.whenMin === task.whenMin)) return false;
  s.tasks.push({ ...task, created: Date.now() });
  while (s.tasks.length > 20) s.tasks.shift();
  return true;
}

/** One nudge per task; the `fired` flag persists, so a restart cannot re-fire it. */
export function takeDue(dateStr, minutes) {
  const s = memState();
  if (!s.tasks) return [];
  // fact-day check-ins are HERS - they fire in takeFactDays with their own wording
  const due = s.tasks.filter((x) => x.kind !== "fact-day" && x.date === dateStr && !x.fired && x.whenMin <= minutes);
  for (const x of due) x.fired = true;
  if (due.length) s.tasksDirty = true;
  return due;
}

/** Morning-of nudges for pinned facts ("my exam is on monday" -> check in at ~10am). */
export function takeFactDays(dateStr) {
  const s = memState();
  const due = (s.tasks || []).filter((x) => x.kind === "fact-day" && x.date === dateStr && !x.fired);
  for (const x of due) x.fired = true;
  if (due.length) s.tasksDirty = true;
  return due;
}

/** How many things she is holding that have not happened yet. */
export function pendingCount() {
  return (memState().tasks || []).filter((x) => !x.fired && x.kind !== "fact-day").length;
}

export function listTasks() {
  return (memState().tasks || []).filter((x) => !x.fired);
}

// ----------------------------------------------------------- access to state
// tests inject a stand-in ledger so the real state.json is never touched
let fakeState = null;
export function _useFakeState(s) {
  fakeState = s;
}
function memState() {
  return fakeState || mem.state;
}

/** Wash the ledger: fired tasks older than a week are dropped. */
export function sweep() {
  const s = memState();
  if (!s.tasks?.length) return false;
  const cutoff = addDays(nowBerlin().dateStr, -7);
  const keep = s.tasks.filter((x) => x.date >= cutoff);
  if (keep.length !== s.tasks.length) {
    s.tasks = keep;
    return true;
  }
  return false;
}
