// Why she does not react to the same thing twice.
//
// Rolling dice per message makes her *statistically* random but emotionally
// consistent - suspiciously so, and never twice the same way for long. A real
// person has a mood that lasts hours and bends everything: how fast she answers,
// how many words she uses, whether she asks anything back, whether a photo is
// worth more than "hm nice". So one mood lives on disk (state.mood) for a few
// hours, carries a reason, and shows up in her timing, her length and her tone.
//
// None of this is announced to him: the mood block is internal, and she is told
// explicitly not to explain herself.
import { nowBerlin } from "./util.js";
import { line as typingLine, smileLine, heartLine, faceLine, nicknameLine } from "./style.js";

const MIN = 60000;
const HOUR = 3600000;

/**
 * Each mood is a whole personality for a few hours.
 *   weight     base chance of being picked (before time of day and context)
 *   hours      how long it lasts [min, max]
 *   when       multiplier per part of day: night / morning / day / evening
 *   delay      multiplier on how long she takes to answer
 *   eager      multiplier on answering instantly
 *   ignoreAdd  added chance of reading something and saying nothing
 *   laterAdd   added chance of leaving him on read for a while
 *   bubbles    max bubbles per reply
 *   words      word cap per bubble
 *   temp       sampling temperature for this mood
 *   energy     odds of excited / normal / flat reaction to what he sent
 *   followUp   chance she asks him something back
 *   typos      chance this reply includes a small typo she fixes
 *   proactive  multiplier on her own spontaneous texts
 *   smile      base chance of a laugh at the end of one line (see style.js)
 *   laugh      of those laughs, how often they come out as xdd instead of )))
 *   heart      chance of a typed <3 somewhere in this reply (see style.js)
 *   face       chance of a smug :3 - the mark of a playful mood, see style.js
 *   respect    chance of writing his name "Commander" instead of "commander"
 *   style      the actual instruction she receives
 *   whys       plausible reasons, so the mood has a shape
 */
export const MOODS = {
  warm: {
    label: "warm",
    weight: 22,
    mess: 0.3,
    smile: 0.36,
    laugh: 0.35,
    heart: 0.22,
    face: 0.14,
    respect: 0.38,
    hours: [2, 6],
    when: { night: 0.8, morning: 1, day: 1, evening: 1.2 },
    delay: 0.9,
    eager: 1.15,
    ignoreAdd: -0.04,
    laterAdd: -0.03,
    bubbles: 3,
    words: 24,
    temp: 1.0,
    energy: { excited: 0.35, normal: 0.45, flat: 0.2 },
    followUp: 0.7,
    typos: 0.05,
    proactive: 1,
    style: "you are in a good mood and it is obvious: warm, talkative, a little flirty, glad he is there",
    whys: ["you slept properly for once", "nothing special, you just feel good today", "he said something nice yesterday and it stuck"],
  },
  clingy: {
    label: "clingy",
    weight: 14,
    mess: 0.35,
    smile: 0.38,
    laugh: 0.45,
    heart: 0.28,
    face: 0.15,
    respect: 0.34,
    hours: [1, 4],
    when: { night: 1.6, morning: 0.8, day: 0.8, evening: 1.6 },
    delay: 0.55,
    eager: 1.6,
    ignoreAdd: -0.06,
    laterAdd: -0.05,
    bubbles: 3,
    words: 22,
    temp: 1.05,
    energy: { excited: 0.55, normal: 0.35, flat: 0.1 },
    followUp: 0.85,
    typos: 0.08,
    proactive: 1.6,
    style: "you want his attention and you are not being subtle about it: quick answers, questions, maybe an extra message when he goes quiet",
    whys: ["you have been alone with your phone all day", "he was busy earlier and you did not like it", "you just miss him, no deeper reason"],
  },
  wired: {
    label: "wired",
    weight: 14,
    mess: 0.45,
    smile: 0.3,
    laugh: 0.5,
    heart: 0.09,
    face: 0.16,
    respect: 0.12,
    hours: [2, 5],
    when: { night: 0.6, morning: 1.2, day: 1.5, evening: 1.1 },
    delay: 0.7,
    eager: 1.35,
    ignoreAdd: -0.02,
    laterAdd: 0,
    bubbles: 3,
    words: 30,
    temp: 1.1,
    energy: { excited: 0.6, normal: 0.35, flat: 0.05 },
    followUp: 0.8,
    typos: 0.12,
    proactive: 1.3,
    style: "you are buzzing: fast, loud, three bubbles deep, jumping between things, teasing hard, asking him stuff",
    whys: ["too much coffee", "something good happened today", "you have music on and you cannot sit still"],
  },
  tired: {
    label: "tired",
    weight: 18,
    mess: 0.55,
    smile: 0.14,
    laugh: 0.12,
    heart: 0.07,
    face: 0.04,
    respect: 0.22,
    hours: [2, 6],
    when: { night: 1.4, morning: 1.8, day: 0.9, evening: 1.2 },
    delay: 1.5,
    eager: 0.55,
    ignoreAdd: 0.07,
    laterAdd: 0.05,
    bubbles: 2,
    words: 11,
    temp: 0.95,
    energy: { excited: 0.08, normal: 0.37, flat: 0.55 },
    followUp: 0.25,
    typos: 0.1,
    proactive: 0.6,
    style: "you are flat and worn out: short answers, sometimes one word, no questions, no teasing. You are not angry, just low on battery",
    whys: ["long day", "you slept badly", "you have been on your feet since morning"],
  },
  sulky: {
    label: "sulky",
    weight: 10,
    mess: 0.4,
    smile: 0.06,
    laugh: 0.06,
    heart: 0.03,
    face: 0.03,
    respect: 0.32,
    hours: [1, 4],
    when: { night: 1.2, morning: 1, day: 1, evening: 1.3 },
    delay: 1.3,
    eager: 0.7,
    ignoreAdd: 0.05,
    laterAdd: 0.06,
    bubbles: 2,
    words: 14,
    temp: 1.0,
    energy: { excited: 0.05, normal: 0.35, flat: 0.6 },
    followUp: 0.15,
    typos: 0.04,
    proactive: 0.7,
    style: "you are quietly annoyed with him about something (usually that he went quiet). Dry, short, one pointed little line. You want him to notice and you will not say it outright",
    whys: ["he left you on read for hours", "he did not ask how your day went", "you are keeping score again"],
  },
  distant: {
    label: "distant",
    weight: 9,
    mess: 0.35,
    smile: 0.09,
    laugh: 0.08,
    heart: 0.02,
    face: 0.02,
    respect: 0.15,
    hours: [2, 7],
    when: { night: 1, morning: 1.2, day: 1.2, evening: 1 },
    delay: 1.8,
    eager: 0.4,
    ignoreAdd: 0.12,
    laterAdd: 0.1,
    bubbles: 1,
    words: 12,
    temp: 0.9,
    energy: { excited: 0.03, normal: 0.32, flat: 0.65 },
    followUp: 0.15,
    typos: 0.05,
    proactive: 0.35,
    style: "you are somewhere else today: you answer, but you do not carry the conversation, you do not ask things, you do not start anything. Not cold exactly - just not present",
    whys: ["your head is somewhere else today", "you had a weird day and you are not in the mood to explain it", "you are tired of being the one who always texts first"],
  },
  soft: {
    label: "soft",
    weight: 12,
    mess: 0.25,
    smile: 0.4,
    laugh: 0.18,
    heart: 0.34,
    face: 0.06,
    respect: 0.6,
    hours: [1, 3],
    when: { night: 2.6, morning: 0.6, day: 0.3, evening: 0.9 },
    delay: 0.8,
    eager: 1.2,
    ignoreAdd: -0.05,
    laterAdd: -0.04,
    bubbles: 3,
    words: 22,
    temp: 1.05,
    energy: { excited: 0.2, normal: 0.45, flat: 0.35 },
    followUp: 0.6,
    typos: 0.03,
    proactive: 1.1,
    style: "it is late and the armour is off: softer than usual, honest, no teasing. The clingy, loud version of you is asleep",
    whys: ["it is late and you are half asleep", "you were thinking about him in bed", "a quiet night, just you and your phone"],
  },
  chaotic: {
    label: "chaotic",
    weight: 11,
    mess: 0.9,
    smile: 0.35,
    laugh: 0.55,
    heart: 0.1,
    face: 0.18,
    respect: 0.09,
    hours: [1, 3],
    when: { night: 1.3, morning: 0.9, day: 1.2, evening: 1.3 },
    delay: 0.75,
    eager: 1.4,
    ignoreAdd: 0.02,
    laterAdd: 0.04,
    bubbles: 3,
    words: 26,
    temp: 1.15,
    energy: { excited: 0.5, normal: 0.35, flat: 0.15 },
    followUp: 0.75,
    typos: 0.25,
    proactive: 1.4,
    style: "unhinged-cute: tangents, abrupt topic changes, one tiny typo you fix a second later, an absurd line you immediately play cool. Still you, just turned up past the normal setting",
    whys: ["you are in one of those moods", "you have not spoken to another human all day", "no reason at all, you woke up like this"],
  },
};

export const MOOD_KEYS = Object.keys(MOODS);

function partOfDay(t) {
  if (t.minutes >= 22 * 60 || t.minutes < 5 * 60) return "night";
  if (t.minutes < 10 * 60) return "morning";
  if (t.minutes < 17 * 60) return "day";
  return "evening";
}

function pick(list, random = Math.random) {
  return list[Math.floor(random() * list.length)];
}

function irand(a, b, random = Math.random) {
  if (b <= a) return a;
  return a + Math.floor(random() * (b - a + 1));
}

/** Context multipliers: what is going on pushes her toward certain moods. */
function contextWeights(ctx) {
  const w = {};
  const bump = (key, mult) => { w[key] = (w[key] || 1) * mult; };

  if (ctx.sinceLastUserMs > 6 * HOUR) {
    bump("sulky", 2.6);
    bump("distant", 1.6);
    bump("clingy", 1.4); // she missed him too
  } else if (ctx.sinceLastUserMs > 2 * HOUR) {
    bump("clingy", 1.3);
    bump("sulky", 1.3);
  }
  if (ctx.activeExchange) {
    bump("warm", 1.3);
    bump("wired", 1.2);
    bump("distant", 0.4);
    bump("sulky", 0.6);
  }
  if (ctx.busyNow) {
    bump("tired", 1.5);
    bump("distant", 1.3);
    bump("wired", 0.6);
  }
  // Something is still unresolved between them from yesterday. A mood lasts a few
  // hours and blows over; this is what does not, which is the whole difference
  // between a sulk and a row.
  if (ctx.tension) {
    bump("sulky", 1.9);
    bump("distant", 1.5);
    bump("clingy", 1.25);
    bump("soft", 1.2);
    bump("warm", 0.75);
    bump("wired", 0.8);
  }
  return w;
}

function chooseMood(ctx, random) {
  const t = ctx.t || nowBerlin();
  const part = partOfDay(t);
  const ctxW = contextWeights(ctx);
  const entries = MOOD_KEYS.map((key) => {
    const def = MOODS[key];
    const score = def.weight * (def.when?.[part] ?? 1) * (ctxW[key] ?? 1);
    return [key, score];
  });
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let roll = random() * total;
  for (const [key, score] of entries) {
    roll -= score;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * Her mood right now, rolling a new one when the old has run out (or when she
 * simply woke up on the other side of the bed - real moods do not respect a timer).
 * Mutates state.mood and expects the caller to save.
 */
export function ensureMood(state, ctx = {}) {
  const random = ctx.random || Math.random;
  const now = ctx.now || Date.now();
  const t = ctx.t || nowBerlin();
  const current = state.mood;

  // Pin a mood for testing (NEGEV_FORCE_MOOD=chaotic node bot.js). Off unless set,
  // and it still wears off on its normal timer, so it can never stick by accident.
  const forced = process.env.NEGEV_FORCE_MOOD;
  if (forced && MOODS[forced]) {
    const held = current && current.key === forced && now < (current.until || 0);
    if (!held) {
      const def = MOODS[forced];
      const hours = irand(def.hours[0], def.hours[1], random);
      state.mood = { key: forced, since: now, until: now + hours * HOUR, checkedAt: now, why: `forced for a test (${forced})`, hours };
    }
    return view(state.mood);
  }

  if (current && MOODS[current.key]) {
    const expired = now >= (current.until || 0);
    const sinceCheckMs = now - (current.checkedAt || current.since || now);
    // the longer since we last looked, the likelier she has drifted
    const driftChance = Math.min(0.35, (sinceCheckMs / HOUR) * 0.06);
    // nobody answers eight messages in the same mood: a long live conversation has
    // to move her too, or she reads like one emotion on a loop
    const worn = (current.hisMsgs || 0) >= 7 && random() < 0.45;
    state.mood = { ...current, checkedAt: now };
    if (!expired && !worn && random() > driftChance) return view(state.mood);
  }

  const key = chooseMood({ ...ctx, t }, random);
  const def = MOODS[key];
  let why = pick(def.whys, random);
  if (key === "sulky" && ctx.sinceLastUserMs > 6 * HOUR) why = "he went quiet for hours and you noticed";
  if ((key === "tired" || key === "soft") && ctx.busyNow) why = "you just got back from being out";

  return setMood(state, key, why, random, now);
}

/** Count his messages since her mood last turned - how long she has been like this. */
export function noteHisMessage(state) {
  if (!state.mood) return;
  state.mood.hisMsgs = (state.mood.hisMsgs || 0) + 1;
}

/**
 * What he just sent, read without a model call - is he opening up, being sweet,
 * taking the blame, or just fooling around? Real moods move with the conversation,
 * and a girl who stays sulky straight through her boyfriend saying "i think i
 * might be down lately" is not a person, she is a state machine.
 *
 * The reading itself lives in signal.js now (it reads him, this file feels it) and
 * is re-exported here so nothing that already knew this name has to care.
 */
export { readHis as readSignal } from "./signal.js";

/** Put her in a mood now, with a reason she will never announce. */
function setMood(state, key, why, random = Math.random, now = Date.now()) {
  const def = MOODS[key] || MOODS.warm;
  const hours = irand(def.hours[0], def.hours[1], random);
  state.mood = { key, since: now, until: now + hours * HOUR, checkedAt: now, why, hours, hisMsgs: 0 };
  return view(state.mood);
}

/**
 * A night this short follows her into the morning. Called once on waking, so a late
 * night really does leave her flat and short the next day instead of being a number
 * in a log nobody feels.
 */
export function wakeUp(state, { hours = 8, random = Math.random, now = Date.now() } = {}) {
  if (hours >= 6 || random() > 0.7) return null;
  return setMood(state, "tired", `you slept about ${hours.toFixed(1)} hours and it shows`, random, now);
}

/**
 * Let the conversation move her, instead of the clock being the only thing that
 * can. Called on every message he sends, before her mood is read for the reply.
 * Returns the new mood when it turned, so the change can be logged.
 */
export function react(state, signal, { random = Math.random, now = Date.now(), engagement: eng = null } = {}) {
  if (!signal || !state.mood) return null;
  const key = state.mood.key;
  const flat = key === "sulky" || key === "distant";
  const low = flat || key === "tired";

  // he is actually struggling: the armour comes off, the sulk is forgotten
  if (signal.serious && low && random() < 0.8) {
    return setMood(state, "soft", "he is not doing well and you would rather be kind than right", random, now);
  }
  // he explained or said sorry: that is the end of the grudge
  if (signal.explained && flat && random() < 0.6) {
    return setMood(state, "warm", "he told you why he was quiet, so you let it go", random, now);
  }
  if (signal.affectionate && flat && random() < 0.65) {
    return setMood(state, "warm", "he said something sweet and you are not made of stone", random, now);
  }
  if (signal.funny && key !== "warm" && key !== "wired" && !signal.serious && random() < 0.3) {
    return setMood(state, "warm", "he is being funny and you cannot help it", random, now);
  }
  // He has been answering in two or three words for a while. A person notices
  // that and says so; a bot keeps cheerfully performing into the silence. He is
  // not punished for it - she just stops pretending nothing is wrong.
  if ((eng?.dryStreak || 0) >= 4 && !signal.explained && !signal.serious
    && (key === "warm" || key === "wired" || key === "chaotic") && random() < 0.4) {
    return setMood(state, "sulky", "he has been giving you two-word answers for a while and you do not know why", random, now);
  }
  return null;
}

function view(stored) {
  return { ...stored, def: MOODS[stored.key] || MOODS.warm };
}

/** Read-only view, for status text and tests. */
export function currentMood(state) {
  return state.mood && MOODS[state.mood.key] ? view(state.mood) : null;
}

/** Timing knobs handed to timing.js. */
export function timingBias(mood) {
  if (!mood?.def) return { ignoreAdd: 0, laterAdd: 0, eager: 1, delay: 1 };
  const d = mood.def;
  return { ignoreAdd: d.ignoreAdd || 0, laterAdd: d.laterAdd || 0, eager: d.eager ?? 1, delay: d.delay ?? 1 };
}

export function maxBubbles(mood) {
  const base = Math.min(3, mood?.def?.bubbles || 3);
  // Four is an occasional ceiling for an energetic message, never a target.
  return ["wired", "chaotic"].includes(mood?.key) ? 4 : base;
}

/**
 * A tired girl cannot write an essay even if she wanted to: the output budget is
 * derived from her mood's length, so the cap is enforced by the API rather than
 * politely requested. Cheaper too - a short mood costs a fraction of a token.
 */
export function tokenBudget(mood, cap = 320) {
  const d = mood?.def || mood; // accepts either a mood view or a raw definition
  if (!d?.words) return cap;
  const bubbles = ["wired", "chaotic"].includes(mood?.key) ? 4 : (d.bubbles || 2);
  const words = (d.words || 24) * bubbles;
  return Math.max(60, Math.min(cap, 24 + words * 3));
}

export function temperature(mood) {
  return mood?.def?.temp ?? 1.0;
}

/** How much energy this particular reply gets - same input, different answer. */
export function energyRoll(mood, random = Math.random, { excited = false } = {}) {
  const table = { ...(mood?.def?.energy || { excited: 0.3, normal: 0.5, flat: 0.2 }) };
  // something he sent actually lit her up - the odds move with him, not only with
  // her own mood
  if (excited) {
    table.excited = (table.excited ?? 0.3) + 0.18;
    table.flat = Math.max(0, (table.flat ?? 0.2) - 0.1);
  }
  let roll = random();
  let key = "normal";
  for (const candidate of ["excited", "normal", "flat"]) {
    roll -= table[candidate] ?? 0;
    if (roll <= 0) { key = candidate; break; }
  }
  const line = {
    excited: "this one actually got you going - react properly, ask something, tease him",
    normal: "react normally, a sentence or two, keep it moving",
    flat: "you are not feeling this particular thing much - short answer, no questions, no fake enthusiasm",
  }[key];
  return { key, line };
}

export function shouldFollowUp(mood, random = Math.random) {
  return random() < (mood?.def?.followUp ?? 0.6);
}

/** A question went out in this reply - the hourly budget ticks. */
export function noteQuestion(state) {
  if (!state) return;
  const t = nowBerlin();
  const hourKey = `${t.dateStr} ${Math.floor(t.minutes / 60)}`;
  if (state.questionHour !== hourKey) {
    state.questionHour = hourKey;
    state.questionCount = 1;
  } else {
    state.questionCount = (state.questionCount || 0) + 1;
  }
}

export function wantsTypo(mood, random = Math.random) {
  return random() < (mood?.def?.typos ?? 0.05);
}

export function proactiveAppetite(mood, random = Math.random) {
  return random() < (mood?.def?.proactive ?? 1);
}

/**
 * The internal block that shapes her reply: mood, how it shows, how long she may
 * be, and the reaction energy for this one message. `state` is optional and only
 * feeds the per-hour question budget.
 */
export function block(mood, { energy = null, followUp = true, typo = false, level = null, smile = null, heart = null, face = null, state = null } = {}) {
  if (!mood?.def) return "";
  const d = mood.def;
  const typing = level ? typingLine(level) : "";
  const smiling = smile ? smileLine(smile) : "";
  const hearting = heart ? heartLine(heart) : "";
  const facing = face ? faceLine(face) : "";
  // whichever plan object she was dressed with - they all carry the same roll
  const naming = nicknameLine(smile || heart || face || {});
  const t = nowBerlin(new Date(mood.since || Date.now()));
  // anti-interrogation: three questions in an hour is an interview, not a girlfriend
  const hourKey = `${t.dateStr} ${Math.floor(t.minutes / 60)}`;
  const asked = state && state.questionHour === hourKey ? (state.questionCount || 0) : 0;
  const budget = asked >= 2
    ? "- question budget spent this hour: NO question this time. React, tease, say something about yourself instead"
    : asked === 1
      ? "- you have asked one question this hour: at most one more, and only if it really fits"
      : "";
  const lines = [
    "YOUR STATE OF MIND RIGHT NOW (internal - never mention or explain this):",
    `- mood: ${d.label} since about ${t.hhmm} (${mood.why || "no particular reason"}), you do not have to announce it`,
    `- how it shows: ${d.style}`,
    `- length right now: max ${d.bubbles} bubble${d.bubbles > 1 ? "s" : ""}, max ${d.words} words each. That is a mood, not a rule you mention`,
    energy ? `- this particular message: ${energy.line}` : "",
    followUp ? (budget || "- you will probably ask him something back") : "- do not ask anything back this time, just react and leave it there",
    typo ? "- if it fits, drop one small typo in the first bubble and fix it in the next (\"meet you at 8\" then \"...7. i meant 7\"). One, never two, and only if it feels natural" : "",
    typing,
    smiling,
    hearting,
    facing,
    naming,
    "- your mood decides how you say it, never what it is about: news is still news, a photo is still a photo",
    "- you are still you: same person, same history with him. Moods pass, he does not have to earn them",
  ].filter(Boolean);
  return lines.join("\n");
}

/** One line for /status. */
export function describe(mood) {
  if (!mood?.def) return "no mood set yet";
  const mins = Math.max(0, Math.round(((mood.until || 0) - Date.now()) / MIN));
  const left = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  return `${mood.def.label} (${mood.why || "no reason"}) - changes in about ${left}`;
}
