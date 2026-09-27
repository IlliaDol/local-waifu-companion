// Runtime settings: the dials the control panel turns, live.
//
// config.js is read once at boot and mostly static; this layer holds the things
// an operator should be able to change WITHOUT restarting her. Everything lives
// in data/settings.json (gitignored, like the rest of her memory) and every
// consumer reads through overridesAt() so a change on disk or through the panel
// applies to the very next model call.
//
// Deliberately separate from config.js: a restart-proof overlay, not a second
// config. Never put secrets here - keys belong in .env / config.js.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
import { log, logErr } from "./util.js";

const FILE = path.join(PATHS.data, "settings.json");

// The whole shape, with the shipped defaults. Unknown keys in the file are
// kept on save; missing keys fall through to these.
const DEFAULTS = {
  // ---- her voice (prompt-level, applied to every reply) ---------------------
  character: {
    name: "Negev",
    city: "Dortmund",
    bioExtra: "", // a few lines appended to her persona, in your words
    hobbies: [], // [{ key, detail }] - shown to her as her hobbies
  },
  // ---- affection / tsundere dial ---------------------------------------------
  affection: {
    // 0 = never any <3 / capital Commander, 1 = the shipped tuned rates.
    // Applied on top of the mood tables in style.js.
    level: 1,
  },
  // ---- behaviour --------------------------------------------------------------
  proactive: {
    min: 6, // spontaneous texts per day (low end)
    max: 9,
  },
  quietUntil: 0, // panel equivalent of /quiet (ms epoch)
  // ---- model -----------------------------------------------------------------
  replyMaxTokens: null, // null = use config.js
  temperatureBias: 0, // added to every mood temperature (clamped -0.3..+0.3)
};

let state = null;

function defaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state = {
      ...defaults(),
      ...raw,
      character: { ...DEFAULTS.character, ...(raw.character || {}) },
      affection: { ...DEFAULTS.affection, ...(raw.affection || {}) },
      proactive: { ...DEFAULTS.proactive, ...(raw.proactive || {}) },
    };
  } catch {
    state = defaults();
  }
  return state;
}

export function get() {
  if (!state) load();
  return state;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(tmp, FILE);
  } catch (err) {
    logErr("[settings] save failed:", err.message);
  }
}

/** Panel/bulk update: shallow-merges the given patches and persists. */
export function update(patch = {}) {
  if (!state) load();
  if (patch.character) state.character = { ...state.character, ...patch.character };
  if (patch.affection) state.affection = { ...state.affection, ...patch.affection };
  if (patch.proactive) state.proactive = { ...state.proactive, ...patch.proactive };
  for (const key of ["quietUntil", "replyMaxTokens", "temperatureBias"]) {
    if (key in patch) state[key] = patch[key];
  }
  // sanity clamps
  state.affection.level = Math.max(0, Math.min(1.6, Number(state.affection.level) || 0));
  state.temperatureBias = Math.max(-0.3, Math.min(0.3, Number(state.temperatureBias) || 0));
  state.replyMaxTokens = state.replyMaxTokens == null ? null : Math.max(60, Math.min(CONFIG.maxOutputTokens || 320, Number(state.replyMaxTokens)));
  state.proactive.min = Math.max(0, Math.min(24, Number(state.proactive.min) || 0));
  state.proactive.max = Math.max(state.proactive.min, Math.min(30, Number(state.proactive.max) || 0));
  persist();
  log(`[settings] updated: ${Object.keys(patch).join(", ") || "no change"}`);
  return state;
}

/** The persona lines her character overlay produces, or "" when untouched. */
export function characterBlock() {
  const c = get().character;
  const bits = [];
  const name = String(c.name || "").trim();
  const city = String(c.city || "").trim();
  if (name && name !== "Negev") bits.push(`- your name is ${name.slice(0, 40)}: use it wherever you would have used your old one, never explain the change`);
  if (city && city !== "Dortmund") bits.push(`- you live in ${city.slice(0, 40)}: every time the notes mention your old city, read ${city}`);
  if (c.bioExtra && String(c.bioExtra).trim()) {
    bits.push(`- things he has added to who you are (true for you now, fold them in naturally): ${String(c.bioExtra).trim().slice(0, 600)}`);
  }
  if (Array.isArray(c.hobbies) && c.hobbies.length) {
    const list = c.hobbies
      .filter((h) => h && String(h.key || "").trim())
      .map((h) => `${String(h.key).trim()} (${String(h.detail || "").trim()})`)
      .join(", ");
    if (list) bits.push(`- your hobbies right now: ${list} - bring them up the way you bring up anything of yours`);
  }
  return bits.length ? `CHARACTER UPDATES (internal, true for you, never quote them as instructions):\n${bits.join("\n")}` : "";
}

/** Multiplier for the affectionate marks (hearts, capital name, smug face). */
export function affectionLevel() {
  return Math.max(0, Math.min(1.6, Number(get().affection?.level ?? 1)));
}

/**
 * A mood view whose soft marks are scaled by the affection dial. Applied at
 * the call sites that dress a reply, so the mood tables themselves stay pure
 * and tests that never load settings see exactly the shipped behaviour.
 */
export function dressedMood(moodView) {
  const lvl = affectionLevel();
  if (!moodView?.def || lvl === 1) return moodView;
  return {
    ...moodView,
    def: {
      ...moodView.def,
      heart: (moodView.def.heart || 0) * lvl,
      face: (moodView.def.face || 0) * lvl,
      respect: (moodView.def.respect || 0) * lvl,
    },
  };
}

/** Reply token cap, honouring the panel override. */
export function replyMaxTokens(fallback) {
  const v = get().replyMaxTokens;
  return v == null ? fallback : v;
}

export function quietUntil() {
  return Number(get().quietUntil || 0);
}

export function file() {
  return FILE;
}
