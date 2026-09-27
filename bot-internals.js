// The bridge between the running bot and the control panel.
//
// bot.js owns the reaction queue and the timing organs; panel.js serves the
// web UI. A direct import would be circular (bot imports panel to start it,
// panel needs bot's internals to show anything), so the live functions are
// registered here: bot.js calls register() at boot with its own closures, and
// panel.js imports this module to reach them. Nothing here can start a second
// bot or touch Telegram directly.
import { CONFIG } from "./config.js";
import * as mem from "./memory.js";
import * as mood from "./mood.js";
import * as sleep from "./sleep.js";
import * as settings from "./settings.js";
import * as proactive from "./proactive.js";
import * as schedule from "./proactive.js";
import { nowBerlin, log } from "./util.js";

const live = {
  herNight: null,
  herMood: null,
  handlePanelText: null,
  rerollSchedule: null,
  activeConversation: null,
};

/**
 * Called once from bot.js main(). Every function is optional; the panel
 * degrades gracefully for the ones a preview/session run did not register.
 */
export function register(fns = {}) {
  for (const key of Object.keys(live)) {
    if (typeof fns[key] === "function") live[key] = fns[key];
  }
}

export function herNight(extra = {}) {
  if (live.herNight) return live.herNight(extra);
  return sleep.ensureWindow(mem.state, { t: nowBerlin(), mood: mood.currentMood(mem.state), ...extra });
}

export function herMood(ctx = {}) {
  if (live.herMood) return live.herMood(ctx);
  return mood.ensureMood(mem.state, { ...ctx, sinceLastUserMs: Infinity });
}

export function activeConversation() {
  if (live.activeConversation) return live.activeConversation();
  return Number(mem.state.activeChatUntil || 0) > Date.now();
}

/**
 * Words typed into the panel join the real queue exactly like a Telegram
 * message from him - same batching, same timing dice, same everything - so
 * what she answers and how she times it is her ordinary behaviour, not a
 * special panel mode. Returns false when there is no live bot to take them.
 */
export function handlePanelText(text) {
  if (live.handlePanelText) return live.handlePanelText(String(text || ""));
  return false;
}

/** Re-roll today's spontaneous-text schedule (panel button). */
export function rerollSchedule() {
  try {
    const st = mem.state;
    const t = nowBerlin();
    const sched = herNight();
    const slots = proactive.makeSchedule(sched, t);
    st.schedule = slots;
    mem.save();
    log(`[panel] schedule re-rolled: ${slots.length} slot(s) today`);
    return true;
  } catch (err) {
    log("[panel] schedule re-roll failed:", err?.message || String(err));
    return false;
  }
}
