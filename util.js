// Small shared helpers. No dependencies.
import { CONFIG } from "./config.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const fmtCache = new Map();
function fmt(options) {
  const key = JSON.stringify(options);
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat("en-GB", { timeZone: CONFIG.timezone, ...options }));
  }
  return fmtCache.get(key);
}

/** Current wall clock in Dortmund. */
const WEEKDAY_NO = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

export function nowBerlin(date = new Date()) {
  const p = {};
  for (const part of fmt({ hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" }).formatToParts(date)) {
    p[part.type] = part.value;
  }
  const hour = parseInt(p.hour, 10) % 24;
  const minute = parseInt(p.minute, 10);
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    // numeric for arithmetic (sleep.js weekend check, tasks.js day math);
    // weekdayName keeps the human word for her prompts
    weekday: WEEKDAY_NO[String(p.weekday).toLowerCase()] ?? 0,
    weekdayName: p.weekday,
    hour,
    minute,
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/** Timezone offset (ms to add to UTC to get local time) at a given instant. */
function offsetMs(date) {
  const p = {};
  for (const part of fmt({ hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date)) {
    p[part.type] = part.value;
  }
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** "2026-09-16" + "14:30" in Dortmund -> real Date (handles DST). */
export function berlinToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return new Date(NaN);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i += 1) guess = target - offsetMs(new Date(guess));
  return new Date(guess);
}

export function hhmm(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Emojis, variation selectors and ZWJ: she is a plain-text girl.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2600}-\u{27BF}]/gu;

export function stripEmojis(text = "") {
  return String(text)
    .replace(EMOJI_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Split a model reply into 1-3 natural chat bubbles, with 4 as the hard ceiling. */
export function splitBubbles(text, maxBubbles = 3) {
  let parts = String(text || "")
    .split(/\n\s*\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (parts.length === 1 && parts[0].length > 240) {
    const sentences = parts[0].split(/(?<=[.!?])\s+/);
    const out = [];
    let cur = "";
    for (const s of sentences) {
      if (cur && cur.length + s.length + 1 > 200) { out.push(cur.trim()); cur = s; }
      else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur.trim()) out.push(cur.trim());
    parts = out;
  }

  if (parts.length > maxBubbles) {
    parts = [...parts.slice(0, maxBubbles - 1), parts.slice(maxBubbles - 1).join(" ")];
  }
  return parts.filter(Boolean).slice(0, maxBubbles);
}

export function truncate(text, max) {
  const s = String(text || "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// A second destination for log lines (the bot writes data/negev.log itself, so a
// hidden launch needs no shell redirection and two processes can never fight over
// a held-open file handle).
let logSink = null;
export function setLogSink(fn) {
  logSink = typeof fn === "function" ? fn : null;
}

function flatten(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ");
}

export function log(...args) {
  const line = `${new Date().toISOString()} ${flatten(args)}`;
  console.log(line);
  try { logSink?.(line); } catch { /* never let logging break her */ }
}

export function logErr(...args) {
  const line = `${new Date().toISOString()} ${flatten(args)}`;
  console.error(line);
  try { logSink?.(line); } catch { /* never let logging break her */ }
}
