// Pictures of her own life - the last channel she did not have.
//
// She could read photos and never send one, which is the one thing a girlfriend
// on a phone does constantly: the baking that went wrong, the plant, the gym,
// the state of her flat. Nothing here invents an image (there is no image model
// in this project and faking one would look worse than not doing it): she sends
// pictures **you** give her, and they become hers.
//
// Drop images into `data/her-photos/` (jpg/png/webp) and she can send them, with a
// caption she writes in the moment - so the same file never reads like the same
// message twice. Optional `data/her-photos/manifest.json` tells her what each one
// is, which is what lets her match a photo to what she is actually doing:
//
//   {
//     "IMG_2031.jpg": { "desc": "the currywurst she always makes, too much curry powder", "when": ["cooking", "food"] },
//     "flat.jpg":     { "desc": "her flat in the evening, lamp on, plant in the corner", "when": ["flat", "evening"] }
//   }
//
// No folder, no photos, no model calls, no change to behaviour.
import fs from "node:fs";
import path from "node:path";
import { CONFIG, PATHS } from "./config.js";
import { nowBerlin } from "./util.js";

const EXT = /\.(jpe?g|png|webp)$/i;
const DAY_LIMIT = 1; // one photo of her day is a moment; five is a feed
// overridable so the upload shape can be proven against a local server - the same
// seam voice.js has, and for the same reason
const TG_API = process.env.NEGEV_TG_API || `https://api.telegram.org/bot${CONFIG.botToken}`;

function dir() {
  return process.env.NEGEV_PHOTO_DIR || CONFIG.photos?.dir || path.join(PATHS.data, "her-photos");
}

/** What is actually in the folder, with whatever she knows about each file. */
export function catalog() {
  const folder = dir();
  let manifest = {};
  try {
    const raw = fs.readFileSync(path.join(folder, "manifest.json"), "utf8");
    manifest = JSON.parse(raw);
  } catch { /* no manifest: she just does not know what they show */ }
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => EXT.test(f));
  } catch {
    return [];
  }
  return files
    .map((f) => ({
      file: path.join(folder, f),
      name: f,
      desc: String(manifest[f]?.desc || "").replace(/\s+/g, " ").trim(),
      when: Array.isArray(manifest[f]?.when) ? manifest[f].when.map((w) => String(w).toLowerCase()) : [],
    }))
    .filter((p) => {
      try { return fs.statSync(p.file).size > 800; } catch { return false; }
    });
}

export function available() {
  return catalog().length > 0;
}

export function describe() {
  const all = catalog();
  if (!all.length) return `off (drop photos into ${dir()} and she can send them - see photos.js for the manifest)`;
  const known = all.filter((p) => p.desc).length;
  return `${all.length} photo(s) of her life${known ? `, ${known} described` : " (no manifest: she cannot caption them properly)"}`;
}

function sentToday(state, at = Date.now()) {
  const today = nowBerlin(new Date(at)).dateStr;
  return (state?.herPhotos || []).filter((p) => nowBerlin(new Date(p.at || 0)).dateStr === today).length;
}

/** Does the photo she has match what her day is actually doing right now? */
function matches(p, moment = "") {
  if (!p.when.length) return true; // undescribed: usable anywhere
  const m = String(moment || "").toLowerCase();
  return p.when.some((w) => m.includes(w));
}

/**
 * The photo she would send now: one that suits the moment, never one of the last
 * few she already sent, and never more than one a day.
 */
export function pick(state, { moment = "", at = Date.now(), random = Math.random } = {}) {
  if (sentToday(state, at) >= DAY_LIMIT) return null;
  const all = catalog();
  if (!all.length) return null;
  // never the same picture twice in a row - unless it is the only one she has
  const recent = new Set((state?.herPhotos || []).slice(-2).map((p) => p.name));
  const fresh = all.length > 1 ? all.filter((p) => !recent.has(p.name)) : all;
  if (!fresh.length) return null;
  const suited = fresh.filter((p) => matches(p, moment));
  const pool = suited.length ? suited : fresh.filter((p) => !p.when.length);
  if (!pool.length) return null;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * Should this reply come with a photo? Only when he actually asked for one, or
 * when she is telling him about something she happens to have a picture of.
 */
export function wantsForReply(state, { text = "", moment = "", at = Date.now(), random = Math.random } = {}) {
  const asked = /\b(wyd|what are you (doing|up to|to)|where are you|send (me )?(a )?(pic|photo)|pic|photo|show me|proof|whats that|what does it look like)\b/i.test(String(text || ""));
  const telling = /(photo|cooking|cooked|dinner|food|flat|plant|gym|walk|view|look at)/i.test(String(moment || ""));
  if (!asked && !telling) return null;
  if (!asked && random() > 0.35) return null; // she does not illustrate everything
  return pick(state, { moment, at, random });
}

/** A photo as her own, sent from the folder. Returns the telegram result. */
export async function sendPhoto(chatId, photo, caption, { replyTo = null } = {}) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([fs.readFileSync(photo.file)], { type: "image/jpeg" }), photo.name);
    if (caption) form.append("caption", caption);
    if (replyTo) form.append("reply_to_message_id", String(replyTo));
    const res = await fetch(`${TG_API}/sendPhoto`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({ ok: false, description: `bad json (${res.status})` }));
    if (!data.ok) return { ok: false, error: data.description || `http ${res.status}` };
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** One line for /status. */
export function status(state) {
  return `${describe()} | sent today: ${sentToday(state)}/${DAY_LIMIT}`;
}
