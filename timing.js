// How long she takes to answer - and whether she answers at all.
//
// A real person with a phone does not reply in 300 ms. Sometimes the phone is in
// her hand and she fires back instantly, sometimes she reads it walking to the
// tram and answers an hour later, sometimes it just sits there and she brings it
// up herself when she feels like it. And she sleeps: while she is asleep,
// everything waits for the morning - no exceptions, no half-awake typing.
//
// This module only decides WHEN she answers and in which mood. bot.js owns the
// timer; keeping the decision pure (no timers, no state) makes it testable.
import { CONFIG } from "./config.js";
import { nowBerlin } from "./util.js";
import * as sleep from "./sleep.js";

// Tuning knobs. They live here (not in config.js) so the timing layer is one file
// you can read top to bottom; if you ever add a `human: { ... }` block to CONFIG,
// any key you set there wins.
export const TIMING_DEFAULTS = {
  enabled: true,
  instantChance: 0.22, // phone already in hand
  shortChance: 0.36, // 10 s - 2.5 min
  longChance: 0.2, // 2 - 20 min, got distracted
  laterChance: 0.14, // 20 - 75 min, left you on read then got to it
  ignoreChance: 0, // every waking-hour message eventually gets a reply
  activeExchangeMin: 3, // "we are actively texting right now" window
  maxWaitMin: 25, // no waking-hour wait is ever longer than this
  wakeJitterMin: 25, // she wakes up somewhere after 08:00
  // quoting: she can hang her answer on any specific message of his
  // the moment before a message goes out: she starts typing, stops, and then
  // actually sends it - the "hmm, no" everyone does and no bot has
  hesitateChance: 0.12,
  activeConversationMin: 15,
  forceAwakeMin: 10,
  // mid-conversation there is no "she vanished": a reply that is part of an
  // active back-and-forth never waits longer than this, whatever the dice said
  activeMaxWaitSec: 30,
};

/** Moods in which she thinks twice before sending: never while she is buzzing. */
const HESITANT_MOODS = new Set(["sulky", "distant", "soft", "tired"]);

const H = { ...TIMING_DEFAULTS, ...(CONFIG.human || {}) };

/**
 * Asleep or not. The production schedule is persisted by sleep.js; the fallback
 * keeps the same fixed 02:00-08:00 window for isolated timing calls and tests.
 */
export function isAsleep(t = nowBerlin(), sched = null) {
  return sched ? sleep.isAsleepAt(sched, t) : t.minutes >= 2 * 60 && t.minutes < 8 * 60;
}

/** Minutes from now until she is properly awake in the morning. */
export function minutesUntilMorning(t = nowBerlin(), sched = null) {
  if (sched) return sleep.untilWakeMs(sched, t) / 60000;
  const wake = (CONFIG.schedule.wakeHour || 8) * 60;
  return t.minutes < wake ? wake - t.minutes : 24 * 60 - t.minutes + wake;
}

function irand(a, b, random = Math.random) {
  if (b <= a) return a;
  return a + Math.floor(random() * (b - a + 1));
}

function weighted(weights, random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return null;
  let roll = random() * total;
  for (const [mode, w] of entries) {
    roll -= w;
    if (roll <= 0) return mode;
  }
  return entries[entries.length - 1][0];
}

// awake and not mid-conversation
const BASE = () => ({
  instant: H.instantChance,
  short: H.shortChance,
  long: H.longChance,
  later: H.laterChance,
  ignore: H.ignoreChance,
});
// asleep is a hard stop, not a probability: her bedtime is her bedtime. When she
// is asleep everything waits for the morning - no "still staring at the screen"
// at 3am, no half-awake reply. The half-awake voice exists only in the first
// minutes AFTER she surfaces (the wake note in bot.js), never during the night.

/**
 * Decide how she reacts to what just arrived. While she is asleep there is no
 * decision: wakePlan() answers for her.
 *
 * modes:
 *   instant - phone already in hand
 *   short   - normal human gap (10 s - 2.5 min)
 *   long    - saw it, got distracted (2 - 20 min)
 *   later   - read it, left him on read, answers much later (20 - 75 min)
 *   ignore  - read, no answer at all for now; she may bring it up herself later
 *   asleep  - she was in bed; answers when she wakes up (the only night mode)
 *   busy    - she is out doing something, just a quick canned line
 */
export function planReaction({ t = nowBerlin(), burstCount = 1, sinceLastBotMs = Infinity, mood = null, sched = null, hisActivity = 0, activeChat = false, awakeUntil = 0, random = Math.random } = {}) {
  // /force explicitly overrides sleep. An ordinary active exchange keeps her
  // present during waking hours, but 02:00-08:00 remains a hard sleep window.
  const forcedAwake = Number(awakeUntil) > Date.now();
  const sleeping = isAsleep(t, sched);
  if (forcedAwake || (activeChat && !sleeping)) {
    const mode = weighted({ instant: H.instantChance, short: H.shortChance, long: H.longChance }, random) || "short";
    const plan = buildPlan(mode, t, random, sched);
    if (plan.delayMs !== null) plan.delayMs = Math.min(plan.delayMs, H.activeMaxWaitSec * 1000);
    plan.note = forcedAwake
      ? "you woke yourself up on purpose and are staying with him for a while"
      : "you two are actively talking, so you stay present rather than disappearing";
    return { ...plan, burstCount, mood: mood?.key || null };
  }
  if (sleeping) return { ...wakePlan({ t, sched, random }), burstCount, mood: mood?.key || null };
  if (!H.enabled) return { ...buildPlan("instant", t, random, sched), burstCount };
  const weights = BASE(); // she is awake here - asleep never reaches the dice

  // her mood bends the dice: a tired or distant girl is slower and goes quiet
  // more often, a clingy one practically jumps at the phone
  const bias = mood ? moodBias(mood) : null;
  if (bias) {
    weights.ignore = Math.max(0, (weights.ignore ?? 0) + bias.ignoreAdd);
    weights.later = Math.max(0, (weights.later ?? 0) + bias.laterAdd);
    if (weights.instant) weights.instant *= bias.eager;
  }

  // he is awake and answering (signal.hisWindowScore): a girl who knows he is on
  // his phone right now is a little quicker to reply. It is a nudge, never a rule.
  if (hisActivity > 0) {
    weights.instant *= 1 + 0.35 * hisActivity;
    weights.short *= 1 + 0.15 * hisActivity;
    weights.ignore = Math.max(0, weights.ignore * (1 - 0.4 * hisActivity));
  }
  const activeNow = sinceLastBotMs < H.activeExchangeMin * 60000;
  if (activeNow) {
    // they are actively going back and forth right now: humans answer fast
    weights.instant += 0.3;
    weights.short += 0.1;
    weights.long = Math.max(0, weights.long - 0.14);
    weights.later = Math.max(0, weights.later - 0.10);
    weights.ignore = 0;
  }
  if (burstCount >= 3) {
    // he dumped a wall of messages: she reads it all and answers once
    weights.long += 0.10;
    weights.later += 0.06;
    weights.instant = Math.max(0, weights.instant - 0.14);
  } else if (burstCount === 2) {
    weights.instant = Math.max(0, weights.instant - 0.05);
  }

  const mode = weighted(weights, random) || "short";
  const plan = mode === "asleep" ? wakePlan({ t, sched, random }) : buildPlan(mode, t, random, sched);
  plan.burstCount = burstCount;
  plan.mood = mood?.key || null;

  // slower or quicker than usual, but never beyond the waking-hour limits and
  // never below a realistic minimum
  if (bias && plan.delayMs !== null && plan.mode !== "asleep") {
    plan.delayMs = Math.round(clampTo(plan.delayMs * bias.delay, 500, H.maxWaitMin * 60000));
  }
  // an active exchange is capped AFTER the mood multiplier, so even a tired
  // mood cannot turn "we are texting right now" into a three-minute absence
  if (activeNow && plan.delayMs !== null && plan.mode !== "asleep") {
    plan.delayMs = Math.min(plan.delayMs, H.activeMaxWaitSec * 1000);
  }
  return plan;
}

function clampTo(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * She was asleep when this arrived, so the plan is always the same shape: wake up
 * first, then answer. The jitter is her not being a morning person, not a dice
 * roll on whether sleep counts. Kept pure and exported so bot.js can rebuild the
 * same plan after a restart without re-rolling a different girl.
 */
export function wakePlan({ t = nowBerlin(), sched = null, random = Math.random } = {}) {
  return {
    mode: "asleep",
    delayMs: (minutesUntilMorning(t, sched) + irand(0, H.wakeJitterMin, random)) * 60000,
    note: "you were asleep when he wrote and have only just picked your phone up",
  };
}

/** Kept separate so timing.js does not have to import mood.js. */
function moodBias(mood) {
  const d = mood.def || {};
  return { ignoreAdd: d.ignoreAdd || 0, laterAdd: d.laterAdd || 0, eager: d.eager ?? 1, delay: d.delay ?? 1 };
}

function buildPlan(mode, t, random, sched = null) {
  const cap = (ms) => Math.min(ms, H.maxWaitMin * 60000);
  switch (mode) {
    case "instant":
      return { mode, delayMs: irand(800, 5000, random), note: "your phone was in your hand, this is you answering straight away" };
    case "short":
      return { mode, delayMs: irand(12000, 150000, random), note: "you got to your phone after a minute or two, like a normal person" };
    case "long":
      return { mode, delayMs: cap(irand(2 * 60000, 19 * 60000, random)), note: "you saw this a while ago and got pulled into something else; you are answering now without making a drama out of the delay" };
    case "later":
      return { mode, delayMs: cap(irand(20 * 60000, 75 * 60000, random)), note: "you left him on read for a bit and are only getting to this now; one throwaway line about being busy is enough, no grovelling" };
    case "asleep": {
      const plan = wakePlan({ t, sched, random });
      return { mode, ...plan, note: plan.note };
    }
    case "ignore":
      return { mode, delayMs: null, note: "read, no answer" };
    case "busy":
      return { mode, delayMs: irand(3000, 15000, random), note: "you are in the middle of something and can only fire back one quick line" };
    default:
      return { mode: "short", delayMs: irand(12000, 90000, random), note: "" };
  }
}

/**
 * The beat before a message goes out: she starts typing, stops, and sends it a
 * little later anyway. Telegram shows the typing action for a few seconds and
 * then it is gone, which is exactly what a person does when they are deciding how
 * to say something. Only in the moods where that is true - a chaotic girl does not
 * hesitate.
 */
export function wantsHesitation(mood, random = Math.random) {
  if (!mood?.key || !HESITANT_MOODS.has(mood.key)) return null;
  if (random() > H.hesitateChance) return null;
  const typedMs = irand(2500, 6000, random);
  const silenceMs = irand(25000, 70000, random);
  return { typedMs, silenceMs, totalMs: typedMs + silenceMs };
}

/** Plain-words gap, for her internal note. */
export function gapWords(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes`;
  const h = Math.round(m / 60);
  return h === 1 ? "an hour" : `${h} hours`;
}

/**
 * The internal line telling her why she is answering late - she may nod at it,
 * but she never mentions notes or timing. Empty string when there is nothing to say.
 */
export function reactionNote(plan, { sinceLastBotMs = Infinity, hesitated = false } = {}) {
  if (!plan || plan.mode === "ignore") return "";
  const bits = [plan.note].filter(Boolean);
  // she typed something first and threw it away - the second version is the one
  // that survived her own editing, so it reads slightly deliberate
  if (hesitated) bits.push("you started typing a moment ago and deleted it, and this is the version you actually send");
  if (sinceLastBotMs > 3 * 3600000 && plan.mode !== "asleep") {
    bits.push("it has been hours since you two last texted, so it is fine if you sound like you missed him");
  }
  return bits.join("; ");
}

/**
 * Only quote when the user explicitly chose a Telegram reply target.
 */
export function chooseQuote({ threadId = null } = {}) {
  return threadId ? { id: Number(threadId), source: "thread" } : null;
}

/** A spontaneous message has no explicit target and must not quote old chat. */
export function pickReplyTarget() { return null; }
