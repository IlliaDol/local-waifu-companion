// Reactions - the channel that was dead in both directions.
//
// A heart on a message is a real thing people do: it is how you answer without
// answering, and it is how you notice that someone read what you said. The bot
// subscribed to `message` updates only, so his hearts were invisible to her, and
// she had no way at all to be present without writing - her only two options were
// a message or total silence.
//
// Now: his reaction is read as the signal it is (she saw it), and on a read-and-
// nothing-to-add moment a warm girl leaves a heart instead of words. That second
// half is the more human one - it is the difference between "she didn't answer"
// and "she read it and smiled at me", and it costs zero model calls.
//
// The emoji rule is not broken by this: her TEXT still never contains one emoji,
// kaomoji or text-face. A reaction is a separate gesture, and it is deliberately
// the only one she has - exactly like the bare `)` and the `<3` before it.
import { tg } from "./media.js";
import { nowBerlin, log, logErr } from "./util.js";

/** The reaction a bot may not use: fewer than this and it is a habit, not a gesture. */
const HEART_EMOJIS = new Set(["❤", "❤️", "😍", "😘", "💕", "💖", "🖤", "🩷"]);
export const DAY_LIMIT = 3; // spontaneous reactions a day, across both paths - a gesture, not a feed

// ------------------------------------------------------------------ her taste
// Which reaction fits RIGHT NOW is a mood thing crossed with what the message
// is. All free, all local: no model call decides an emoji.

/** What the message itself is about, from its words only. */
export function readTopicForReaction(text = "") {
  const low = String(text || "").toLowerCase();
  if (!low.trim()) return "none";
  if (/haha+|lol+|lmao|\bxd+\b|😂|🤣|\bfunny\b|\bjoke\b|\bmemes?\b/.test(low)) return "funny";
  if (/\b(got the job|got in|passed|won|promoted|accepted|an offer|nailed|crushed|pumped|hyped|guess what|lets go+|let'?s go+)\b/.test(low) || /!{2,}/.test(low)) return "exciting";
  if (/\b(miss you|missed you|love you|goodnight|good night|night commander|hug|kiss|thinking of you)\b|❤|💕/.test(low)) return "affection";
  return "none";
}

/** What she reaches for, per mood, when the message gives no other hint. */
const SPONTANEOUS_WEIGHTS = {
  soft:    { "❤": 0.62, "😍": 0.18, "🔥": 0.12, "😂": 0.08 },
  clingy:  { "❤": 0.55, "😍": 0.15, "😂": 0.18, "🔥": 0.12 },
  warm:    { "❤": 0.45, "😂": 0.25, "🔥": 0.20, "😍": 0.10 },
  chaotic: { "😂": 0.45, "🔥": 0.35, "❤": 0.15, "😍": 0.05 },
  wired:   { "🔥": 0.40, "😂": 0.40, "❤": 0.20 },
  tired:   { "👍": 0.65, "❤": 0.35 },
  // sulky and distant react to nothing: they answer, flatly, or not at all
};

/** How a clear message topic bends that choice. */
const TOPIC_WEIGHTS = {
  funny:     { "😂": 4, "🔥": 0.6, "❤": 0.6, "😍": 0.6, "👍": 0.6 },
  exciting:  { "🔥": 4, "😍": 1.5, "😂": 0.6, "❤": 0.6, "👍": 0.8 },
  affection: { "❤": 2.5, "😍": 2.5, "😂": 0.5, "🔥": 0.5, "👍": 0.3 },
};

function weightedPick(weights, random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (!entries.length) return null;
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let roll = random() * total;
  for (const [emoji, w] of entries) {
    roll -= w;
    if (roll <= 0) return emoji;
  }
  return entries[0][0];
}

/**
 * The emoji she leaves when nobody asked for it: her mood picks the base mix,
 * the message's topic bends it, and whatever she used last time is played down
 * so the same girl does not heart five messages in a row - the mix drifts as
 * her mood drifts through the day.
 */
export function pickSpontaneousEmoji(moodKey, topic = "none", { lastEmoji = "", random = Math.random } = {}) {
  const base = SPONTANEOUS_WEIGHTS[moodKey];
  if (!base) return null;
  const bend = TOPIC_WEIGHTS[topic] || {};
  const weights = {};
  for (const [emoji, w] of Object.entries(base)) {
    weights[emoji] = w * (bend[emoji] ?? 1);
  }
  if (lastEmoji && weights[lastEmoji] !== undefined) weights[lastEmoji] *= 0.25;
  return weightedPick(weights, random);
}

/** The odds she reacts at all while reading, before her reply comes later. */
export function spontaneousChance(moodKey, topic = "none") {
  const base = { soft: 0.14, clingy: 0.12, warm: 0.10, chaotic: 0.08, wired: 0.06, tired: 0.04 }[moodKey] || 0;
  // a mood with no base never gets one from the topic: sulky and distant
  // answer (flatly) or do not react, whatever the message is
  if (base <= 0) return 0;
  return Math.min(0.35, base + (topic !== "none" ? 0.06 : 0));
}

export function shouldReactWhileReading(state, moodView, { topic = "none", random = Math.random } = {}) {
  if (!state || state.reactionStyle === "off") return false;
  const chance = spontaneousChance(moodView?.key, topic);
  if (chance <= 0) return false;
  const today = nowBerlin().dateStr;
  const sent = state.reactionsSent?.date === today ? state.reactionsSent.count || 0 : 0;
  if (sent >= DAY_LIMIT) return false;
  return random() < chance;
}

/**
 * The "she saw it" moment on a message she WILL answer later: the reaction goes
 * on now, the words come in 20-75 minutes. Read, appreciated, answer coming -
 * the same order a person does it in.
 */
export async function reactWhileReading(state, chatId, message, moodView, { dry = false, random = Math.random } = {}) {
  const topic = readTopicForReaction(message?.text || message?.caption || "");
  if (!shouldReactWhileReading(state, moodView, { topic, random })) return false;
  const id = message?.message_id;
  if (!id) return false;
  const emoji = pickSpontaneousEmoji(moodView?.key, topic, { lastEmoji: state.lastReactionEmoji, random });
  if (!emoji) return false;
  if (dry) {
    log(`[reaction] (dry-run) she would leave ${emoji} on message ${id} (${topic}) while the answer waits`);
    return true;
  }
  const ok = await send(state, chatId, id, emoji);
  if (!ok) return false;
  noteSent(state);
  state.lastReactionEmoji = emoji;
  log(`[reaction] she read it and left ${emoji} on message ${id} (${topic}) - the reply still comes later`);
  return true;
}

/** Reaction arrays come as [{ type: "emoji", emoji: "❤" }] or (older) ["❤"]. */
export function extract(list = []) {
  const out = [];
  for (const item of list || []) {
    if (!item) continue;
    if (typeof item === "string") out.push(item);
    else if (item.type === "emoji" && item.emoji) out.push(item.emoji);
    else if (item.type === "paid") out.push("⭐");
    // custom_emoji: a sticker of his own making, worthless as a signal here
  }
  return out;
}

export function isHeart(emoji = "") {
  return HEART_EMOJIS.has(String(emoji)) || String(emoji).includes("❤");
}

export function isPositive(emoji = "") {
  return isHeart(emoji) || ["👍", "🔥", "😂", "🤣", "💯", "🥰", "😊"].includes(String(emoji));
}

/** Which of her reactions does the server actually take? Learned once, like quotes. */
function styles(state) {
  const known = state?.reactionStyle;
  if (known === "object" || known === "string") return [known];
  if (known === "off") return [];
  return ["object", "string"];
}

function reactionField(style, emoji) {
  return style === "string"
    ? { reaction: emoji ? [emoji] : [] }
    : { reaction: emoji ? [{ type: "emoji", emoji }] : [] };
}

/**
 * Leave a reaction on one of his messages (or clear it with emoji = ""). Tries
 * both shapes the API has taken, remembers the one that worked, and gives up
 * quietly after both are refused - a refused reaction must never cost her
 * anything, and must never be retried on every single message either.
 */
export async function send(state, chatId, messageId, emoji = "❤") {
  if (!chatId || !messageId) return false;
  const known = styles(state);
  if (!known.length) return false;
  for (const style of known) {
    const params = { chat_id: chatId, message_id: messageId, ...reactionField(style, emoji) };
    const res = await tg("setMessageReaction", params);
    if (res.ok) {
      if (state.reactionStyle !== style) {
        state.reactionStyle = style;
        log(`[reaction] telegram reactions use the ${style} form`);
      }
      return true;
    }
    logErr(`[reaction] refused (${style}):`, res.error);
  }
  state.reactionStyle = "off";
  log("[reaction] this telegram install refused both reaction shapes - she just won't react, nothing else changes");
  return false;
}

/** His reaction on one of her bubbles, remembered so she can say something about it. */
export function noteHis(state, rx, { herText = "", ownerId = null } = {}) {
  if (!state || !rx) return null;
  if (ownerId && rx.chat?.id !== ownerId) return null;
  const added = extract(rx.new_reaction);
  const before = extract(rx.old_reaction);
  const fresh = added.find((e) => !before.includes(e));
  if (!fresh) {
    // he took it back - she is not going to make a scene out of that
    if (state.hisReaction?.messageId === rx.message_id && !added.length) state.hisReaction = null;
    return null;
  }
  // telegram can re-deliver an update after a hiccup; the same heart is not news
  const prior = state.hisReaction;
  if (prior && prior.messageId === rx.message_id && prior.emoji === fresh) return prior;
  state.hisReaction = {
    emoji: fresh,
    positive: isPositive(fresh),
    messageId: rx.message_id,
    text: String(herText || "").slice(0, 140),
    at: Date.now(),
    acknowledged: false,
  };
  return state.hisReaction;
}

/** The pending reaction is spoken for - her next reply mentions it. */
export function acknowledge(state) {
  if (state?.hisReaction) state.hisReaction.acknowledged = true;
}

/**
 * Read it, say nothing, and leave a heart on it. Mood-gated exactly like her
 * hearts are (a sulky or tired girl does not do this), capped per day, and only
 * when the server has taken a reaction before or is still willing to try.
 */
export function shouldHeartInsteadOfWords(state, moodView, random = Math.random) {
  if (!state) return false;
  if (state.reactionStyle === "off") return false;
  const moodKey = moodView?.key;
  if (moodKey !== "warm" && moodKey !== "clingy" && moodKey !== "soft") return false;
  const today = nowBerlin().dateStr;
  const sent = state.reactionsSent?.date === today ? state.reactionsSent.count || 0 : 0;
  if (sent >= DAY_LIMIT) return false;
  // the same odds her typed heart rides on: soft 22%, clingy 17%, warm 14%
  return random() < Math.min(0.5, (moodView?.def?.heart ?? 0.05) + 0.1);
}

/*
 * "put a reaction on my message" - an explicit request. A reaction a person asks
 * for is done, not rolled for: the moods above decide when she does it UNPROMPTED,
 * and this decides whether he just asked. Matched on message-level phrases ("react
 * to this", "leave a heart") and on react-verb + emoji-name, so "how do you react
 * to that news" or "chemical reaction" never fire it. The target is whatever the
 * request was sent as a reply to, or his own last message.
 */
const EMOJI_WORDS = {
  heart: "❤",
  thumbs: "👍",
  fire: "🔥",
  laugh: "😂",
  star: "⭐",
};

export function parseRequest(text = "") {
  const low = String(text || "").toLowerCase().replace(/[!?.]+$/g, "").trim();
  if (!low) return null;
  // the whole message must be the request: a girl does not treat "you never
  // react to my jokes" as an instruction
  const onMine = /(?:put|drop|leave|add|give)\s+(?:a\s+|an\s+|some\s+|your\s+)?(?:heart\s+)?(?:reaction|react|heart|like|thumbs\s?up)\s+(?:on|to|under)\b/.test(low)
    || /^(?:leave|drop)\s+a\s+heart\b/.test(low)
    || /^(?:heart|like)\s+(?:this|that|it|my|the)\b/.test(low);
  const reactTo = /^(?:react|reply)\s+to\s+(?:this|that|it|my message|the message)\b/.test(low);
  const emojiWord = Object.keys(EMOJI_WORDS).find((w) => new RegExp(`\\b(?:put|drop|leave|add|give|send)\\b[^\\n]{0,24}\\b${w}\\b`).test(low)
    || new RegExp(`\\b${w}\\b[^\\n]{0,16}\\b(?:reaction|on this|on that|on it|on my)\\b`).test(low));
  if (!onMine && !reactTo && !emojiWord) return null;
  // she only has one gesture, and it is not a thumbs-up robot: a named emoji is
  // honoured when the server takes it, anything else is the heart she owns
  return { emoji: emojiWord ? EMOJI_WORDS[emojiWord] : "❤" };
}

/**
 * The message id a reaction request points at: the message he replied to, else
 * the request itself. NOT the stored inbox - a request never goes through the
 * normal enqueue, so the inbox's "newest" entry is stale by the time he asks,
 * and the heart would land on an older message far up the scrollback (bug found
 * live: "put reaction on my message" put ❤ on a message from the day before).
 */
export function targetOf(requestMsg) {
  const explicit = Number(requestMsg?.reply_to_message?.message_id || 0);
  if (explicit) return explicit;
  return Number(requestMsg?.message_id || 0);
}

export function noteSent(state, at = Date.now()) {
  const today = nowBerlin(new Date(at)).dateStr;
  if (state.reactionsSent?.date !== today) state.reactionsSent = { date: today, count: 0 };
  state.reactionsSent.count += 1;
}

/**
 * The whole "she saw it and did not write" moment. Returns true when a heart
 * actually went out, so the log tells the difference between the three outcomes
 * a human has here: answered, hearted, and plain silence.
 */
export async function heartInsteadOfWords(state, chatId, message, moodView, { dry = false, random = Math.random } = {}) {
  if (!shouldHeartInsteadOfWords(state, moodView, random)) return false;
  const id = message?.message_id;
  if (!id) return false;
  if (dry) {
    log(`[reaction] (dry-run) she would leave a ❤ on message ${id} and say nothing`);
    return true;
  }
  const ok = await send(state, chatId, id, "❤");
  if (!ok) return false;
  noteSent(state);
  log(`[reaction] she read it and left a ❤ on message ${id} instead of words`);
  return true;
}

/** One line for /status. */
export function describe(state) {
  const known = state?.reactionStyle;
  const sent = state?.reactionsSent?.date === nowBerlin().dateStr ? state.reactionsSent.count : 0;
  const style = known === "off"
    ? "not available here (his side still works)"
    : known
      ? `yes (${known} form)`
      : "works out the API form on first use";
  const his = state?.hisReaction ? ` | he left ${state.hisReaction.emoji} on your message${state.hisReaction.acknowledged ? " (mentioned)" : " (not mentioned yet)"}` : "";
  return `${style}, ${sent}/${DAY_LIMIT} hearts used today${his}`;
}
