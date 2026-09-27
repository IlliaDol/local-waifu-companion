// All of Negev's memory lives in ./data on your own disk. No cloud database.
import fs from "node:fs";
import { CONFIG, PATHS } from "./config.js";
import { TIMING_DEFAULTS } from "./timing.js";
import { nowBerlin, logErr } from "./util.js";
// signal.js is a leaf (clock and text only), so this is a one-way edge
import { contentWords } from "./signal.js";

function defaults() {
  return {
    // privacy: first private chat that says /start claims the bot forever
    ownerId: null,
    ownerName: null,
    boundAt: null,

    // long-term memory
    summary: "",
    facts: [],
    factsSeenAt: 0, // userMsgCount snapshot of the last fact extraction

    // her state of mind (mood.js): key, since, until, why, hours
    mood: null,
    // what this CONVERSATION is right now, as opposed to how she feels
    // (signal.js): venting, a real conversation, plans, banter, flirting
    tone: null,
    // the 24 hours of the day he actually answers in, decayed slowly - so she
    // texts when he is around instead of on her own invented schedule
    hisHours: [],
    // the relationship itself (bond.js): shared things, what she has opened up
    // about, milestones, the moments of his she is holding
    bond: null,
    // one line per finished day with him, composed locally - the thing that lets
    // her say "last tuesday you were stressed about that"
    dayCards: [],
    dayStats: {},
    dayCardsRolledOn: null,
    // the reaction channel (reactions.js): what his last heart was, which API
    // shape this telegram takes, and how many hearts she has spent today
    reactionStyle: "auto",
    hisReaction: null,
    reactionsSent: { date: null, count: 0 },
    // the last emoji she left on his message (spontaneous variety), and when he
    // last asked for one - a repeat ask within ~10 min gets the heart silently
    lastReactionEmoji: "",
    lastRequestedReactionAt: 0,
    // she said she was stepping away mid-conversation and really came back
    stepAway: null,
    // he put her right about something on the last message: she owns it once, then
    // the wrong version is gone from her head
    correction: null,
    // he edited a message she may already have read
    lastEdit: null,
    // the free check that her reply answered him, and the single regeneration it
    // can buy - counted, so the quality dial is visible instead of invisible
    verify: { date: null, count: 0, kinds: { question: 0, assistant: 0 } },
    // photos she has sent him, so the same one never comes round twice in a row
    herPhotos: [],

    // her simulated life
    diary: null, // { date, events[], busy[], ack[] }
    schedule: [], // [{ t: minutesOfDay, sent: bool }]

    // availability
    busyWindow: null, // { id, start, end, activity, startMs, endMs, done }
    busyAcked: false,
    pendingSince: null, // messages arrived while she was busy; answer them when the window ends

    // things he sent that she read and never answered (she picks them up later)
    unanswered: [],
    // he wrote while she was asleep: the answer is set for the morning, and this
    // is what survives a restart so the morning answer actually happens
    overnight: [],
    // questions SHE asked that he has not answered yet - she never re-asks one
    openQuestions: [],
    // every question she asked, per day, with how many times (repetition cap)
    askLog: [],
    // topics he shut down today - shelf until tomorrow, he can invite them back
    dropped: [],
    // her own canon: things she has said about her life (stories, songs, opinions)
    herCanon: [],
    // her fixed biography (identity.js): favourites, hobbies, places - rolled once
    identity: null,
    // promises and debts in both directions, so "i never forget" is a fact
    promises: [],
    // things he sent her (media), with her one-line description - callback fuel
    mediaLog: [],
    // multi-day storylines in her simulated life (continues across diaries)
    storylines: [],
    storylinesOn: null,
    // weather cache (weather.js owns the shape)
    weather: null,
    // balance warning: once a day max
    balanceWarnedOn: null,

    // tasks and reminders she is holding (tasks.js owns the shape)
    tasks: [],
    // the last handful of messages he sent, so she can quote any of them
    inbox: [],
    // ...and the last few of her own, so she can recognise a thread he replies into
    sent: [],

    // token / cost ledger (owned by usage.js)
    usage: null,

    // counters / timing
    userMsgCount: 0,
    lastUserTs: 0,
    lastBotTs: 0,
    lastDoubleTextTs: 0,
    lastUserText: "",
    lastUserTextAt: 0,
    mediaCount: 0,
    model: null,

    // his bare /force with nothing pending arms this: his very next message
    // is answered instantly, no human-delay dice (memory.js load() only keeps
    // known keys, so it must be declared here to survive a restart)
    forceNext: false,

    // holds: quiet mode (his /quiet) and "back later" (his own words)
    quietUntil: 0,
    holdUntil: 0,
    holdWhy: null,
    // proactive initiations since his last message - she does not spam first
    initiations: 0,
    // an active exchange is a presence guarantee, not a permanent wake lock
    activeChatUntil: 0,
    // /force keeps her awake for a short, explicit window across restarts
    awakeUntil: 0,
    // logical web reads, limited by day, hour, and a small cooldown
    webUsage: { date: null, calls: 0, hour: null, hourCalls: 0, lastAt: 0 },
    // how often she has volunteered a concrete detail from her own life
    turnsSinceLifeShare: 0,
    // anti-interrogation: questions she asked in the current hour
    questionHour: null,
    questionCount: 0,
  };
}

export let state = defaults();
export let history = [];

function ensureDir() {
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.mkdirSync(PATHS.tmp, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function load() {
  ensureDir();
  // only known keys survive: renaming fields never leaves stale state behind
  const base = defaults();
  const saved = readJson(PATHS.state, {});
  for (const key of Object.keys(base)) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) base[key] = saved[key];
  }
  state = base;
  const h = readJson(PATHS.history, []);
  history = Array.isArray(h) ? h : [];
  pruneEphemeralMemory();
  if (!CONFIG.memory.keepSummary) state.summary = "";
  save(); // materialise data/ on first boot so the folder is never a mystery
  return state;
}

// Read-only mode (the dry-run preview): she may think, but nothing is written and
// her real memory can never be polluted by a test.
let readOnly = false;
export function setReadOnly(value) {
  readOnly = Boolean(value);
}

export function save() {
  if (readOnly) return;
  try {
    writeAtomic(PATHS.state, state);
    writeAtomic(PATHS.history, history.slice(-CONFIG.historyKeep));
  } catch (err) {
    logErr("[memory] save failed:", err.message);
  }
}

let saveTimer = null;
export function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 1500);
}

export function pushHistory(role, content) {
  history.push({ r: role === "assistant" ? "a" : "u", t: String(content).slice(0, 1200), ts: Date.now() });
  if (history.length > CONFIG.historyKeep) history = history.slice(-CONFIG.historyKeep);
  saveSoon();
}

/** Last N turns, mapped to the API shape. Text only - media never re-uploaded. */
export function contextSlice(n = CONFIG.contextMessages) {
  return history
    .slice(-n)
    .map((h) => ({ role: h.r === "a" ? "assistant" : "user", content: h.t }));
}

/**
 * Ordinary chat is short-lived. This is deliberately separate from durable
 * facts, promises, her canon, and the relationship ledger.
 */
export function pruneEphemeralMemory(at = Date.now()) {
  const hours = Number(CONFIG.memory?.conversationHours || 36);
  const cutoff = at - hours * 3600000;
  const recent = (item) => Number(item?.ts || 0) >= cutoff;
  history = history.filter((h) => Number(h?.ts || 0) >= cutoff);
  state.inbox = (state.inbox || []).filter(recent);
  state.sent = (state.sent || []).filter(recent);
  state.unanswered = (state.unanswered || []).filter(recent);
  state.overnight = (state.overnight || []).filter(recent);
  state.mediaLog = (state.mediaLog || []).filter(recent);

  // Cards have no timestamp, but their ISO date is enough to keep only the
  // current and immediately previous day. Older cards are exactly the stale
  // "2-3 days ago" recall this bot should not volunteer.
  const today = nowBerlin(new Date(at)).dateStr;
  const [y, m, d] = today.split("-").map(Number);
  const yesterdayDate = new Date(Date.UTC(y, m - 1, d - 1));
  const yesterday = `${yesterdayDate.getUTCFullYear()}-${String(yesterdayDate.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterdayDate.getUTCDate()).padStart(2, "0")}`;
  const keepCards = new Set([today, yesterday]);
  const cardLimit = Math.max(0, Number(CONFIG.memory?.dayCardsKeep ?? 1));
  state.dayCards = (state.dayCards || []).filter((c) => keepCards.has(c.date)).slice(-cardLimit);
  state.dayStats = Object.fromEntries(Object.entries(state.dayStats || {}).filter(([date]) => keepCards.has(date)));
}

function itemMatches(item, needle) {
  return !needle || String(item?.text || item?.label || item?.what || item?.desc || "").toLowerCase().includes(needle);
}

/** Remove a topic from both durable and short-term memory. */
export function forgetMemory(query = "", previousText = "") {
  const needle = normalizeFact(query).toLowerCase();
  const target = normalizeFact(previousText).toLowerCase();
  let removed = 0;
  const matches = (text) => {
    const value = String(text || "").toLowerCase();
    if (needle) return value.includes(needle);
    return target && (value === target || value.includes(target) || target.includes(value));
  };

  const oldHistory = history;
  const dropHistory = new Set();
  for (let i = 0; i < oldHistory.length; i += 1) {
    if (oldHistory[i]?.r === "u" && matches(oldHistory[i].t)) {
      dropHistory.add(i);
      if (oldHistory[i + 1]?.r === "a") dropHistory.add(i + 1);
    }
  }
  removed += dropHistory.size;
  history = oldHistory.filter((_, i) => !dropHistory.has(i));

  for (const key of ["inbox", "sent", "unanswered", "overnight", "mediaLog"]) {
    const before = state[key]?.length || 0;
    state[key] = (state[key] || []).filter((item) => !itemMatches(item, needle || target));
    removed += before - state[key].length;
  }
  for (const key of ["facts", "herCanon"]) {
    const before = state[key]?.length || 0;
    state[key] = (state[key] || []).filter((value) => !matches(value));
    removed += before - state[key].length;
  }
  for (const key of ["promises", "tasks"]) {
    const before = state[key]?.length || 0;
    state[key] = (state[key] || []).filter((item) => !itemMatches(item, needle || target));
    removed += before - state[key].length;
  }
  if (needle || target) state.summary = "";
  state.correction = null;
  saveSoon();
  return removed;
}

export function webBudget(at = Date.now()) {
  const t = nowBerlin(new Date(at));
  const u = state.webUsage || {};
  const hour = `${t.dateStr}:${t.hour}`;
  return {
    date: t.dateStr,
    calls: u.date === t.dateStr ? Number(u.calls || 0) : 0,
    hourCalls: u.hour === hour ? Number(u.hourCalls || 0) : 0,
    lastAt: Number(u.lastAt || 0),
  };
}

/** Reserve logical web reads before any network request is made. */
export function reserveWebReads(requested, at = Date.now()) {
  const count = Math.max(0, Math.floor(Number(requested) || 0));
  const budget = webBudget(at);
  const daily = Number(CONFIG.social.maxReadsPerDay || 0);
  const hourly = Number(CONFIG.social.maxReadsPerHour || 0);
  const cooldown = Number(CONFIG.social.minReadIntervalMs || 0);
  const cooldownBlocked = budget.lastAt > 0 && at - budget.lastAt < cooldown;
  const available = cooldownBlocked ? 0 : Math.max(0, Math.min(daily - budget.calls, hourly - budget.hourCalls));
  const allowed = Math.min(count, available);
  const t = nowBerlin(new Date(at));
  const hour = `${t.dateStr}:${t.hour}`;
  state.webUsage = {
    date: t.dateStr,
    calls: budget.calls + allowed,
    hour,
    hourCalls: budget.hourCalls + allowed,
    lastAt: allowed ? at : budget.lastAt,
  };
  if (allowed) saveSoon();
  return { allowed, blocked: Math.max(0, count - allowed), cooldownBlocked, daily, hourly, calls: budget.calls + allowed, hourCalls: budget.hourCalls + allowed };
}

export function webBudgetText(at = Date.now()) {
  const b = webBudget(at);
  return `${b.calls}/${CONFIG.social.maxReadsPerDay} web reads today, ${b.hourCalls}/${CONFIG.social.maxReadsPerHour} this hour`;
}

export function lastAssistantText() {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].r === "a") return history[i].t;
  }
  return "";
}

export function addFacts(list, target = state) {
  for (const raw of list || []) {
    const fact = String(raw || "").replace(/\s+/g, " ").trim();
    if (fact.length < 3 || fact.length > 140) continue;
    if (target.facts.some((f) => f.toLowerCase() === fact.toLowerCase())) continue;
    target.facts.push(fact);
  }
  while (target.facts.length > 60) target.facts.shift();
}

// ------------------------------------------------------- he told her to remember
// "remember that my sister visits on fridays" - when HE says remember, it is not a
// maybe. Pinned facts re-enter at the end of the pool so extraction or rotation
// never quietly drops the things he explicitly asked her to keep.
export function normalizeFact(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

export function pinFact(raw, target = state) {
  const fact = normalizeFact(raw).slice(0, 140);
  if (fact.length < 3) return false;
  const lower = fact.toLowerCase();
  const at = target.facts.findIndex((f) => f.toLowerCase() === lower);
  if (at !== -1) {
    if (at === target.facts.length - 1) return true; // already the newest pinned thing
    target.facts.splice(at, 1); // drop the old copy, re-pin below
  }
  target.facts.push(fact);
  return true;
}

// Sentence ends always split. " and " splits only when what follows starts its
// own clause (and my sister..., and that i...) - "fish and chips" stays one fact.
const FACT_SPLIT = /(?<=[.!?;])\s+|\s+\band also\s+|\s+and\s+(?=(?:i|my|me|we|our|he|she|his|her|they|their|this|that|it|the)\b)|\n+/i;

/**
 * "remember [that] ..." -> the things to pin, or null when he is not asking her
 * to remember. Sentences are separated so "remember my exam is on monday. and
 * that i hate mondays" pins two facts, not one blob.
 */
export function parseRemember(text) {
  const body = String(text || "").replace(/^\/(remember|mem)\b\s*/i, "").trim();
  const m = body.match(/^(?:please\s+)?remember\b(?:\s+(?:that|this))?[:,]?\s*([\s\S]+)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest || rest.length < 3) return null;
  const facts = rest
    .split(FACT_SPLIT)
    .map(normalizeFact)
    .filter((f) => f.length >= 3)
    .slice(0, 5);
  return facts.length ? facts : null;
}

/**
 * His words, flipped to her voice for the echo back: "my exam is on monday" ->
 * "your exam is on monday". Only used for the visible ack - the stored fact keeps
 * his own words, since her notes read them as a quote from him.
 */
export function toHerVoice(fact) {
  return String(fact)
    .replace(/\bi'm\b/gi, "youre")
    .replace(/\bi've\b/gi, "youve")
    .replace(/\bi'll\b/gi, "youll")
    .replace(/\bi\b/gi, "you")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bmine\b/gi, "yours")
    .replace(/\bmyself\b/gi, "yourself")
    .replace(/\bme\b/gi, "you")
    .replace(/\bam\b/gi, "are");
}

/**
 * He corrected her. The old version is not just joined by the new one - it is
 * wrong, and a person who keeps both is worse than one who remembers nothing.
 * Returns how many stale entries were dropped.
 */
export function supersedeFacts(corrected, fresh = [], target = state) {
  let dropped = 0;
  for (const old of corrected || []) {
    const needle = normalizeFact(old).toLowerCase();
    if (needle.length < 4) continue;
    const before = target.facts.length;
    target.facts = target.facts.filter((f) => {
      const low = f.toLowerCase();
      return !(low.includes(needle) || needle.includes(low) || sameTopic(f, old));
    });
    dropped += before - target.facts.length;
  }
  // the replacement has to land where the correction came from: passing a target
  // and having the new fact written into the module state instead would leave the
  // caller with the old version gone and the new one missing entirely
  if (dropped) addFacts(fresh, target);
  return dropped;
}

/**
 * The one regeneration her reply was allowed to make, counted. If this number
 * creeps up, the model is missing his questions or drifting into assistant voice;
 * if it is always zero, the check has stopped seeing anything.
 */
export function noteVerifyRetry(kind, at = Date.now()) {
  const today = nowBerlin(new Date(at)).dateStr;
  if (state.verify?.date !== today) state.verify = { date: today, count: 0, kinds: { question: 0, assistant: 0 } };
  state.verify.count += 1;
  state.verify.kinds[kind] = (state.verify.kinds[kind] || 0) + 1;
  saveSoon();
  return state.verify;
}

export function verifyToday(at = Date.now()) {
  const today = nowBerlin(new Date(at)).dateStr;
  return state.verify?.date === today ? state.verify : { date: today, count: 0, kinds: { question: 0, assistant: 0 } };
}

/** Which photo she sent, so the same one does not come round again tomorrow. */
export function noteHerPhoto(file, at = Date.now()) {
  state.herPhotos = [...(state.herPhotos || []), { file, at }].slice(-12);
  saveSoon();
}

export function recentHerPhotos(limit = 6) {
  return (state.herPhotos || []).slice(-limit);
}

export function forgetFact(part, target = state) {
  const needle = normalizeFact(part).toLowerCase();
  if (!needle) return false;
  const at = target.facts.findIndex((f) => f.toLowerCase().includes(needle));
  if (at === -1) return false;
  target.facts.splice(at, 1);
  return true;
}

// --------------------------------------------------------- overnight queue
// He texted while she was asleep. The reply is planned for the morning and must
// survive a restart (the supervisor restarts her for exactly this kind of thing),
// so the pending messages live in state.json until they are finally answered.
export function addOvernight(items = []) {
  for (const item of items) {
    if (!item?.id || !item.text) continue;
    if (state.overnight.some((x) => x.id === item.id)) continue;
    state.overnight.push({ id: item.id, text: String(item.text).slice(0, 200), ts: item.ts || Date.now() });
  }
  while (state.overnight.length > 12) state.overnight.shift();
  saveSoon();
}

export function takeOvernight() {
  const items = state.overnight;
  state.overnight = [];
  if (items.length) saveSoon();
  return items;
}

export function overnightCount() {
  return state.overnight.length;
}

// ------------------------------------------------------ left on read
// When she reads something and says nothing it is not lost: it waits here until
// she brings it up herself, or until he writes again.
export function addUnanswered(items = []) {
  const keep = TIMING_DEFAULTS.unansweredKeep || 6;
  for (const item of items) {
    if (!item?.id || !item.text) continue;
    if (state.unanswered.some((x) => x.id === item.id)) continue;
    state.unanswered.push({ id: item.id, text: String(item.text).slice(0, 160), ts: item.ts || Date.now() });
  }
  while (state.unanswered.length > keep) state.unanswered.shift();
  saveSoon();
}

/** Take up to n of the oldest unanswered messages (they are gone once she has seen them again). */
/** Remember what he sent, so a later reply can be hung on any of his messages. */
export function pushInbox(entry) {
  if (!entry?.id || !entry.text) return;
  if (state.inbox.some((x) => x.id === entry.id)) return;
  state.inbox.push({ id: entry.id, text: String(entry.text).slice(0, 200), ts: entry.ts || Date.now() });
  while (state.inbox.length > INBOX_KEEP) state.inbox.shift();
  saveSoon();
}

/** His recent messages, newest first, optionally ignoring the ids being answered now. */
export function recentInbox(limit = 6, excludeIds = []) {
  const skip = new Set(excludeIds.map(Number));
  return state.inbox.filter((x) => !skip.has(Number(x.id))).slice(-limit).reverse();
}

/** He edited a message: the record has to change, not grow a second copy. */
export function updateInbox(entry) {
  if (!entry?.id) return false;
  const at = state.inbox.findIndex((x) => Number(x.id) === Number(entry.id));
  if (at === -1) {
    pushInbox(entry);
    return true;
  }
  state.inbox[at] = { ...state.inbox[at], text: String(entry.text).slice(0, 200), ts: entry.ts || state.inbox[at].ts };
  saveSoon();
  return true;
}

export function findInbox(id) {
  const wanted = Number(id);
  return state.inbox.find((x) => Number(x.id) === wanted) || state.unanswered.find((x) => Number(x.id) === wanted) || null;
}

/** Remember her own sent messages, so a thread he replies into is recognisable. */
export function pushSent(entry) {
  if (!entry?.id || !entry.text) return;
  state.sent.push({ id: Number(entry.id), text: String(entry.text).slice(0, 200), ts: Date.now() });
  while (state.sent.length > INBOX_KEEP) state.sent.shift();
  saveSoon();
}

/** Her own last few bubbles, so she can hear herself repeat a point. */
export function recentSent(limit = 8) {
  return state.sent.slice(-limit);
}

/** Any message in either direction, by id - used when he replies to something specific. */
export function findAnyMessage(id) {
  const wanted = Number(id);
  const mine = state.sent.find((x) => Number(x.id) === wanted);
  if (mine) return { id: wanted, text: mine.text, mine: true };
  const his = findInbox(wanted);
  return his ? { id: wanted, text: his.text, mine: false } : null;
}

export function takeUnanswered(n = 2) {
  // anything older than a day is stale - claiming he "never answered" it would be a lie
  const cutoff = Date.now() - 24 * 3600000;
  state.unanswered = state.unanswered.filter((x) => (x.ts || 0) >= cutoff);
  if (!state.unanswered.length) return [];
  return state.unanswered.splice(0, Math.max(0, n));
}

/** Specific entries are answered (he replied in that thread) - drop them. */
export function clearUnanswered(ids = []) {
  if (!ids.length || !state.unanswered.length) return;
  const skip = new Set(ids.map(Number));
  const before = state.unanswered.length;
  state.unanswered = state.unanswered.filter((x) => !skip.has(Number(x.id)));
  if (state.unanswered.length !== before) saveSoon();
}

// ------------------------------------------------------- her open questions
// The single most robotic habit a chatbot has is asking the same question again
// after it was answered. A question she asked is given 30 minutes of room; the
// next thing he sends after that settles it - answered or not, she does not poke
// it a second time. A real girl changes the subject instead.
const SETTLE_AFTER_MS = 30 * 60000;
const QUESTION_TTL_MS = 8 * 3600000;

export function noteHerQuestion(text) {
  const today = nowBerlin().dateStr;
  for (const line of String(text || "").split(/\n+/)) {
    if (!line.includes("?")) continue;
    const q = line.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!q) continue;
    // per-day ask history: the same topic asked AGAIN the same day counts toward
    // the repetition cap - asked twice with no real answer means it goes on the
    // shelf. A girl who asks a third time is a form, not a person. Reworded
    // questions ("how are you" vs "how are you feeling") are the same topic.
    const prev = state.askLog.find((x) => x.date === today && sameTopic(x.text, q));
    if (prev) {
      prev.asks += 1;
      if (prev.asks >= 2) shelveTopic(q, "asked twice today, he was not having it");
    } else if (!state.dropped.some((x) => x.date === today && sameTopic(x.text, q))) {
      // a shelved topic never re-enters the ask log - the shelf holds for today
      state.askLog.push({ text: q, date: today, asks: 1, ts: Date.now() });
    }
    if (!state.openQuestions.some((x) => sameTopic(x.text, q)) && !state.dropped.some((x) => x.date === today && sameTopic(x.text, q))) {
      state.openQuestions.push({ text: q, ts: Date.now() });
    }
  }
  while (state.openQuestions.length > 10) state.openQuestions.shift();
  while (state.askLog.length > 16) state.askLog.shift();
  saveSoon();
}

/** Her questions from today, newest first - what a refusal would be about. */
export function lastAsked() {
  const today = nowBerlin().dateStr;
  return state.askLog.filter((x) => x.date === today).slice().reverse();
}

/** He said something: questions she asked a while ago are closed now. */
export function settleOpenQuestions() {
  if (!state.openQuestions.length) return;
  const cutoff = Date.now() - SETTLE_AFTER_MS;
  const before = state.openQuestions.length;
  state.openQuestions = state.openQuestions.filter((q) => (q.ts || 0) >= cutoff);
  if (state.openQuestions.length !== before) saveSoon();
}

/** Questions still genuinely fresh and unanswered (for display). */
export function openQuestions() {
  const cutoff = Date.now() - QUESTION_TTL_MS;
  const keep = state.openQuestions.filter((q) => (q.ts || 0) >= cutoff);
  if (keep.length !== state.openQuestions.length) {
    state.openQuestions = keep;
    saveSoon();
  }
  return keep;
}

// ------------------------------------------------------- dropped topics
// A no is a no - for today. When he shuts a question down ("fuck off", "i dont
// wanna answer that") or she has asked the same thing twice with no answer, the
// topic goes on the shelf until TOMORROW. People change by morning; a bot that
// re-asks is not a person. He can always invite it back ("ask me about it").
const TOPIC_STOP = new Set(
  "the a an and or but of to in on at is are was were be am i you he she it my your me we they us for with about that this these those so just not no do does did done have has had will would can could should what how when where who why ok yeah hey hm hmm like really very much more most some any got get go goes going went know think thinks said says say thing things today tonight tomorrow yesterday because bit lot way now then there here one two".split(" "),
);

function topicWords(text) {
  const words = String(text || "").toLowerCase().match(/[a-z0-9']{2,}/g) || [];
  return new Set(words.filter((w) => !TOPIC_STOP.has(w)));
}

/**
 * Same topic even when reworded: "how are you" vs "how are you feeling". Short
 * texts are made of function words entirely, so they compare raw word sets at a
 * strict bar; longer texts compare meaningful keywords at a looser one.
 */
export function sameTopic(a, b) {
  const rawA = String(a || "").toLowerCase().match(/[a-z0-9']{2,}/g) || [];
  const rawB = String(b || "").toLowerCase().match(/[a-z0-9']{2,}/g) || [];
  if (!rawA.length || !rawB.length) return false;
  const short = Math.min(rawA.length, rawB.length) <= 5;
  const sa = new Set(short ? rawA : rawA.filter((w) => !TOPIC_STOP.has(w)));
  const sb = new Set(short ? rawB : rawB.filter((w) => !TOPIC_STOP.has(w)));
  if (!sa.size || !sb.size) return false;
  let hits = 0;
  for (const w of sa) if (sb.has(w)) hits += 1;
  // either set covering the other is the same topic, however the words split
  return hits / Math.min(sa.size, sb.size) >= (short ? 0.65 : 0.5) || hits / Math.max(sa.size, sb.size) >= 0.6;
}

export function shelveTopic(text, why = "") {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!t) return false;
  const today = nowBerlin().dateStr;
  if (!state.dropped.some((x) => x.date === today && sameTopic(x.text, t))) {
    state.dropped.push({ text: t, date: today, why: why || "he was not having it", ts: Date.now() });
    while (state.dropped.length > 8) state.dropped.shift();
  }
  state.openQuestions = state.openQuestions.filter((x) => !sameTopic(x.text, t));
  saveSoon();
  return true;
}

/** Today's shelved topics - expired ones fall off by themselves. */
export function droppedTopics() {
  const today = nowBerlin().dateStr;
  const keep = state.dropped.filter((x) => x.date === today);
  if (keep.length !== state.dropped.length) {
    state.dropped = keep;
    saveSoon();
  }
  return keep;
}

/** He invited questions ("ask me about the exam") - matching shelves lift. */
export function reopenTopics(hisText) {
  const drops = droppedTopics();
  if (!drops.length) return 0;
  const generic = /\b(anything|everything|whatever|ask away|go ahead)\b/i.test(hisText);
  let cleared = 0;
  for (const d of drops) {
    // an invite mentioning a keyword of the shelved topic re-opens exactly that
    // one ("ask me about the chocolate"); a blanket invite lifts everything
    const topicWords2 = String(d.text || "").toLowerCase().match(/[a-z0-9']{3,}/g) || [];
    const named = topicWords2.some((w) => new RegExp(`\\b${w.replace(/[']/g, "'")}`, "i").test(hisText));
    if (generic || named || sameTopic(d.text, hisText)) {
      state.dropped = state.dropped.filter((x) => x !== d);
      cleared += 1;
    }
  }
  if (cleared) saveSoon();
  return cleared;
}

// ------------------------------------------------------------- promises
// "i'll text you when i'm ready", "you owe me a story", "deal?" - what he and she
// actually committed to, tracked so her "i never forget" is a fact and not a bit.
export function addPromise({ text, by, dueAt = null } = {}) {
  const what = String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (!what || (by !== "him" && by !== "her")) return false;
  if (state.promises.some((p) => !p.done && p.text === what && p.by === by)) return false;
  state.promises.push({ text: what, by, madeAt: Date.now(), dueAt: dueAt || null, done: false, followedUp: false });
  while (state.promises.length > 30) state.promises.shift();
  saveSoon();
  return true;
}

/** Open promises, dropping finished ones older than three days. */
export function openPromises(by = null) {
  const cutoff = Date.now() - 3 * 86400000;
  const kept = state.promises.filter((p) => !p.done || p.madeAt >= cutoff);
  if (kept.length !== state.promises.length) {
    state.promises = kept;
    saveSoon();
  }
  return state.promises.filter((p) => !p.done && (by === null || p.by === by));
}

// ------------------------------------------------------------- her canon
// She invents a life constantly - stories, songs, opinions, the flat, the friends.
// Without a canon of her own the inventions evaporate and eventually contradict
// each other. With one, she stays consistent and callbacks become possible.
export function addCanon(list = []) {
  for (const raw of list) {
    const fact = String(raw || "").replace(/\s+/g, " ").trim();
    if (fact.length < 6 || fact.length > 160) continue;
    if (state.herCanon.some((f) => f.toLowerCase() === fact.toLowerCase())) continue;
    state.herCanon.push(fact);
  }
  while (state.herCanon.length > 40) state.herCanon.shift();
}

// ------------------------------------------------------------- media memory
// One line per photo/video he sent, so weeks later she can bring one back up.
export function addMediaMemory({ label, desc = "" } = {}) {
  const text = String(label || "").slice(0, 140);
  if (!text) return;
  if (state.mediaLog.some((x) => x.label === text && Date.now() - x.ts < 60000)) return;
  state.mediaLog.push({ label: text, desc: String(desc || "").slice(0, 140), ts: Date.now() });
  while (state.mediaLog.length > 40) state.mediaLog.shift();
  saveSoon();
}

// ------------------------------------------------------------- storylines
export function setStorylines(list = []) {
  const clean = (list || [])
    .map((s) => ({ title: String(s?.title || "").slice(0, 60), beat: String(s?.beat || "").slice(0, 140) }))
    .filter((s) => s.title && s.beat)
    .slice(0, 3);
  if (!clean.length) return;
  state.storylines = clean;
  state.storylinesOn = nowBerlin().dateStr;
}

// ------------------------------------------------------------- holds
/** Quiet mode: she will not text first until this instant. */
export function quiet() {
  return state.quietUntil > Date.now() ? state.quietUntil : 0;
}

/** He said he is coming back later: her initiations hold until then. */
export function holding() {
  return state.holdUntil > Date.now() ? state.holdUntil : 0;
}

export function noteInitiation() {
  state.initiations = (state.initiations || 0) + 1;
  saveSoon();
}

export function resetInitiations() {
  if (state.initiations) {
    state.initiations = 0;
    saveSoon();
  }
}

const INBOX_KEEP = 12;

export function unansweredCount() {
  return state.unanswered.length;
}

export function takeSummaryChunk(count) {
  const chunk = history.slice(0, count);
  history = history.slice(count);
  return chunk;
}

export function restoreHistory(chunk) {
  history = [...chunk, ...history];
  save();
}

export function resetMemory() {
  const { ownerId, ownerName, boundAt } = state;
  state = { ...defaults(), ownerId, ownerName, boundAt };
  history = [];
  save();
}

// ------------------------------------------------------- smarter fact recall
// Facts used to be "the last 12". Now the ones that share words with what he is
// talking about come first, recency fills the rest - memory that feels aimed
// instead of rolled.
const STOP_WORDS = new Set(
  "the a an and or but of to in on at is are was were be am i you he she it my your me we they us for with about that this these those so just not no do does did done have has had will would can could should what how when where who why ok yeah hey hm hmm like really very much more most some any got get go goes going went know thinks think said says say thing things today tonight tomorrow yesterday because bit lot way now then there here one two".split(" "),
);

export function pickFacts(about = "", limit = 12) {
  const facts = state.facts || [];
  if (facts.length <= limit) return facts.slice(-limit);
  const want = new Set(String(about || "").toLowerCase().match(/[a-z0-9']{3,}/g) || []);
  const scored = facts.map((f, i) => {
    const fw = f.toLowerCase().match(/[a-z0-9']{3,}/g) || [];
    let hits = 0;
    for (const w of fw) if (want.has(w) && !STOP_WORDS.has(w)) hits += 1;
    return { f, score: hits * 100 + i }; // recency is the baseline, relevance wins
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(-limit).map((x) => x.f);
}

// ---------------------------------------------------------------- day cards
/** One line per finished day, assembled from data that is already on disk.
 *  No model call: the intimacy here is in the remembering, not the prose. */
const WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** His messages contribute to today's card: how much, what about, and how he was. */
export function noteDayStat({ his = 0, hers = 0, media = 0, text = "", signals = null, tension = false } = {}) {
  const key = nowBerlin().dateStr;
  const prev = state.dayStats?.[key] || { his: 0, hers: 0, media: 0, mood: null, topics: {}, tone: null, rough: false, funny: false, tension: false };
  const stats = { ...prev, topics: { ...(prev.topics || {}) } };
  stats.his += his;
  stats.hers += hers;
  stats.media += media;
  if (state.mood?.key) stats.mood = state.mood.key;
  if (state.tone?.key) stats.tone = state.tone.key;
  if (signals?.serious) stats.rough = true;
  if (signals?.funny) stats.funny = true;
  if (tension) stats.tension = true;
  if (text) {
    for (const w of contentWords(text).slice(0, 24)) stats.topics[w] = (stats.topics[w] || 0) + 1;
  }
  state.dayStats = { ...(state.dayStats || {}), [key]: stats };
  saveSoon();
  return stats;
}

/**
 * Everything that made a day what it was, so the line she remembers tomorrow has
 * his side in it and not just a message count.
 */
function composeCard(date, s) {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const bits = [`${s.his} message${s.his === 1 ? "" : "s"} from him`];
  if (s.media) bits.push(`${s.media} photo/voice note${s.media === 1 ? "" : "s"}`);
  const topics = Object.entries(s.topics || {})
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  const about = topics.length ? `mostly about ${topics.join(", ")}` : "";
  const howHeWas = s.rough ? "he was having a rough one" : s.funny ? "a lot of laughing" : "";
  const middle = [about, howHeWas].filter(Boolean).join(", ");
  const flavour = s.his >= 15 ? "he was around all day" : s.his <= 2 ? "he was quiet" : "";
  const ended = s.tension ? "you two ended the day not quite right with each other" : "";
  const tail = [s.mood ? `you were ${s.mood}` : "", flavour, ended].filter(Boolean).join(", ");
  return `${weekday} ${String(d).padStart(2, "0")} - ${bits.join(" and ")}${middle ? ` (${middle})` : ""}${tail ? `, ${tail}` : ""}`;
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Close yesterday's card once a day, and forget the raw counters behind it. A day
 * counts only if the two of them actually talked in it - inventing a card for a
 * day she was switched off would be a memory she never had.
 */
export function rollDayCards(t = nowBerlin()) {
  if (state.dayCardsRolledOn === t.dateStr) return null;
  const yesterday = addDaysStr(t.dateStr, -1);
  const cards = state.dayCards || [];
  const stats = state.dayStats?.[yesterday];
  let made = null;
  if (!cards.some((c) => c.date === yesterday) && stats && (stats.his || stats.hers)) {
    made = { date: yesterday, line: composeCard(yesterday, stats) };
    state.dayCards = [...cards, made].slice(-Math.max(1, Number(CONFIG.memory?.dayCardsKeep ?? 1)));
  }
  // keep a couple of days of raw counters (the card above), drop the rest
  const keep = new Set([yesterday, t.dateStr, addDaysStr(t.dateStr, -2)]);
  state.dayStats = Object.fromEntries(Object.entries(state.dayStats || {}).filter(([k]) => keep.has(k)));
  state.dayCardsRolledOn = t.dateStr;
  saveSoon();
  return made;
}

export function recentDayCards(limit = 5) {
  return (state.dayCards || []).slice(-limit);
}

export function bindOwner(id, name) {
  state.ownerId = id;
  state.ownerName = name || "Commander";
  state.boundAt = Date.now();
  save();
}
