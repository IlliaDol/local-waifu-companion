// Her own life: a diary generated once a day, spontaneous texts spread over the
// day, "busy" windows, and one dramatic double text when you ignore her.
import { CONFIG } from "./config.js";
import * as mem from "./memory.js";
import { llm, tidyReply } from "./deepseek.js";
import {
  SYSTEM_BASE, DS_MENTOR_BLOCK, contextBlock, diaryPrompt, proactivePrompt, doubleTextPrompt, DOUBLE_TEXTS, BUSY_FALLBACK,
  repeatBlock, threadsBlock, canonBlock, mediaBlock, storylineHint, songHint, dayCardsBlock, bondBlock, photoPrompt,
} from "./persona.js";
import { truncate } from "./util.js";
import * as mood from "./mood.js";
import * as sleep from "./sleep.js";
import * as tasks from "./tasks.js";
import * as usage from "./usage.js";
import * as weather from "./weather.js";
import * as identity from "./identity.js";
import { nowBerlin, berlinToUtc, rand, pick, log, logErr } from "./util.js";
import * as signal from "./signal.js";
import * as bond from "./bond.js";
import * as style from "./style.js";
import * as photos from "./photos.js";
import * as roadmap from "./data-science.js";

// Songs she can actually send when a "found a song" moment fires - small, kept
// deliberately generic-pop so the link outlives trends. Rotated by index.
const SONGS = [
  { url: "https://www.youtube.com/watch?v=4NRXx6U8ABQ", why: "the beat dropped and my brain left my body" },
  { url: "https://www.youtube.com/watch?v=kJQP7kiw5Fk", why: "this has been on loop since morning, send help" },
  { url: "https://www.youtube.com/watch?v=RgKAFK5djSk", why: "it found me at 2am and refused to leave" },
  { url: "https://www.youtube.com/watch?v=fRh_vgS2dFE", why: "one listen and it moved into my head permanently" },
  { url: "https://www.youtube.com/watch?v=OPf0YbXqDm0", why: "i do not even like this genre, that is how good the chorus is" },
];

// ---------------------------------------------------------- repetition gate
// Her own spontaneous texts used to converge on one script (the same song, the
// same 'supposed to be mad at you' beat, three times in an hour). Everything she
// sends first goes through here: too much word-overlap with anything recent and
// the text is either re-rolled or dropped.
const tokens = (s) => String(s || "").toLowerCase().match(/[a-z']{3,}/g) || [];

export function overlapScore(candidate, previous) {
  const a = new Set(tokens(candidate));
  if (!a.size) return 0;
  let hits = 0;
  for (const w of new Set(tokens(previous))) if (a.has(w)) hits += 1;
  return hits / a.size;
}

export function tooSimilar(candidate, previousList, threshold = 0.55) {
  return (previousList || []).some((p) => overlapScore(candidate, p) >= threshold);
}

/** Recent lines of hers, newest first - the echo the gate listens for. */
function recentEcho(hours = 2) {
  const cutoff = Date.now() - hours * 3600000;
  return mem.recentSent(16)
    .filter((x) => (x.ts || 0) >= cutoff)
    .map((x) => x.text);
}

/**
 * System-side additions every proactive prompt gets: what she already said, what
 * is spent, what is shelved, what her canon is. This is the piece the reply path
 * always had and the proactive paths never did - which is why they looped.
 */
function echoBlock() {
  const drops = mem.droppedTopics();
  const dropLine = drops.length
    ? `- Topics HE shut down today (OFF LIMITS until tomorrow - do not ask, hint, joke or sulk about them in a text you initiate: "${drops.slice(-4).map((d) => d.text).join("\" | \"")}")`
    : "";
  return [repeatBlock(mem.recentSent(10)), threadsBlock(mem.state), dropLine, canonBlock(mem.state), mediaBlock(mem.state), dayCardsBlock(mem.state), bondBlock(bond.view(mem.state)), identity.block()]
    .filter(Boolean)
    .join("\n");
}

/**
 * A picture of her own day, captioned in the moment: the file is paper, the words
 * are hers, so the same photo never reads like the same message twice.
 */
async function sendPhotoText(photo, moment, m, { replyTo = null } = {}) {
  const usageKey = usage.begin({ kind: "proactive-photo" });
  try {
    const out = await llm(
      [
        { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(mem.state)}\n\n${mood.block(m)}\n\n${echoBlock()}` },
        { role: "user", content: photoPrompt(photo.desc || "something from your day", moment) },
      ],
      { maxTokens: 40, temperature: mood.temperature(m) },
    );
    const caption = style.prepareCapped(tidyReply(out), style.plan(m));
    if (!caption) return false;
    const res = await photos.sendPhoto(mem.state.ownerId, photo, caption, { replyTo });
    if (!res.ok) {
      logErr("[photo] send failed, no text either:", res.error);
      return false;
    }
    mem.noteHerPhoto(photo.name);
    if (res.result?.message_id) {
      mem.pushSent({ id: res.result.message_id, text: caption });
      usage.attach(usageKey, res.result.message_id);
    }
    mem.noteHerQuestion(caption);
    mem.noteInitiation();
    log(`[photo] she sent a picture of her day: ${photo.name} - "${caption}"`);
    return true;
  } catch (err) {
    logErr("[photo] failed:", err.message);
    return false;
  } finally {
    usage.end(usageKey);
  }
}

/** Send her spontaneous text, but only if the echo gate clears it. */
async function sendSpontaneous(prompt, m, { replyTo = null, kind = "proactive" } = {}) {
  const echo = echoBlock();
  const usageKey = usage.begin({ kind });
  try {
    let out = null;
    // one reroll if the first attempt echoes herself
    for (let attempt = 0; attempt < 2; attempt += 1) {
      out = await llm(
        [
          { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(mem.state)}\n\n${mood.block(m)}\n\n${echo}\n\n${signal.topicMode(prompt).topic === "data_science" ? `${DS_MENTOR_BLOCK}\n\n${roadmap.contextFor(prompt, { maxChars: 2200, limit: 2, rotate: true })}` : ""}` },
          { role: "user", content: prompt },
        ],
        { maxTokens: mood.tokenBudget(m, CONFIG.proactiveMaxTokens), temperature: mood.temperature(m) },
      );
      out = tidyReply(out);
      if (out && !tooSimilar(out, recentEcho())) break;
      if (attempt === 0) log(`[proactive] first draft echoed her recent texts - rolling once more`);
    }
    if (!out) return;
    if (tooSimilar(out, recentEcho())) {
      log(`[proactive] dropped a text that repeated what she already sent`);
      return;
    }
    // her question budget is global, and spontaneous texts are questions too
    if (/\?/.test(out)) mood.noteQuestion(mem.state);
    mem.noteHerQuestion(out);
    await sendFn(out, { proactive: true, replyTo, usageKey, maxBubbles: mood.maxBubbles(m) });
    mem.noteInitiation();
  } finally {
    usage.end(usageKey);
  }
}

let sendFn = null;
let running = false;

let firstTick = null;
let tickLoop = null;

export function startProactive(sender) {
  sendFn = sender;
  firstTick = setTimeout(() => tick().catch((e) => logErr("[proactive] tick:", e.message)), 12000);
  tickLoop = setInterval(() => tick().catch((e) => logErr("[proactive] tick:", e.message)), 45000);
}

/**
 * Called by the scripted conversation preview: her own spontaneous texts are
 * great in real life and pure noise in the middle of a transcript.
 */
export function stopProactive() {
  clearTimeout(firstTick);
  clearInterval(tickLoop);
  firstTick = null;
  tickLoop = null;
}

/** Her state of mind, rolling a fresh one when the last ran out. */
/** Tonight's bedtime and wake time, rolled once a day and then kept. */
function night() {
  const sched = sleep.ensureWindow(mem.state, { t: nowBerlin(), mood: mood.currentMood(mem.state) });
  if (sched.fresh) {
    delete sched.fresh;
    log(`[sleep] tonight: bed ${Math.floor(sched.bedMin / 60) % 24}:${String(sched.bedMin % 60).padStart(2, "0")}, up ${Math.floor(sched.wakeMin / 60) % 24}:${String(sched.wakeMin % 60).padStart(2, "0")} (${sched.hours}h - ${sched.why})`);
    mem.saveSoon();
  }
  return sched;
}

function herMood() {
  const before = mem.state.mood?.key;
  const m = mood.ensureMood(mem.state, {
    sinceLastUserMs: mem.state.lastUserTs ? Date.now() - mem.state.lastUserTs : Infinity,
    busyNow: Boolean(currentWindow()),
    tension: Boolean(bond.arc(mem.state)),
  });
  if (m.key !== before) {
    log(`[mood] now ${m.def.label} for ~${m.hours}h (${m.why || "no particular reason"})`);
    mem.save();
  }
  return m;
}

export function currentWindow(b = nowBerlin()) {
  const w = mem.state.busyWindow;
  if (!w) return null;
  // A busy window (her cafe shift, say) replaces every reply with one canned line
  // for hours, which is easy to mistake for a broken preview - so the preview can
  // opt out of the shift and see the real reply it is hiding.
  if (process.env.NEGEV_DRY_IGNORE_BUSY === "1") return null;
  const now = Date.now();
  return now >= w.startMs && now < w.endMs ? w : null;
}

// ------------------------------------------------------------------ diary
const FALLBACK_EVENTS = [
  "09:30 - coffee, slow start, scrolling too long",
  "13:00 - shift at the cafe downtown",
  "18:30 - gym, leg day, dying",
  "22:00 - manga in bed, phone nearly dead",
];

function defaultDiary(date) {
  return { date, events: FALLBACK_EVENTS, busy: [], ack: [...BUSY_FALLBACK] };
}

function parseDiary(out, date) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let json;
  try {
    json = JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
  const events = (json.events || []).map((e) => String(e).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5);
  const ack = (json.ack || json.acks || []).map((a) => String(a).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3);
  const busy = [];
  for (const [i, w] of (json.busy || []).slice(0, 2).entries()) {
    const startMs = berlinToUtc(date, String(w?.start || "")).getTime();
    const endMs = berlinToUtc(date, String(w?.end || "")).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    busy.push({
      id: `${date}-${i}`,
      startMs,
      endMs,
      activity: String(w?.activity || "stuff").slice(0, 40),
      done: false,
    });
  }
  return { date, events: events.length ? events : FALLBACK_EVENTS, busy, ack: ack.length ? ack : [...BUSY_FALLBACK] };
}

/**
 * Her day of spontaneous texts, kept inside her waking hours - she does not text
 * from bed at 03:00, and the first one lands after she has actually surfaced.
 * Exported for the self-test, which checks that no slot ever falls in her night.
 */
export function makeSchedule(sched, t = nowBerlin(), { state = mem.state, random = Math.random } = {}) {
  const { slotsMin, slotsMax, minGapMin } = CONFIG.schedule;
  const target = rand(slotsMin, slotsMax);
  const from = sched ? sched.wakeMin + 45 : CONFIG.schedule.wakeHour * 60 + 30;
  // A 02:00 bedtime crosses midnight. This day's schedule is generated after
  // 08:00, so keep its slots in today's 08:45-23:15 waking range; the next
  // day's schedule handles its own morning. No slot is created during 02:00-08:00.
  const until = sched
    ? (sched.bedMin > sched.wakeMin ? Math.max(from + 60, sched.bedMin - 60) : 23 * 60 + 15)
    : 23 * 60 + 15;
  const earliest = Math.min(11 * 60, until);
  // the hours he actually answers in. About 60% of her first texts land there and
  // the rest stay random - she is not a cron job, she is a girlfriend who has
  // noticed that he is always on his phone around eleven at night.
  const hot = signal.hotHours(state, { from: earliest, to: until, limit: 4 });
  const times = [rand(from, Math.min(from + 120, until))];
  // about half of the rest aimed at his hours, the other half wherever they fall:
  // the aimed ones are a habit, the random ones are how she stays a person and not
  // a cron job. If his window cannot fit them, the guard drops out and the rest go
  // wherever they land.
  const aimed = hot.length ? Math.floor((target - 1) * 0.5) : 0;
  let placed = 0;
  let guard = 0;
  while (times.length < target && guard < 600) {
    guard += 1;
    const gap = guard > 400 ? minGapMin - 10 : minGapMin;
    const wantHot = placed < aimed && random() < 0.75;
    const hour = wantHot ? hot[Math.floor(random() * hot.length)] : null;
    const candidate = hour === null ? rand(earliest, until) : rand(Math.max(earliest, hour), Math.min(until, hour + 59));
      if (times.every((x) => Math.abs(x - candidate) >= gap)) {
      times.push(candidate);
      if (hour !== null) placed += 1;
    }
  }
  // A narrow or heavily constrained window must not silently collapse a day
  // into one or two messages. Keep the configured number of daytime slots with
  // an even fallback spread if the random placement could not fill them.
  if (times.length < target) {
    const span = Math.max(0, until - from);
    const spread = Math.max(minGapMin, span / Math.max(1, target - 1));
    const fallback = [];
    for (let i = 0; i < target; i += 1) {
      const candidate = Math.min(until, Math.round(from + spread * i));
      if (!fallback.length || candidate - fallback[fallback.length - 1] >= minGapMin) fallback.push(candidate);
    }
    if (fallback.length >= times.length) times.splice(0, times.length, ...fallback.slice(0, target));
  }
  times.sort((a, b) => a - b);
  return times.map((x) => ({ t: x, sent: false }));
}

async function ensureDiary(t) {
  const st = mem.state;
  if (!st.ownerId) return;
  if (st.diary?.date === t.dateStr) return;
  if (sleep.isAsleepAt(night(), t)) return; // still in bed - plan the day when she is up

  // the sky is part of her day: rain in the diary, rain out his window
  await weather.ensure();
  const wEvent = weather.diaryEvent();
  const anchor = identity.weekdayAnchor(t.weekday); // fixed weekly rhythm (mum call, market day)

  let diary = defaultDiary(t.dateStr);
  try {
    const out = await llm(
      [
        { role: "system", content: SYSTEM_BASE },
        { role: "user", content: `${diaryPrompt(t)}${wEvent ? `\nThe weather today: ${wEvent}. One of your events should be shaped by it.` : ""}${anchor ? `\nToday also includes: ${anchor} (put it at a believable time).` : ""}\nYour life details (use YOUR places and hobbies in the events): ${identity.diaryHooks()}${st.storylines?.length ? `\nOngoing storylines in your life (keep them moving today): ${st.storylines.map((s) => `${s.title} - ${s.beat}`).join(" | ")}` : ""}` },
      ],
      { maxTokens: 380, temperature: 1.0 },
    );
    diary = parseDiary(out, t.dateStr) || diary;
  } catch (err) {
    logErr("[proactive] diary failed:", err.message);
  }

  st.diary = diary;
  st.schedule = makeSchedule(night(), t);
  rollStorylines(t);
  mem.save();
  log(`[diary] ${t.dateStr}: ${diary.events.length} events | ${diary.busy.length} busy window(s) | ${st.schedule.length} planned texts${wEvent ? ` | weather: ${wEvent}` : ""}`);
}

// ------------------------------------------------------- storylines
// The diary resets daily, which gave her life no arcs: nothing connected Tuesday
// to Friday. Two or three ongoing storylines with a moving beat fix that - a
// an anime watchlist, a gym program, a friend drama in acts - and their beats feed
// both the diary and her spontaneous texts.
const STORYLINE_SEEDS = [
  { title: "the anime on her watchlist", beats: ["started an anime and is quietly hooked", "the episode hit harder than expected", "keeps putting off the next episode", "finished it and has opinions but is not making it a whole speech"] },
  { title: "the gym program", beats: ["week one of a new program, everything hurts", "leg day destroyed her again", "skipped once, feels guilty", "weights went up, quietly proud"] },
  { title: "her friend's drama", beats: ["her friend's situation is getting messier", "the friend did the thing everyone predicted", "a group chat argument she is staying out of", "it somehow resolved itself overnight"] },
  { title: "the flat", beats: ["deep-cleaning the flat, found things she forgot she owned", "a neighbour is renovating and drilling all day", "finally fixed the thing that was broken for weeks", "rearranged the plushies instead of doing the boring chore"] },
  { title: "learning to cook", beats: ["tried a new recipe, mostly survived", "the kitchen is a disaster zone", "one dish actually came out good", "back to frozen pizza, humility restored"] },
];

/** Roll (or advance) her storylines once a day. */
function rollStorylines(t) {
  const st = mem.state;
  if (st.storylinesOn === t.dateStr) return;
  st.storylinesOn = t.dateStr;
  const shuffled = [...STORYLINE_SEEDS].sort(() => Math.random() - 0.5);
  st.storylines = shuffled.slice(0, 2 + Math.floor(Math.random() * 2)).map((s) => {
    const old = (st.storylines || []).find((x) => x.title === s.title);
    const idx = old ? Math.min(old.beatIndex + 1, s.beats.length - 1) : Math.floor(Math.random() * s.beats.length);
    return { title: s.title, beat: s.beats[idx], beatIndex: idx };
  });
  log(`[storylines] ${st.storylines.map((s) => s.title).join(" | ")}`);
}

/** Roughly once a day, a scheduled slot is hijacked by a storyline beat. */
function storylineMoment(st) {
  if (!st.storylines?.length || Math.random() > 0.3) return null;
  const s = pick(st.storylines);
  // advance the beat so the story actually moves between tellings
  const seed = STORYLINE_SEEDS.find((x) => x.title === s.title);
  if (seed && Math.random() < 0.5) {
    s.beatIndex = Math.min((s.beatIndex ?? 0) + 1, seed.beats.length - 1);
    s.beat = seed.beats[s.beatIndex];
    mem.saveSoon();
  }
  return s;
}

// ---------------------------------------------------------- busy windows
async function busyTransitions() {
  const st = mem.state;
  const now = Date.now();
  const windows = st.diary?.busy || [];

  for (const w of windows) {
    if (!w.done && now >= w.endMs) {
      w.done = true;
      const wasActive = st.busyWindow?.id === w.id;
      if (wasActive) {
        st.busyWindow = null;
        const pending = st.pendingSince;
        st.pendingSince = null;
        mem.save();
        if (pending) await replyAfterBusy(w);
      } else {
        mem.save();
      }
    }
  }

  const active = windows.find((w) => !w.done && now >= w.startMs && now < w.endMs);
  if (active && st.busyWindow?.id !== active.id) {
    st.busyWindow = active;
    st.busyAcked = false;
    mem.save();
    log(`[busy] window opened: ${active.activity} until ${new Date(active.endMs).toISOString()}`);
  }

  // A break she announced herself ("ok showering, back in 20") closes on her own
  // clock instead of the diary's, and the reply that comes after it is a person
  // picking the thread back up - not a canned "busy busy, later ok".
  const sa = st.stepAway;
  if (sa && now >= sa.endMs) {
    const wasActive = st.busyWindow?.id === sa.id;
    st.stepAway = null;
    const pending = wasActive ? st.pendingSince : null;
    if (wasActive) {
      st.busyWindow = null;
      st.pendingSince = null;
    }
    mem.save();
    log(`[step-away] she is back from ${sa.activity}`);
    if (pending) await replyAfterBusy({ activity: sa.activity, stepAway: true });
  }
}

// ------------------------------------------------------- stepping away
// The most ordinary human thing there is: mid-conversation, something pulls you
// away, you say so in your own words, and you actually come back to the message.
// Her diary busy windows are scheduled, canned and mute; this one is announced by
// her and costs one short model call, so it stays rare.
const STEP_AWAY = [
  { what: "a shower", minutes: [12, 25] },
  { what: "actually cooking instead of ordering again", minutes: [25, 50] },
  { what: "a call from her mum", minutes: [20, 45] },
  { what: "the flat needing attention", minutes: [15, 35] },
  { what: "a friend turning up at the door", minutes: [20, 40] },
  { what: "the gym, later than planned", minutes: [40, 80] },
  { what: "a delivery and the whole downstairs thing", minutes: [10, 20] },
];

/**
 * She steps away, in her own words, and comes back to whatever he sends while she
 * is gone. Called after a reply has gone out, and only while the two of them are
 * actually mid-conversation - announcing a shower to a man who has been silent
 * for an hour is not a thing people do.
 */
export async function maybeStepAway({ dry = false, random = Math.random } = {}) {
  const st = mem.state;
  if (!st.ownerId || st.busyWindow || st.stepAway) return null;
  if (Number(st.activeChatUntil || 0) > Date.now() || Number(st.awakeUntil || 0) > Date.now()) return null;
  if (currentWindow()) return null;
  const now = Date.now();
  if (now - (st.lastBotTs || 0) > 10 * 60000) return null;
  if (now - (st.lastUserTs || 0) > 10 * 60000) return null;
  if (mem.quiet() || mem.holding()) return null;
  if (random() > 0.07) return null; // rare on purpose

  const m = herMood();
  if (!["warm", "clingy", "soft", "wired", "chaotic"].includes(m.key)) return null;
  const plan = STEP_AWAY[Math.floor(random() * STEP_AWAY.length)];
  const minutes = plan.minutes[0] + Math.floor(random() * (plan.minutes[1] - plan.minutes[0] + 1));
  const startsAt = now;
  const endsAt = now + minutes * 60000;
  const usageKey = usage.begin({ kind: "step-away" });
  let line = "";
  try {
    line = await llm(
      [
        { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(st)}\n\n${mood.block(m)}\n\n${echoBlock()}` },
        { role: "user", content: `(Internal: you have to go do something right now - ${plan.what} - for about ${minutes} minutes, and you will come back to him after. Send ONE short line saying so, exactly how you would type it mid-conversation: ${plan.what}, roughly how long, and a bit of you in it. No question mark, no apology, no "i will be back soon" formalities. lowercase, no emojis.)` },
      ],
      { maxTokens: 70, temperature: mood.temperature(m) },
    );
    line = tidyReply(line);
    if (!line || /\?/.test(line) || tooSimilar(line, recentEcho(1), 0.5)) line = pick([
      `ok ${plan.what} - back in like ${minutes} min`,
      `hold on, ${plan.what}. ${minutes} min`,
      `give me ${minutes} min, ${plan.what}`,
    ]);
  } catch (err) {
    logErr("[step-away] line failed:", err.message);
    line = `hold on, ${plan.what} - like ${minutes} min`;
  } finally {
    usage.end(usageKey);
  }

  st.stepAway = { id: `step-${startsAt}`, activity: plan.what, startMs: startsAt, endMs: endsAt, minutes };
  st.busyWindow = { id: st.stepAway.id, activity: plan.what, startMs: startsAt, endMs: endsAt, done: false };
  // she already explained herself, so no canned "busy busy, later ok" on top of it
  st.busyAcked = true;
  mem.save();
  if (dry) {
    log(`[step-away] (dry-run) she would step away for ${minutes} min: "${line}"`);
    st.stepAway = null;
    st.busyWindow = null;
    return null;
  }
  await sendFn(line, { proactive: true, maxBubbles: 1 });
  log(`[step-away] ${plan.what} for ~${minutes} min: "${line}"`);
  return st.stepAway;
}

async function replyAfterBusy(w) {
  const st = mem.state;
  const usageKey = usage.begin({ kind: w.stepAway ? "post-step-away" : "post-busy" });
  try {
    const m = herMood();
    const note = w.stepAway
      ? `(Internal: you went off to do ${w.activity} and you are back now. He wrote to you while you were away — the recent messages are above. Pick the thread straight back up: react to what he sent, say you are back in a couple of words if it fits, and do NOT apologise or explain yourself twice. 1-2 short bubbles separated by ||| . No emojis, no question mark unless you actually have one.)`
      : `(Internal: you were busy with "${w.activity}" and you are free now. He texted you while you were away — check the recent messages above. Write the reply you send right now: react to what he sent and add a quick nod that you were busy. 1-2 bubbles separated by ||| . No emojis.)`;
    const out = await llm(
      [
        { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(st)}\n\n${mood.block(m)}\n\n${echoBlock()}` },
        { role: "user", content: note },
      ],
      { maxTokens: mood.tokenBudget(m, CONFIG.proactiveMaxTokens + 60), temperature: mood.temperature(m) },
    );
    await sendFn(out, { proactive: true, usageKey, maxBubbles: mood.maxBubbles(m) });
  } catch (err) {
    logErr("[proactive] post-busy reply failed:", err.message);
  } finally {
    usage.end(usageKey);
  }
}

// -------------------------------------------------------- planned texts
/** Her initiations are capped: quiet mode, his "back later", and a hard ceiling
 *  of unanswered first texts. A girl who keeps texting a wall gets muted. */
function blockedFromInitiating() {
  const st = mem.state;
  if (mem.quiet()) return "quiet mode";
  if (mem.holding()) return `he said he would come back (${st.holdWhy || "away"})`;
  const cap = Math.max(1, Number(CONFIG.schedule.maxUnansweredInitiations || 4));
  if ((st.initiations || 0) >= cap) return `already texted first ${cap} times unanswered`;
  return null;
}

async function scheduledTexts(t) {
  const st = mem.state;
  if (!st.diary || !st.schedule?.length) return;

  for (const slot of st.schedule) {
    if (slot.sent || t.minutes < slot.t) continue;
    const sentBefore = st.schedule.filter((s) => s.sent).length;
    slot.sent = true;
    mem.save();

    const stale = t.minutes - slot.t > 150; // machine was off, do not dump old texts
    if (stale) continue;
    const held = blockedFromInitiating();
    if (held) {
      log(`[proactive] slot skipped - ${held}`);
      continue;
    }
    if (Date.now() - st.lastUserTs < CONFIG.schedule.userActiveWindowMin * 60000) continue;
    if (currentWindow(t)) continue;

    // Her mood changes the wording and energy, not whether she disappears for
    // the rest of the day. The explicit quiet/hold/unanswered gates above are
    // the boundaries; a distant mood is still allowed to send a short text.
    const m = herMood();

    try {
      const ctx = mem.history
        .slice(-6)
        .map((h) => `${h.r === "u" ? "HIM" : "YOU"}: ${h.t}`)
        .join("\n") || "(you two have not texted yet today)";

      let kind = sentBefore === 0
        ? "morning"
        : t.hour >= 22
          ? "goodnight"
          : Math.random() < 0.6
            ? "event"
            : "random";

      let event = kind === "event" ? pickUpcomingEvent(st.diary.events, t) : null;

      // a storyline beat, a song she found, her hobby, or the weather can all be
      // the reason she picks the phone up - anything but the same script again
      let extra = "";
      if (kind !== "morning" && kind !== "goodnight") {
        if (Math.random() < Number(CONFIG.dataScience?.proactiveShare ?? 0.45)) {
          extra = roadmap.proactiveCue();
        } else {
          const story = storylineMoment(st);
          if (story && Math.random() < 0.5) {
            extra = storylineHint(story);
          } else if (Math.random() < 0.12) {
            const song = SONGS[Math.floor(Math.random() * SONGS.length)];
            extra = songHint(song.url, song.why);
          } else if (Math.random() < 0.25) {
            const h = identity.hobby();
            extra = `(Internal: your hobby "${h.key}" just came up in your life - ${h.detail}. It can be the thing you text about, briefly, in passing.)`;
          }
        }
      }
      const wNote = weather.noteLine();
      if (wNote && !extra) extra = `(Internal: ${wNote}.)`;
      // weather is background colour, never the headline: only when the sky has
      // just turned AND the slot is a mid-day one, and even then it rides along
      // inside a text that is really about something else. Rain start/stop/swing
      // can be mentioned at most once per turn of the sky (weather.js consumes it).
      if (kind === "event" && !extra && Math.random() < 0.25) {
        const turn = weather.changed();
        if (turn) extra = `(Internal: ${turn} - it just happened outside too; let it colour what you say about your day, one clause at most. The text is still about your day, not the sky.)`;
      }

      // sometimes the thing she sends is a picture of it, not words. One a day,
      // captioned in the moment, so the same file never reads twice.
      if (kind !== "goodnight" && Math.random() < 0.25) {
        const moment = [event || "", extra, (st.diary?.events || []).slice(-1)[0] || "", st.busyWindow || ""].join(" ");
        const photo = photos.pick(st, { moment });
        if (photo && (await sendPhotoText(photo, moment, m))) return;
      }

      const prompt = [proactivePrompt(kind, event, ctx), extra]
        .filter(Boolean)
        .join("\n\n");

      await sendSpontaneous(prompt, m, { kind: `proactive-${kind}` });
    } catch (err) {
      logErr("[proactive] text failed:", err.message);
    }
    return; // one per tick
  }
}

function pickUpcomingEvent(events, t) {
  const withTime = events
    .map((e) => {
      const m = e.match(/^(\d{1,2}):(\d{2})/);
      return m ? { e, mins: (+m[1]) * 60 + (+m[2]) } : null;
    })
    .filter(Boolean);
  const past = withTime.filter((x) => x.mins <= t.minutes);
  if (past.length) return past[past.length - 1].e;
  return withTime[0]?.e || pick(events);
}

// --------------------------------------------------------- double text
/**
 * Her last line of the night. Bedtime is rolled per day, so this fires when the
 * clock reaches it - and only if they were actually talking, because announcing
 * that you are going to bed to someone who has been silent for hours is odd.
 */
async function bedtimeText(t) {
  const st = mem.state;
  const sched = night();
  if (!sched || st.sleep?.goodnightOn === t.dateStr) return;
  const mins = sleep.minutesUntilBed(sched, t);
  if (mins > 4) return;
  st.sleep.goodnightOn = t.dateStr;
  mem.save();
  if (currentWindow(t)) return;
  if (Date.now() - (st.lastUserTs || 0) > 90 * 60000) return;
  if (blockedFromInitiating()) return; // a goodnight is still an initiation

  const m = herMood();
  // going to bed annoyed is what makes a fight last until morning
  if (m.key === "sulky" || m.key === "distant") {
    const arc = bond.maybeTension(mem.state, { moodView: m, t, cause: m.why, goingToBed: true });
    if (arc) log(`[bond] she is going to bed still annoyed (${arc.cause || "it was off"}) - tomorrow starts with that`);
  }
  const context = mem.history.slice(-6).map((h) => `${h.r === "u" ? "HIM" : "YOU"}: ${h.t}`).join("\n");
  log(`[proactive] bedtime - one last line before she is gone for the night`);
  try {
    await sendSpontaneous(proactivePrompt("goodnight", null, context), m, { kind: "proactive-goodnight" });
  } catch (err) {
    logErr("[proactive] bedtime text failed:", err.message);
  }
}

async function doubleText() {
  const st = mem.state;
  const now = Date.now();
  if (currentWindow()) return;
  if (!st.lastBotTs || st.lastBotTs <= st.lastUserTs) return;
  if (now - st.lastBotTs < CONFIG.schedule.doubleTextAfterH * 3600000) return;
  if (st.lastDoubleTextTs >= st.lastUserTs) return; // already sulked once this silence
  if (!st.ownerId) return;
  if (blockedFromInitiating()) return;

  st.lastDoubleTextTs = now;
  mem.save();
  log("[proactive] double text");

  const m = herMood();
  const spent = (st.openQuestions || []).map((q) => q.text);
  try {
    // the model first: about something NEW, never her spent questions, gated for echoes
    const out = await llm(
      [
        { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(st)}\n\n${mood.block(m)}\n\n${echoBlock()}` },
        { role: "user", content: doubleTextPrompt(mem.lastAssistantText(), spent) },
      ],
      { maxTokens: 70, temperature: mood.temperature(m) },
    );
    const text = tidyReply(out);
    if (!text || tooSimilar(text, recentEcho(6), 0.45) || /\?/.test(text)) {
      log("[proactive] double text echoed herself - using a canned line");
      await sendFn(pick(DOUBLE_TEXTS), { proactive: true });
      mem.noteInitiation();
      return;
    }
    await sendFn(text, { proactive: true, maxBubbles: mood.maxBubbles(m) });
    mem.noteInitiation();
  } catch (err) {
    logErr("[proactive] double text failed:", err.message);
    await sendFn(pick(DOUBLE_TEXTS), { proactive: true });
  }
}

async function tick() {
  if (running || !sendFn) return;
  running = true;
  try {
    const t = nowBerlin();
    await ensureDiary(t);
    await busyTransitions();
    await milestoneTasks(t);
    await promiseFollowUps(t);
    await scheduledTexts(t);
    await doubleText();
    await bedtimeText(t);
    await tasksTick(t);
    mem.rollDayCards(t);
  } finally {
    running = false;
  }
}

// ------------------------------------------------------------ milestones
// A month of this, the hundredth message, the first fight that got made up -
// a person notices those on their own. Nobody here invents a new clock for it:
// the milestone becomes one of her own texts through the reminder machinery.
async function milestoneTasks(t) {
  const st = mem.state;
  if (!st.ownerId) return;
  const due = bond.dueMilestones(st, t);
  for (const m of due) {
    if (tasks.addTask(bond.milestoneTask(m, t))) {
      log(`[bond] milestone reached - she will say something about ${m.what}`);
    }
  }
}

// ---------------------------------------------------- promises / follow-ups
// A promise that is overdue gets ONE check-in - hers to him, his to her - and
// then it is either kept or gracefully dropped. This is what makes her
// "i never forget" true without ever inventing debts he never made.
async function promiseFollowUps(t) {
  const st = mem.state;
  if (!st.ownerId) return;
  if (blockedFromInitiating()) return;
  if (sleep.isAsleepAt(night(), t)) return;
  if (currentWindow(t)) return;

  const now = Date.now();
  const open = mem.openPromises().filter((p) => !p.followedUp);
  for (const p of open) {
    const due = p.dueAt || p.madeAt + 6 * 3600000; // default: half a day, then she pings
    if (now < due) continue;
    p.followedUp = true;
    mem.save();
    const m = herMood();
    const who = p.by === "him" ? "HE said he would" : "YOU said you would";
    const prompt = `(Internal: a while ago, ${who}: "${p.text}". It has not happened yet. Bring it up ONCE, in one short text, like a person keeping track - teasing if it is his, a small confession or update if it is yours. Never a calendar notification, no questions about anything else. lowercase, no emojis.)`;
    try {
      await sendSpontaneous(prompt, m, { kind: "promise-followup" });
      log(`[promises] followed up on "${p.text}"`);
    } catch (err) {
      logErr("[promises] follow-up failed:", err.message);
    }
    return; // one per tick
  }
}

// ------------------------------------------------------- tasks / reminders
// The clock side of things she is holding: his reminders fire when due, pinned
// facts with a day in them get a morning check-in, and anything that comes due
// while she sleeps moves to just after she wakes - like a person catching up.
async function tasksTick(t) {
  const st = mem.state;
  if (!st.ownerId) return;

  if (tasks.sweep() && st.tasksSweptOn !== t.dateStr) {
    st.tasksSweptOn = t.dateStr;
    mem.saveSoon();
  }

  const sched = night();
  if (sleep.isAsleepAt(sched, t)) {
    // due while she is in bed: it does not fire, it waits for her to surface
    const due = tasks.takeDue(t.dateStr, t.minutes);
    if (due.length) {
      for (const task of due) {
        task.fired = false;
        if (t.minutes < sched.wakeMin) {
          task.whenMin = sched.wakeMin + 5 + Math.floor(Math.random() * 20); // not yet awake: right after she is
        } else {
          task.date = tasks.addDays(t.dateStr, 1); // already past bedtime: first thing tomorrow
          task.whenMin = sched.wakeMin + 5 + Math.floor(Math.random() * 20);
        }
      }
      mem.save();
      log(`[tasks] ${due.length} due while she was asleep - moved to after she wakes`);
    }
    return;
  }
  if (currentWindow(t)) return; // mid-shift: it stays due and fires when she is free

  // 1) explicit reminders he asked for
  const due = tasks.takeDue(t.dateStr, t.minutes);
  for (const task of due) {
    log(`[tasks] reminder due: "${task.what}"`);
    await fireTask(task, t);
  }
  if (due.length) mem.save();

  // 2) pinned facts whose day has come - she checks in because she remembered
  const factDays = tasks.takeFactDays(t.dateStr);
  for (const task of factDays) {
    log(`[tasks] check-in due: "${task.what}"`);
    await fireTask(task, t);
  }
  if (factDays.length) mem.save();
}

async function fireTask(task, t) {
  const st = mem.state;
  const m = herMood();
  const isCheckin = task.kind === "fact-day";
  const isMoment = task.kind === "his-moment";
  const isMilestone = task.kind === "bond-milestone";
  const prompt = isMilestone
    ? `(Internal: ${task.what}. You remembered it yourself and it matters to you - text him first about it, in your own words, in your own way: pleased, a bit sappy about it, or teasing him about how long he has put up with you. ONE short message, lowercase, no emojis, never a calendar entry, and no "we should celebrate" planning.)`
    : isMoment
      ? `(Internal: yesterday he told you this and it clearly mattered: "${task.what}". It is ${t.hhmm} now. Check in on it like someone who was actually thinking about him - ask how it went, or say you have been wondering. ONE short message, lowercase, no emojis, no "just wanted to check in" phrasing.)`
      : isCheckin
        ? `(Internal: he told you a while ago: "${task.what}". It is ${t.hhmm} on the day itself - check in on it like a person who genuinely remembered and wants to know how it went. React to whatever he answers too. ONE short message, lowercase, no emojis, your own words - never a calendar notification.)`
        : `(Internal: he asked you to remind him: "${task.what}". It is ${t.hhmm} - this is that text, the deal you made. ONE short message, lowercase, no emojis, your own words, a little teasing is fine - never a calendar notification.)`;
  const usageKey = usage.begin({ kind: isMilestone ? "bond-milestone" : isMoment ? "his-moment" : isCheckin ? "task-checkin" : "task-reminder" });
  try {
    const out = await llm(
      [
        { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(st)}\n\n${mood.block(m)}` },
        { role: "user", content: prompt },
      ],
      { maxTokens: mood.tokenBudget(m, CONFIG.proactiveMaxTokens), temperature: mood.temperature(m) },
    );
    // a reminder is one text, not a mood-driven burst - the deal was one ping
    await sendFn(out, { proactive: true, usageKey, maxBubbles: 1 });
  } catch (err) {
    logErr("[tasks] message failed:", err.message);
    const fallback = isMilestone
      ? `so. ${task.what}. i noticed)`
      : isMoment
        ? `so how did it go with ${String(task.what).replace(/^he told you:\s*/i, "")}?`
        : isCheckin
          ? `so? ${task.what}? how did it go`
          : `hey. ${task.what}. that was the deal)`;
    await sendFn(fallback, { proactive: true, usageKey });
  } finally {
    usage.end(usageKey);
  }
}

/**
 * The real tasks tick, exposed for the NEGEV_DRY_TASKS preview - same code path
 * she runs live, so what you watch is what you get.
 */
export async function tasksTickForPreview(t = nowBerlin()) {
  await tasksTick(t);
}

/** Called by bot.js when a message arrives while she is "busy". */
export async function announceBusy() {
  const st = mem.state;
  if (st.busyAcked) return;
  st.busyAcked = true;
  mem.save();
  const line = st.diary?.ack?.length ? pick(st.diary.ack) : pick(BUSY_FALLBACK);
  await sendFn(line, { proactive: true });
}

export function busySummary() {
  const st = mem.state;
  const w = st.busyWindow;
  if (!w) return "free";
  const left = Math.max(0, Math.round((w.endMs - Date.now()) / 60000));
  return `${w.activity} (about ${left} min left)`;
}
