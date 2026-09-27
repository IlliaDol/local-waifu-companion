// Negev-chan - private Telegram girlfriend bot.
// Zero dependencies. Node 20+.
import "./dotenv.js"; // .env secrets first, before anything reads process.env
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG, PATHS } from "./config.js";
import * as mem from "./memory.js";
import { llm, tidyReply, imagePart, textPart, currentModel, setUsageSink } from "./deepseek.js";
import * as usage from "./usage.js";
import * as media from "./media.js";
import { acquireLock, releaseLock, lockStatus } from "./lock.js";
import { extractUrls, readPost, downloadRemote } from "./links.js";
import { startProactive, stopProactive, currentWindow, announceBusy, busySummary, maybeStepAway } from "./proactive.js";
import { planReaction, reactionNote, gapWords, wakePlan, wantsHesitation } from "./timing.js";
import * as mood from "./mood.js";
import * as signal from "./signal.js";
import * as bond from "./bond.js";
import * as reactions from "./reactions.js";
import * as voice from "./voice.js";
import * as photos from "./photos.js";
import * as style from "./style.js";
import * as tasks from "./tasks.js";
import * as weather from "./weather.js";
import * as identity from "./identity.js";
import * as roadmap from "./data-science.js";
import * as settings from "./settings.js";
import * as internals from "./bot-internals.js";
import { startPanel } from "./panel.js";
// (named `nights` because util.js already exports a sleep() timer)
import * as nights from "./sleep.js";
import {
  SYSTEM_BASE, contextBlock, MEMORY_LINE_RULE, FIRST_MEET_HINT, WELCOME_BACK, RESET_LINE,
  FALLBACK, WATCH_TEASER, factsPrompt, summaryPrompt, welcomeLine, unansweredBlock, quoteBlock,
  NOTE_PREAMBLE, repeatBlock, threadsBlock, canonBlock, mediaBlock, recapPrompt,
  toneBlock, reactionBlock, bondBlock, dayCardsBlock, correctionBlock, editBlock, photoPrompt,
  sharedPastBlock, DS_MENTOR_BLOCK,
} from "./persona.js";
import { nowBerlin, sleep, rand, clamp, pick, splitBubbles, truncate, setLogSink, log, logErr } from "./util.js";

const tg = media.tg;

// ------------------------------------------------------- file log for 24/7
// The bot logs itself, so a hidden launch needs no shell redirection (and two
// copies can never deadlock over a log file one of them holds open).
const LOG_FILE = path.join(PATHS.data, "negev.log");

function initFileLog() {
  fs.mkdirSync(PATHS.data, { recursive: true });
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1_000_000) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
    }
  } catch { /* keep appending, rotation is best-effort */ }
  setLogSink((line) => {
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* ignore */ }
  });
}

let offset = 0;
let typingTimer = null;
let teaserTimer = null;

// ------------------------------------------------------------- sending

function startTyping(chatId) {
  tg("sendChatAction", { chat_id: chatId, action: "typing" });
  clearInterval(typingTimer);
  typingTimer = setInterval(() => tg("sendChatAction", { chat_id: chatId, action: "typing" }), 4500);
  return () => {
    clearInterval(typingTimer);
    typingTimer = null;
  };
}

// A quoted reply has two shapes in the Bot API (`reply_parameters` since 7.0, the
// older `reply_to_message_id`) and this install has to work on both. She tries
// them, remembers the one the server took, and a refused quote never costs her
// the actual message.
let quoteStyle = "auto";
const QUOTE_STYLES = ["parameters", "legacy"];

// Dry-run preview (NEGEV_DRY_RUN=1): she thinks for real but sends nothing and
// remembers nothing. Used to check her reaction without touching your chat.
const DRY_RUN = process.env.NEGEV_DRY_RUN === "1";
// A whole conversation instead of one reaction (NEGEV_DRY_SCRIPT="... || ..."),
// which is the only way to judge how she reads over several turns rather than as
// a single clever reply.
const DRY_SCRIPT = DRY_RUN
  ? String(process.env.NEGEV_DRY_SCRIPT || "").split("||").map((t) => t.trim()).filter(Boolean)
  : [];
// resolved when a dry-run bubble is "sent", so a scripted preview can move to the
// next of his messages only once she has finished with the last one
let dryTurnResolve = null;
// fake message ids for preview bubbles, high enough to never meet a real telegram id
let drySendSeq = 0;

// A scripted preview can leave a transcript behind (NEGEV_DRY_TRANSCRIPT=path).
// That file is the raw material for grader.js: without it, "she reads like a
// person" stays an opinion. Appended, never rewritten, so several runs of the same
// scenario stack up as real history.
const DRY_TRANSCRIPT = DRY_RUN ? process.env.NEGEV_DRY_TRANSCRIPT || null : null;
function transcriptLine(who, text) {
  if (!DRY_TRANSCRIPT || !String(text || "").trim()) return;
  try {
    fs.appendFileSync(DRY_TRANSCRIPT, `[${new Date().toISOString()}] ${who === "a" ? "YOU" : "HIM"}: ${String(text).replace(/\s+/g, " ").trim()}\n`);
  } catch (err) {
    logErr("[dry-run] could not write the transcript:", err.message);
  }
}

function quoteField(style, replyTo) {
  const id = Number(replyTo);
  return style === "legacy"
    ? { reply_to_message_id: id, allow_sending_without_reply: true }
    : { reply_parameters: { message_id: id, allow_sending_without_reply: true } };
}

async function sendOne(chatId, text, replyTo = null) {
  if (DRY_RUN) {
    log(DRY_SCRIPT.length
      ? `[dry-run] her: "${text}"`
      : `[dry-run] she would send${replyTo ? ` (quoting message ${replyTo})` : ""}: "${text}"`);
    // one line per delivered bubble, exactly as telegram would have it: that is
    // what makes a preview gradeable (grader.js reads these files)
    if (DRY_SCRIPT.length) transcriptLine("a", text);
    // the preview has to look like a real thread to her: her own bubbles are the
    // raw material of the repeat-guard, so record them even though nothing is
    // sent (read-only mode keeps them out of the real data files)
    const fakeId = 900000 + (++drySendSeq);
    mem.pushSent({ id: fakeId, text });
    dryTurnResolve?.();
    return { ok: true, dryRun: true, result: { message_id: fakeId } };
  }
  if (replyTo) {
    for (const style of (quoteStyle === "auto" ? QUOTE_STYLES : [quoteStyle])) {
      const res = await tg("sendMessage", { chat_id: chatId, text, ...quoteField(style, replyTo) });
      if (res.ok) {
        if (quoteStyle !== style) {
          quoteStyle = style;
          log(`[bot] telegram quotes use the ${style} form`);
        }
        return res;
      }
      logErr(`[bot] quote refused (${style}), trying the other form:`, res.error);
    }
  }
  return tg("sendMessage", { chat_id: chatId, text });
}

/** A system report: one plain message, no bubble splitting, no memory writes. */
async function sendRaw(text, chatId = mem.state.ownerId, replyTo = null) {
  if (!chatId) return null;
  const res = await sendOne(chatId, text, replyTo);
  if (!res.ok) logErr("[bot] sendRaw failed:", res.error);
  return res;
}

async function sendBubbles(text, { chatId = mem.state.ownerId, replyTo = null, usageKey = null, maxBubbles = 3, asVoice = false } = {}) {
  const parts = chunkBubbles(text, maxBubbles);
  if (!parts.length || !chatId) return "";
  const stop = startTyping(chatId);
  try {
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      // the typing pause between bubbles is real behaviour, but a preview cut off
      // mid-send looks exactly like a lost message, so it is skipped there
      if (parts.length > 1) await sleep(DRY_RUN ? 60 : clamp(500 + p.length * 35, 700, 3200) + rand(0, 400));
      // occasionally the first bubble comes out of her mouth instead of her thumb
      if (asVoice && i === 0) {
        const file = await voice.render(p).catch(() => null);
        const spoken = file ? await voice.sendVoice(chatId, file, { replyTo }) : { ok: false };
        if (spoken.ok) {
          log(`[voice] she said that one out loud: "${p.slice(0, 60)}"`);
          if (spoken.result?.message_id) {
            mem.pushSent({ id: spoken.result.message_id, text: p });
            usage.attach(usageKey, spoken.result.message_id);
          }
          continue;
        }
        logErr("[voice] falling back to text:", spoken.error || "render failed");
      }
      const res = await sendOne(chatId, p, i === 0 ? replyTo : null);
      if (!res.ok) logErr("[bot] sendMessage failed:", res.error);
      else if (res.result?.message_id) {
        mem.pushSent({ id: res.result.message_id, text: p });
        // so !token as a reply to this bubble can price it
        usage.attach(usageKey, res.result.message_id);
      }
      if (i < parts.length - 1) await sleep(DRY_RUN ? 20 : rand(350, 1000));
    }
  } finally {
    stop();
  }
  mem.state.lastBotTs = Date.now();
  mem.saveSoon();
  return parts.join(" ");
}

function chunkBubbles(text, maxBubbles = 3) {
  const cleaned = tidyReply(String(text || ""));
  if (!cleaned) return [];
  return splitBubbles(cleaned, maxBubbles);
}

/**
 * The raw completion turned into the exact bubbles she would send: the ::desc
 * line pulled out, no leaks, her typing and her marks, at most one question. The
 * fallback lives here too, so nothing that comes back empty - or entirely made of
 * plumbing - can ever be sent as-is.
 */
function shapeReply(raw, dress) {
  let text = tidyReply(raw || "");
  let desc = "";
  if (/^::desc:/i.test(text.split("\n")[0] || "")) {
    const lines = text.split("\n");
    desc = lines.shift().replace(/^::desc:\s*/i, "").trim();
    text = lines.join("\n").trim();
  }
  if (!text) text = pick(FALLBACK);
  text = style.prepareCapped(text, dress);
  // a reply that was ALL plumbing narration sanitizes to nothing: cover with an
  // in-character fallback line instead of sending silence or the leak
  if (!text) text = style.prepareCapped(pick(FALLBACK), dress);
  // A bubble that is only marks is not a message: the model echoed its own notes
  // back as ")\n33 :33", and a one-token completion arrived as "))<3". Both are
  // dropped here, which also makes the guarantee hold for anything upstream - if
  // the words are not there, the marks go with them.
  const bubbles = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const worded = bubbles.filter((p) => /[a-z]{2}/i.test(p));
  if (worded.length !== bubbles.length) log(`[bot] dropped ${bubbles.length - worded.length} bubble(s) with no words in them`);
  text = worded.join("\n\n");
  // ...and a reply with no words at all is a failed completion, not a message
  if (!text) {
    log(`[bot] the model returned no words at all - sending a plain line instead`);
    text = style.prepareCapped(pick(FALLBACK), dress);
  }
  return { text, desc };
}

function scheduleTeaser(chatId) {
  clearTimeout(teaserTimer);
  teaserTimer = setTimeout(() => {
    sendBubbles(pick(WATCH_TEASER), { chatId }).catch(() => {});
  }, 8000);
}

function cancelTeaser() {
  clearTimeout(teaserTimer);
  teaserTimer = null;
}

// ------------------------------------------------------------ message kind

function pickPhoto(msg) {
  return msg.photo?.[msg.photo.length - 1] || null;
}

function kindOf(msg) {
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.video_note) return "video_note";
  if (msg.animation) return "animation";
  if (msg.voice) return "voice";
  if (msg.audio) return "audio";
  if (msg.sticker) return "sticker";
  if (msg.document) {
    const mime = String(msg.document.mime_type || "");
    const name = String(msg.document.file_name || "").toLowerCase();
    // Telegram sometimes labels HEIC/AVIF/BMP/TIFF/SVG uploads as
    // application/octet-stream. The extension is still enough to route them
    // through the same single-image vision path and local conversion.
    if (mime.startsWith("image/") || /\.(jpe?g|jfif|jif|png|webp|gif|bmp|tiff?|avif|heic|heif|ico|svg|jp2|jxl|dds|psd|dng|cr2|nef|arw|orf|raf|rw2|tga|ppm|pgm|pbm|pnm)$/.test(name)) return "photo";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  }
  return "text";
}

function fileOf(msg) {
  return msg.video || msg.video_note || msg.animation || msg.audio || msg.voice || msg.document || null;
}

function kindLabel(kind) {
  return {
    photo: "a photo",
    video: "a video",
    video_note: "a round video note",
    animation: "a gif",
    voice: "a voice note",
    audio: "an audio file",
    sticker: "a sticker",
    document: "a file",
    text: "a message",
  }[kind] || "something";
}

/** One-line digest of a pipeline brief, so she remembers what the video was about later. */
function digestBrief(brief) {
  const speech = [...String(brief).matchAll(/^\s*\[\d+:\d\d-\d+:\d\d\]\s+(.+)$/gm)].map((m) => m[1]).join(" ");
  const onScreen = [...String(brief).matchAll(/^\s*\[t=[^\]]+\]\s+(.+)$/gm)].map((m) => m[1]).join(" ");
  const text = (speech || onScreen).replace(/\s+/g, " ").trim();
  return text ? truncate(text, 180) : "no speech or on-screen text";
}

function readBufs(paths = []) {
  const out = [];
  for (const p of paths) {
    try { out.push(fs.readFileSync(p)); } catch { /* ignore */ }
  }
  return out;
}

function imageItem(buffer, mime = "image/jpeg") {
  return buffer ? { buffer, mime } : null;
}

function imagePartFor(item) {
  return imagePart(item?.buffer || item, item?.mime || "image/jpeg");
}

// -------------------------------------------------- media -> model context

async function buildContent(msgs) {
  const m = msgs[msgs.length - 1];
  const kind = kindOf(m);
  const caption = String(m.caption || "").trim();
  const texts = msgs.map((x) => String(x.text || x.caption || "").trim()).filter(Boolean);
  const joined = texts.join("\n");

  const blocks = [];
  const images = [];
  const cleanups = [];
  let memoryRule = false;
  let label = joined;

  const photos = msgs.filter((x) => x.photo).map(pickPhoto).filter(Boolean).slice(0, CONFIG.visionMaxImages);

  if (kind === "photo") {
    // pictures go straight to DeepSeek vision - no local OCR/pipeline
    const ids = photos.length ? photos.map((p) => p.file_id) : (m.document ? [m.document.file_id] : []);
    const extHint = path.extname(m.document?.file_name || "");
    for (const id of ids.slice(0, CONFIG.visionMaxImages)) {
      try {
        const dl = await media.downloadTgFile(id, extHint);
        cleanups.push(dl.file);
        const vision = await media.prepareVisionImage(dl.file, dl.mime);
        if (vision.temporary) cleanups.push(vision.file);
        images.push(imageItem(fs.readFileSync(vision.file), vision.mime));
      } catch (err) {
        logErr("[bot] photo download failed:", err.message);
      }
    }
    memoryRule = images.length > 0;
    blocks.push(`[Commander sent ${ids.length > 1 ? `${ids.length} photos` : "a photo"}]${caption ? `\nHis caption: "${caption}"` : ""}`);
    label = `[photo]${caption ? ` ${caption}` : ""}`;
  } else if (kind === "video" || kind === "video_note" || kind === "animation" || kind === "voice" || kind === "audio") {
    const f = fileOf(m);
    const size = Number(f?.file_size || 0);
    const isAudio = kind === "voice" || kind === "audio";
    blocks.push(`[Commander sent ${kindLabel(kind)}]${caption ? `\nHis caption: "${caption}"` : ""}`);

    if (size && size > 20 * 1024 * 1024) {
      blocks.push("(it is too big for you to open — tell him to send a shorter clip)");
      label = `[${kind}] (too big to open)`;
    } else {
      try {
        const dl = await media.downloadTgFile(f.file_id);
        cleanups.push(dl.file);
        const result = await media.transcribeMedia(dl.file, {
          ocr: !isAudio,
          frames: isAudio ? 0 : Math.min(CONFIG.visionMaxImages, 2),
          caption,
        });
        if (result) {
          blocks.push(result.brief);
          images.push(...readBufs(result.frames).map((buf) => imageItem(buf)));
          cleanups.push(...result.frames);
          label = `[${kind}: ${digestBrief(result.brief)}]${caption ? ` caption: ${caption}` : ""}`;
        } else {
          const frames = isAudio ? [] : await media.extractFrames(dl.file, 2);
          images.push(...readBufs(frames).map((buf) => imageItem(buf)));
          cleanups.push(...frames);
          blocks.push(frames.length
            ? "(you cannot hear this one — only still frames are attached; react to what you see and ask him about it)"
            : "(you could not open this one at all — complain and make him resend it or describe it)");
          label = `[${kind}] (local pipeline unavailable)`;
        }
      } catch (err) {
        logErr("[bot] media processing failed:", err.message);
        blocks.push("(this one failed to open — complain and ask him to resend)");
        label = `[${kind}] (failed to open)`;
      }
    }
  } else if (kind === "sticker") {
    const emoji = m.sticker?.emoji || "";
    blocks.push(`[Commander sent a sticker${emoji ? ` (${emoji})` : ""}]`);
    label = "[sticker]";
  } else if (kind === "document") {
    blocks.push(`[Commander sent a file: ${m.document?.file_name || "unnamed"}]${caption ? `\nHis caption: "${caption}"` : ""}`);
    label = `[file: ${m.document?.file_name || "unnamed"}]`;
  } else {
    // Plain words. Without this branch the model got an empty user message and
    // she could only guess what he was talking about.
    if (joined) blocks.push(joined);
    if (!joined && !extractUrls(joined).length) blocks.push("[he sent an empty message]");
  }

  // a caption on a media message is his own words too, already handled above;
  // for text messages the words themselves are the content
  if (kind === "text" && joined && !blocks.includes(joined)) blocks.unshift(joined);

  // A photo in the middle of a burst used to vanish: only the last message's kind
  // was processed, so photo-then-text ("whatcha think?") reached her as words
  // alone and she asked him to send what he had already sent. Attach any photo
  // from the burst even when his newest message is text.
  if (kind !== "photo" && photos.length) {
    for (const p of photos.slice(0, CONFIG.visionMaxImages)) {
      try {
        const dl = await media.downloadTgFile(p.file_id);
        cleanups.push(dl.file);
        const vision = await media.prepareVisionImage(dl.file, dl.mime);
        if (vision.temporary) cleanups.push(vision.file);
        images.push(imageItem(fs.readFileSync(vision.file), vision.mime));
      } catch (err) {
        logErr("[bot] photo download failed:", err.message);
      }
    }
    if (images.length) {
      memoryRule = true;
      blocks.push("(photo(s) from this burst are attached - they belong to the words above; do not ask him to send them again, look at them)");
      label = `[photo]${label ? ` ${label}` : ""}`;
    }
  }

  // links / social posts (text messages, captions, and links sent as their own message)
  // Data-science mode is web-off: technical links are never fetched and do not
  // consume the general web-reader quota.
  const topic = CONFIG.dataScience?.enabled ? signal.topicMode(joined) : { topic: "general", webAllowed: true };
  const rawUrls = extractUrls(joined);
  const urls = CONFIG.social.enabled && topic.webAllowed ? rawUrls : [];
  if (topic.topic === "data_science" && rawUrls.length) {
    blocks.push(`[link he sent: ${rawUrls.join(", ")} — data-science mode: web reading is off, you never opened it. Do not describe or guess its contents; ask him to paste the relevant part if it matters.]`);
    log(`[topic] data_science - ${rawUrls.length} link(s) held back, web reader untouched`);
  }
  const web = mem.reserveWebReads(urls.length);
  if (web.blocked) {
    const reason = web.cooldownBlocked
      ? "you have just used the web reader - wait half a minute before sending another link"
      : `the web reader limit is ${web.daily} per day and ${web.hourly} per hour`;
    blocks.push(`[web reader limit reached: ${reason}. React to the link only from its URL, do not invent its contents.]`);
    log(`[web] ${web.blocked} link(s) held back (${mem.webBudgetText()})`);
  }
  for (const url of urls.slice(0, web.allowed)) {
    const post = await readPost(url);
    if (!post.ok) {
      blocks.push(`[link he sent: ${url}] — you could not open it. Tease him and ask what it is.`);
      label = joined;
      continue;
    }
    const parts = [
      `[${post.kind} he sent: ${url}]`,
      post.author ? `Posted by: ${post.author}` : "",
      post.text ? `Post content:\n${post.text}` : "(no text content found)",
      post.extra ? `Extra: ${post.extra}` : "",
    ].filter(Boolean);
    blocks.push(parts.join("\n"));

    for (const img of (post.imageUrls || []).slice(0, 1)) {
      const dl = await downloadRemote(img, 10 * 1024 * 1024);
      if (dl?.buffer && !dl.tooBig) {
        const vision = await media.prepareVisionImage(dl.file, dl.mime || "");
        images.push(imageItem(fs.readFileSync(vision.file), vision.mime));
        cleanups.push(dl.file);
        if (vision.temporary) cleanups.push(vision.file);
        blocks.push("(an image from that post is attached — look at it)");
      }
    }

    for (const vid of (post.videoUrls || []).slice(0, 1)) {
      if (!media.pipelineAvailable()) break;
      const dl = await downloadRemote(vid, CONFIG.social.maxMediaBytes);
      if (dl?.file && !dl.tooBig) {
        cleanups.push(dl.file);
        const result = await media.transcribeMedia(dl.file, { ocr: true, frames: 2, caption: "" });
        if (result) {
          blocks.push(`[video attached to that post — local pipeline]:\n${result.brief}`);
          images.push(...readBufs(result.frames).map((buf) => imageItem(buf)));
          cleanups.push(...result.frames);
        }
      }
    }
  }

  const instruction = images.length
    ? "React to this like his girlfriend would: specifically, to what is actually here."
    : "";
  const text = [blocks.join("\n\n"), instruction, memoryRule ? MEMORY_LINE_RULE : ""].filter(Boolean).join("\n\n");

  const content = images.length
    ? [textPart(text), ...images.filter(Boolean).slice(0, CONFIG.visionMaxImages + 2).map(imagePartFor)]
    : text;

  return { content, label, cleanups, kind };
}

// ------------------------------------------------------------- replying

async function processBatch(msgs, plan = null) {
  const m = msgs[msgs.length - 1];
  const chatId = mem.state.ownerId;
  const busy = currentWindow();

  // the morning answer is actually going out now, so the persisted night queue
  // is done - anything that arrived after she woke up schedules normally
  if (plan?.mode === "asleep") mem.takeOvernight();

  // "/force" (mode "instant") is the one thing that skips even a busy window:
  // he explicitly asked for the answer now.
  if (busy && !activeConversation() && plan?.mode !== "asleep" && plan?.mode !== "instant") {
    // she is "busy": no model call at all, just a short ack + queue it for later.
    // Exception: the morning answer for his night messages - she was unreachable
    // all night, and a person who wakes up mid-shift answers their phone before
    // clocking in, canned line be damned.
    const kind = kindOf(m);
    const caption = String(m.caption || "").trim();
    const label = kind === "text" ? String(m.text || "").trim() : `[${kind}]${caption ? ` ${caption}` : ""}`;
    mem.pushHistory("user", label);
    mem.state.userMsgCount += msgs.length;
    mem.state.lastUserTs = Date.now();
    mem.state.pendingSince = Date.now();
    mem.noteDayStat({ his: msgs.length, media: kind === "text" ? 0 : 1, text: label });
    mem.save();
    await announceBusy();
    return;
  }

  scheduleTeaser(chatId);
  let built;
  try {
    built = await buildContent(msgs);
  } catch (err) {
    logErr("[bot] buildContent failed:", err.message);
    built = { content: "(something arrived but it broke — ask him what it was)", label: "[broken attachment]", cleanups: [], kind: "text" };
  } finally {
    cancelTeaser();
  }

  // Old inbox items are not a backlog to answer at random. Only use a quoted
  // target when he explicitly replied to a message in Telegram.
  const explicitReply = [...msgs].reverse().find((item) => item.reply_to_message)?.reply_to_message || null;
  const replyId = Number(explicitReply?.message_id || 0);
  const catchUp = replyId
    ? (mem.state.unanswered || []).filter((item) => Number(item.id) === replyId)
    : [];
  const quote = resolveQuote(explicitReply);
  // Telegram shows HIM the message he replied to right above his words. She only
  // ever got a one-line note buried in the system prompt, so a reply to an older
  // message was answered against the newest exchange instead ("why?" under the
  // blanket message got the stoneware answer). The quote now rides with his
  // message, exactly where he sees it.
  if (quote) {
    const qtext = String(quote.target?.text || "").trim();
    const who = quote.target?.mine ? "your own earlier message" : "his earlier message";
    const qblock = qtext
      ? `[He used Telegram Reply on ${who} - this is that message, shown to you the way Telegram shows it to him:\n"${qtext}"\nHis new words below are about THAT message.]`
      : `[He used Telegram Reply on ${who} (it had no text - a photo or sticker). His new words below are about that one.]`;
    built.content = typeof built.content === "string"
      ? `${qblock}\n\n${built.content}`
      : [textPart(qblock), ...built.content];
  }
  // her state of mind for this one: this is where the inconsistency lives, and
  // what he just wrote is allowed to change it
  const hisWords = [String(m.text || ""), String(m.caption || "")].filter(Boolean).join(" ").trim();
  // Everything he sent in this batch, plus the shape of his last dozen turns:
  // what he is saying, how short he is being, and whether something of his is
  // still hanging. mood.readSignal is the same read (signal.js owns it now) - the
  // new states are what make her sound like she is actually paying attention.
  const hisAll = msgs.map((x) => String(x.text || x.caption || "").trim()).filter(Boolean).join("\n");
  const him = signal.readHis(hisWords || built.label);
  const topicMode = CONFIG.dataScience?.enabled ? signal.topicMode(hisWords || built.label) : { topic: "general" };
  const roadmapBlock = topicMode.topic === "data_science"
    ? roadmap.contextFor(hisAll || hisWords || built.label, { maxChars: 4200, limit: 4, rotate: true })
    : "";
  const eng = signal.engagement(mem.history, { turns: 14 });
  const tone = signal.nextTone({ signal: him, text: hisAll || hisWords, engagement: eng, previous: mem.state.tone, msgs: msgs.length });
  if (tone.changed) log(`[tone] ${tone.key ? `${tone.key} (lasts about ${tone.left} of his messages)` : "back to ordinary chat"}`);
  mem.state.tone = tone;
  // something of his that clearly mattered gets a check-in tomorrow morning -
  // the same route his reminders take, so it lands in her voice
  if (him.serious && !him.goodnight) {
    const what = truncate(hisWords || built.label, 110);
    if (bond.noteMoment(mem.state, what, nowBerlin())) {
      const moment = mem.state.bond.moments[mem.state.bond.moments.length - 1];
      if (tasks.addTask(bond.momentTask(moment, nowBerlin()))) {
        log(`[bond] she is holding that one - she will ask about it tomorrow: "${truncate(what, 60)}"`);
      }
    }
  }
  if (him.brb) {
    // "im resting, ill text you when ready" - her initiations hold until he is back
    const hours = 3 + rand(0, 2);
    mem.state.holdUntil = Date.now() + hours * 3600000;
    mem.state.holdWhy = truncate(hisWords || built.label, 60);
    mem.save();
    log(`[holds] he is away - her initiations hold for ~${hours}h`);
  }
  if (him.refusal) {
    // a no is a no: today's questions she asked go on the shelf until tomorrow.
    // His message itself is the reason - no need to guess which one he meant.
    const asked = mem.lastAsked();
    let shelved = 0;
    for (const q of asked.slice(0, 2)) {
      if (mem.shelveTopic(q.text, `he shut it down: "${truncate(hisWords, 50)}"`)) shelved += 1;
    }
    // when he refuses everything without naming a topic, the recent ones all lift
    if (!asked.length) {
      for (const q of (mem.state.openQuestions || []).slice(-2)) {
        if (mem.shelveTopic(q.text, `he shut it down: "${truncate(hisWords, 50)}"`)) shelved += 1;
      }
    }
    if (shelved) log(`[topics] ${shelved} topic(s) shelved until tomorrow (refusal)`);
  }
  if (him.invited) {
    // "ask me about it" re-opens a shelved topic - even one he closed himself
    const cleared = mem.reopenTopics(hisWords);
    if (cleared) log(`[topics] he invited questions - ${cleared} shelved topic(s) back on the table`);
  }
  const state = herMood({ t: nowBerlin(), signal: him, engagement: eng });
  const lifeCue = lifeShareCue(him, mem.state);
  // something unresolved from yesterday: it colours the whole conversation, not
  // just this hour (mood.js weights toward sulky/distant while it is open)
  const tension = bond.arc(mem.state);
  if (tension) bond.noteArcBeat(mem.state, nowBerlin());
  // she was off with him and he shut her down on top of it: that is not a mood any
  // more, that is the two of them not being right
  if (him.refusal && (state.key === "sulky" || state.key === "distant")) {
    const arc = bond.openArc(mem.state, { kind: "tension", cause: `he shut you down while you were already off with him: "${truncate(hisWords, 70)}"`, t: nowBerlin() });
    log(`[bond] this is not blowing over today - it is a tension now (${arc.since})`);
  }
  // going to bed annoyed is how a row survives the night
  if (plan?.mode === "asleep" && (state.key === "sulky" || state.key === "distant")) {
    const arc = bond.maybeTension(mem.state, { moodView: state, t: nowBerlin(), cause: state.why, goingToBed: true });
    if (arc) log(`[bond] she is going to bed still annoyed (${arc.cause || "it was off"}) - tomorrow starts with that`);
  }
  const energy = mood.energyRoll(state, Math.random, { excited: him.excited });
  const followUp = mood.shouldFollowUp(state);
  const typo = mood.wantsTypo(state);
  // tonight the armour slips one notch further, in a mood where that is true
  const reveal = bond.revealFor(mem.state, state);
  const bondView = bond.view(mem.state);
  // commas, apostrophes, full stops, her laugh, her <3 and her :3 are all mood
  // things - and how much of the armour is still on bends the affectionate ones
  // (the panel's affection dial scales those marks live)
  const dressed = settings.dressedMood(state);
  // What the two of them are DOING beats what she happens to be feeling: a deep or
  // venting register switches off the laugh and the smirk for this reply (the heart
  // stays and comes easier), because "i think i might be depressed" answered with
  // "what do you mean by that)))" is the worst reply in the whole probe set.
  const earnest = tone?.key === "deep" || tone?.key === "venting";
  const dress = style.plan(dressed, { energy: energy.key, closeness: bondView.closeness, earnest });
  // she starts typing, stops, and sends it a moment later anyway
  const hesitate = DRY_RUN || DRY_SCRIPT.length ? null : wantsHesitation(state);
  // if her busy window ended while she was waiting, the "i'm out right now" note is stale
  const woke = nights.minutesSinceWaking(herNight(), nowBerlin(), 45);
  const when = [
    plan?.mode === "busy" && !busy ? "" : reactionNote(plan || {}, { sinceLastBotMs: idleSinceLastBotMs(), hesitated: Boolean(hesitate) }),
    woke !== null ? `you got out of bed ${woke < 3 ? "a couple of minutes" : `${woke} minutes`} ago, so you are still thick-headed - a yawn of a first line is normal, no pep` : "",
    weather.noteLine(),
    heldNote(),
  ].filter(Boolean).join("; ");
  const internal = [
    NOTE_PREAMBLE,
    "- Reply to his newest message or newest burst first. Earlier chat is context, not a queue: do not revive or answer an older topic unless he explicitly refers to it or uses Telegram Reply on that exact message.",
    mood.block(state, { energy, followUp, typo, level: dress.level, smile: dress, heart: dress, face: dress, state: mem.state }),
    toneBlock(tone, eng),
    when ? `- Why you are only answering now (only you know this): ${when}.` : "",
    // if he asks about "before", she is told what the record actually says - an empty
    // chat makes a model confabulate a shared history, and no rule stops that
    sharedPastBlock(mem.history, { words: hisAll || hisWords }),
    threadsBlock(mem.state),
    canonBlock(mem.state),
    mediaBlock(mem.state),
    dayCardsBlock(mem.state),
    bondBlock(bondView),
    reactionBlock(mem.state),
    correctionBlock(mem.state),
    editBlock(mem.state),
    identity.block(),
    topicMode.topic === "data_science" ? DS_MENTOR_BLOCK : "",
    roadmapBlock,
    lifeCue,
    unansweredBlock(catchUp, catchUp.length > 0),
    quote ? quoteBlock(quote.target, quote.source) : "",
    repeatBlock(mem.recentSent(10)),
  ].filter(Boolean).join("\n");
  if (quote) log(`[quote] answering under his message ${quote.id} (${quote.source})`);

  // everything the model does for this reply is billed to one bucket
  const usageKey = usage.begin({ kind: "reply" });

  const messages = [
    { role: "system", content: [SYSTEM_BASE, settings.characterBlock(), contextBlock(mem.state, hisWords || built.label), internal].filter(Boolean).join("\n\n") },
    ...mem.contextSlice(),
    { role: "user", content: built.content },
  ];

  if (DRY_RUN && process.env.NEGEV_DRY_DUMP) {
    const sys = messages[0].content;
    log(`[dump] --- system tail (last 1200 of ${sys.length} chars) ---\n${sys.slice(-1200)}`);
    log(`[dump] --- what he sent ---\n${typeof built.content === "string" ? built.content : JSON.stringify(built.content).slice(0, 600)}`);
  }

  log(`[mood] ${state.def.label} | energy ${energy.key} | ${style.describe(dress)} | bubbles<=${state.def.bubbles} | words<=${state.def.words}${typo ? " | typo allowed" : ""}${followUp ? "" : " | no question back"}`);

  const maxTokens = mood.tokenBudget(state, settings.replyMaxTokens(CONFIG.replyMaxTokens));
  const temperature = Math.max(0.2, Math.min(1.4, mood.temperature(state) + settings.get().temperatureBias));

  const ask = (correction = null) => llm(
    correction ? [...messages, { role: "user", content: correction }] : messages,
    { maxTokens, temperature },
  );

  let raw;
  try {
    raw = await ask();
  } catch (err) {
    logErr("[bot] llm failed:", err.message);
    raw = pick(FALLBACK);
  }

  let shaped = shapeReply(raw, dress);
  let text = shaped.text;

  // Two things her own layer cannot see: whether the reply actually goes back to
  // what he asked, and whether it sounds like a person at all. Both checks are
  // free, and a failure buys exactly ONE regeneration - never a second pass on
  // every message, and never a reasoning model.
  const question = signal.questionIn(hisAll) || eng.pending || null;
  const problems = [];
  const missed = question && !signal.answered(question, text);
  if (missed) {
    problems.push(`you did not answer what he asked ("${truncate(question.text, 90)}") - answer that first, out loud, in your own words`);
  }
  const lints = style.assistantSpeak(raw);
  if (lints.length) problems.push(`that was not how you talk: ${lints.map((l) => l.sample).join(", ")}`);
  // ...and the third one: he said something with content and she answered about
  // herself. The radiator reply in the live probe was this exact failure, and
  // nothing in the reply path looked for it.
  const talkedPast = !missed && signal.talksPast(hisAll, text);
  if (talkedPast) {
    problems.push(`you talked past him - he said "${truncate(hisAll, 90)}" and nothing in your reply touches it. React to what he actually said first, then anything about you`);
  }
  if (problems.length) {
    const why = [missed ? "unanswered question" : "", talkedPast ? "talked past him" : "", ...lints.map((l) => l.id)].filter(Boolean);
    log(`[verify] retry 1 - ${why.join(" + ")}`);
    // counted, so a rising number is a visible quality signal instead of a
    // silently doubled bill
    mem.noteVerifyRetry(missed ? "question" : talkedPast ? "past" : "assistant");
    // so the ledger can name it instead of guessing: a regeneration and a memory
    // pass land in the same bucket and cost different amounts
    usage.note("1 regeneration");
    try {
      const second = shapeReply(await ask(`CORRECTION (internal, never mentioned): ${problems.join("; ")}. Write the reply again: usually 1-3 short bubbles, with a fourth only if genuinely needed, never more than four, in your own voice, answering him.`), dress);
      const stillMissed = question && !signal.answered(question, second.text) ? 1 : 0;
      const stillLinty = style.assistantSpeak(second.text).length ? 1 : 0;
      const stillPast = signal.talksPast(hisAll, second.text) ? 1 : 0;
      if (second.text && stillMissed + stillLinty + stillPast < problems.length) {
        text = second.text;
        if (second.desc && !shaped.desc) shaped.desc = second.desc;
      } else {
        log("[verify] the second attempt was not better - keeping the first one");
      }
    } catch (err) {
      logErr("[verify] retry failed:", err.message);
    }
  }
  const desc = shaped.desc;
  // a question went out: the hourly question budget ticks
  if (/\?/.test(text)) mood.noteQuestion(mem.state);
  // the question she asked is settled the next time he writes anything (memory.js)
  mem.noteHerQuestion(text);
  // the preview shows the finished text, so "the plan said laughing but nothing
  // arrived" is visible instead of invisible
  if (DRY_RUN) log(`[dry-run] shaped: ${JSON.stringify(text)}`);

  const userLabel = desc && built.kind === "photo"
    ? `[photo: ${desc}]${String(m.caption || "").trim() ? ` caption: ${String(m.caption).trim()}` : ""}`
    : built.label;

  mem.pushHistory("user", userLabel);

  // she starts typing, stops, and the message goes out a bit later anyway. Rare,
  // mood-gated, and skipped in previews where it would just add a minute of wait.
  if (hesitate) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    await sleep(hesitate.typedMs);
    log(`[timing] she started typing and stopped - ${Math.round(hesitate.silenceMs / 1000)}s of second thoughts`);
    await sleep(hesitate.silenceMs);
  }

  const parts = chunkBubbles(text, mood.maxBubbles(state));
  // her voice, occasionally, on a short soft line - never on a link or a question
  const asVoice = Boolean(parts.length) && !DRY_RUN
    && voice.wantsVoice({ mood: state, closeness: bondView.closeness, text: parts[0] });
  // ...and a picture of her own life when he asks for one, or when she is telling
  // him about something she happens to have a photo of
  const moment = [hisWords, built.label, (mem.state.diary?.events || []).slice(-1)[0] || ""].filter(Boolean).join(" ");
  const herPhoto = photos.wantsForReply(mem.state, { text: hisWords, moment });
  const sent = await sendBubbles(text, {
    chatId,
    replyTo: quote?.id || null,
    usageKey,
    maxBubbles: mood.maxBubbles(state),
    asVoice,
  });
  mem.pushHistory("assistant", sent || text);

  // a picture of her own, captioned in the moment so the same file never reads
  // like the same message twice. One model call, and only when it fits.
  if (herPhoto && !DRY_RUN) {
    try {
      usage.note("a photo caption");
      const rawCap = await llm(
        [{ role: "system", content: SYSTEM_BASE }, { role: "user", content: photoPrompt(herPhoto.desc || "something from your day", moment) }],
        { maxTokens: 40, temperature: mood.temperature(state) },
      );
      const caption = style.prepareCapped(tidyReply(rawCap), dress) || null;
      const shot = caption ? await photos.sendPhoto(chatId, herPhoto, caption, { replyTo: quote?.id || null }) : { ok: false, error: "no caption" };
      if (shot.ok) {
        mem.noteHerPhoto(herPhoto.name);
        if (shot.result?.message_id) {
          mem.pushSent({ id: shot.result.message_id, text: caption });
          usage.attach(usageKey, shot.result.message_id);
        }
        log(`[photo] she sent one of her own: ${herPhoto.name} - "${caption}"`);
      } else {
        logErr("[photo] failed, that was text only:", shot.error);
      }
    } catch (err) {
      logErr("[photo] caption failed:", err.message);
    }
  } else if (herPhoto && DRY_RUN) {
    log(`[photo] (dry-run) she would send a photo of her day: ${herPhoto.name}${herPhoto.desc ? ` - ${herPhoto.desc}` : ""}`);
  }

  // his media gets a one-line memory, so weeks later she can bring it back up
  if (built.kind !== "text") mem.addMediaMemory({ label: userLabel, desc });
  // the message he just sent is on record: her earlier initiations are answered
  mem.resetInitiations();
  mem.state.userMsgCount += msgs.length;
  mem.state.lastUserTs = Date.now();
  mem.state.activeChatUntil = Date.now() + Number(CONFIG.schedule.activeConversationMin || 15) * 60000;
  mem.state.turnsSinceLifeShare = lifeCue ? 0 : Number(mem.state.turnsSinceLifeShare || 0) + 1;
  mem.state.mediaCount += built.kind === "text" ? 0 : 1;
  mem.state.model = currentModel();
  // the day card accumulates the raw shape of today, and a reaction he left is
  // spoken for the moment her reply mentions it
  mem.noteDayStat({
    his: msgs.length,
    hers: parts.length,
    media: built.kind === "text" ? 0 : 1,
    text: hisWords,
    signals: him,
    tension: Boolean(tension),
  });
  if (mem.state.hisReaction && !mem.state.hisReaction.acknowledged) reactions.acknowledge(mem.state);
  // both of those were in her prompt for this reply - they are spent now
  if (mem.state.correction) mem.state.correction = null;
  if (mem.state.lastEdit) mem.state.lastEdit = null;
  // she opened up: it is spent forever - unless the message never actually left
  if (reveal) {
    if (sent) bond.confirmReveal(mem.state);
    else bond.dropReveal(mem.state);
  }
  mem.save();

  media.cleanup(built.cleanups);

  // mid-conversation, something pulls her away and she says so herself
  await maybeStepAway({ dry: DRY_RUN }).catch((err) => logErr("[step-away] failed:", err.message));

  // the memory passes right after a reply belong to that reply's bucket, so the
  // bucket stays open until they finish (a new message reassigns it)
  const memoryPasses = [maybeExtractFacts(), maybeSummarize()];
  Promise.allSettled(memoryPasses)
    .catch(() => {})
    .finally(() => {
      // a preview should tell you what that preview cost: the bucket is printed
      // before it is closed, so you can price any message shape without asking
      // the model twice or touching the real ledger
      if (DRY_RUN) {
        const bucket = usage.totals().replies.find((r) => r.key === usageKey);
        if (bucket?.calls) log(`[cost] ${usage.renderReply(bucket).split("\n").slice(1).join(" | ")}`);
      }
      usage.end(usageKey);
    });
}

/**
 * Does her own memory contradict the correction he just made?
 *
 * Deliberately narrow: it only answers when he denies where the fact CAME FROM or
 * quotes a version she does not have. "no i never said my cat was called momo" is a
 * hit because she has it underlined as something he told her - and a girl who says
 * "oh right my bad" to that is not agreeable, she is hollow. A correction about
 * anything she has no note on stays a normal correction, because being wrong is
 * allowed and apologising for it is human.
 */
function heldGround(text) {
  const says = String(text || "").toLowerCase();
  const denying = /\b(i never (said|told)|i didn'?t (say|tell)|thats not what i said|that is not what i said|youre making (that|this) up|you made (that|this) up|not what i said|i never (mentioned|wrote))\b/.test(says);
  if (!denying) return null;
  const facts = [...(mem.state.facts || []), ...(mem.state.canon || [])].filter((f) => f.length >= 6);
  // the words he is denying, longest first: "cat" alone is too vague to defend
  const denied = signal.contentWords(says).filter((w) => w.length >= 4);
  let best = null;
  for (const fact of facts) {
    const low = String(fact).toLowerCase();
    const overlap = denied.filter((w) => low.includes(w.slice(0, 5))).length;
    if (overlap >= 1 && (!best || overlap > best.score)) best = { fact, score: overlap };
  }
  return best ? String(best.fact).slice(0, 120) : null;
}

// ------------------------------------------------- explicit "remember this"
// One line of her voice per fact - acknowledged like she jotted it down, never
// like a system confirming a command.
function ackRemember(facts) {
  const lines = facts.map((fact) => {
    const kind = /exam|deadline|appointment|birthday|work|shift|flight|train|meeting/i.test(fact)
      ? pick(["got it, that ones in the calendar", "ok noted. i wont ask you that night now"])
      : pick(["got it", "noted", "locked in", "ok thats in my head now", "yep, keeping that one"]);
    return `${kind} - ${mem.toHerVoice(fact)}`;
  });
  log(`[remember] pinned ${facts.length} fact(s): ${facts.join(" | ")}`);
  return lines.join("\n\n"); // one bubble per fact, like she texted them separately
}

// ------------------------------------------------------------- reminders
// Her side of "remind me to call mom at 6": she agrees like a person and then
// actually texts at 6 (proactive.js fires it).
function ackReminder(task) {
  const hhmm = task.whenMin !== null ? `${Math.floor(task.whenMin / 60) % 24}:${String(task.whenMin % 60).padStart(2, "0")}` : "";
  const when = hhmm && task.whenLabel !== "this evening" ? `${task.whenLabel || "today"} at ${hhmm}` : task.whenLabel || "later";
  log(`[tasks] reminder accepted: "${task.what}" -> ${task.date} ${hhmm || task.whenLabel}`);
  return [
    `${pick(["ok deal", "got it", "fine", "noted"])}, ${when} i text you`,
    "and if you still dont do it after that, thats on you",
  ].join("\n\n");
}

// ------------------------------------------------------------ long memory

async function maybeExtractFacts() {
  const st = mem.state;
  if (st.userMsgCount - st.factsSeenAt < 10) return;
  st.factsSeenAt = st.userMsgCount;
  mem.save();
  usage.note("a fact pass");
  const excerpt = mem.history
    .slice(-30)
    .map((h) => `${h.r === "u" ? "HIM" : "YOU"}: ${h.t}`)
    .join("\n")
    .slice(-4000);
  try {
    const out = await llm(
      [{ role: "system", content: factsPrompt }, { role: "user", content: excerpt }],
      { maxTokens: 320, temperature: 0.2 },
    );
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(out.slice(start, end + 1));
      // her own claims are not evidence about him: anything that cannot be traced to
      // one of HIS lines is something she said, not something he told her. The same
      // filter guards the shared ledger - a "shared" thing she invented is the same
      // lie with a nicer name.
      const facts = (obj.facts || []).filter((f) => !signal.herClaimOnly(f, excerpt));
      const dropped = (obj.facts || []).length - facts.length;
      if (dropped) log(`[facts] dropped ${dropped} "fact(s)" that only she had said - her word is not evidence about him`);
      const ours = (obj.ours || []).filter((o) => !signal.herClaimOnly(o, excerpt));
      if (facts.length) {
        mem.addFacts(facts);
        log(`[facts] remembered ${facts.length} new thing(s) about him, total ${st.facts.length}`);
      }
      if (Array.isArray(obj.canon) && obj.canon.length) {
        mem.addCanon(obj.canon);
        log(`[canon] her own life now has ${st.herCanon.length} entries (+${obj.canon.length})`);
      }
      if (ours.length) {
        const added = bond.addOurThings(st, ours);
        if (added) log(`[bond] ${added} new thing(s) that are theirs: ${st.bond.ourThings.slice(-added).join(" | ")}`);
      }
      // he corrected the record: the wrong version is dropped, not joined by the
      // right one. Keeping both is worse than remembering nothing.
      if (Array.isArray(obj.supersedes) && obj.supersedes.length) {
        const fixed = mem.supersedeFacts(obj.supersedes, facts);
        if (fixed) log(`[fix] ${fixed} wrong memor(y/ies) replaced: ${obj.supersedes.join(" | ").slice(0, 90)}`);
      }
      if (Array.isArray(obj.promises)) {
        for (const p of obj.promises) {
          const by = p?.by === "her" ? "her" : p?.by === "him" ? "him" : null;
          const hours = Number(p?.inHours);
          if (by && p?.text && mem.addPromise({ text: p.text, by, dueAt: Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600000 : null })) {
            log(`[promises] tracked (${by}): "${truncate(p.text, 70)}"`);
          }
        }
      }
      // follow-up threads: a fact about an open thing in his life with no date
      // gets a check-in in a day or three, like a person who was listening
      for (const fact of facts) {
        if (!/\b(will|going to|plan|planning|soon|next week|next month|deadline|interview|exam|launch|deploy|trip|move|visit|applied|starting|start\b)/i.test(fact)) continue;
        if (/^(his |her |their )?(name|job|city|age)/i.test(fact)) continue;
        if (st.tasks.some((x) => x.what === fact)) continue;
        const dayOffset = 1 + Math.floor(Math.random() * 2);
        const dayTask = {
          what: `he mentioned: ${fact}`,
          date: tasks.addDays(nowBerlin().dateStr, dayOffset),
          whenMin: 10 * 60 + Math.floor(Math.random() * 240),
          kind: "fact-day",
          byWhom: "her",
        };
        if (tasks.addTask(dayTask)) log(`[tasks] check-in in ${dayOffset} day(s): "${truncate(fact, 70)}"`);
      }
    }
  } catch (err) {
    logErr("[facts] extraction failed:", err.message);
  }
  mem.save();
}

async function maybeSummarize() {
  if (!CONFIG.memory.keepSummary) return;
  if (mem.history.length < CONFIG.historyKeep - 60) return;
  usage.note("a summary pass");
  const chunk = mem.takeSummaryChunk(140);
  const excerpt = chunk
    .map((h) => `${h.r === "u" ? "HIM" : "YOU"}: ${h.t}`)
    .join("\n")
    .slice(-12000);
  try {
    const out = await llm(
      [{ role: "system", content: summaryPrompt(mem.state.summary) }, { role: "user", content: excerpt }],
      { maxTokens: 240, temperature: 0.3 },
    );
    mem.state.summary = tidyReply(out).slice(0, 1200);
    mem.save();
    log("[summary] compressed older chat into memory");
  } catch (err) {
    logErr("[summary] failed:", err.message);
    mem.restoreHistory(chunk);
  }
}

// -------------------------------------------------------------- commands

function statusText() {
  const st = mem.state;
  const next = st.schedule?.find((s) => !s.sent);
  const lines = [
    `Negev status`,
    `- bound to chat: ${st.ownerId}${st.boundAt ? ` since ${new Date(st.boundAt).toISOString().slice(0, 16)}Z` : ""}`,
    `- model: ${currentModel()}`,
    `- memory: ${mem.history.length} turns kept, ${st.facts.length} facts, summary ${st.summary ? "yes" : "no"}`,
    `- media handled: ${st.mediaCount}`,
    `- local pipeline: ${media.pipelineAvailable() ? `available (whisper ${CONFIG.pipeline.model}, ocr ${CONFIG.pipeline.ocrLangs})` : "NOT found - videos/audio read as frames only"}`,
    `- today (${nowBerlin().dateStr}): ${st.diary?.events?.length || 0} diary events, ${(st.schedule || []).filter((s) => s.sent).length} texts sent of ${(st.schedule || []).length}`,
    `- right now: ${busySummary()}${st.stepAway ? ` | stepped away: ${st.stepAway.activity}, back in ~${Math.max(0, Math.round((st.stepAway.endMs - Date.now()) / 60000))} min` : ""}`,
    `- mood: ${mood.describe(mood.currentMood(mem.state) || herMood())}`,
    `- this conversation: ${st.tone?.key ? `${st.tone.key} (about ${st.tone.left} of his messages left)` : "ordinary chatting"}`,
    `- reading him: ${signal.describe(st)}`,
    `- the relationship: ${bond.stageOf(st).label} (stage ${bond.stageOf(st).n}/4), ${(st.bond?.ourThings || []).length} thing(s) that are theirs, ${(st.bond?.told || []).length} truth(s) told`,
    `- reactions: ${reactions.describe(st)}`,
    `- voice notes: ${voice.describe()}`,
    `- her photos: ${photos.status(st)}`,
    `- unresolved between you: ${st.bond?.arc ? `${st.bond.arc.kind} since ${st.bond.arc.since} (${st.bond.arc.cause || "something was off"})` : "nothing"} | nights that went unresolved: ${(st.bond?.arcHistory || []).length}`,
    `- that answer check today: ${mem.verifyToday().count} regeneration(s) (${mem.verifyToday().kinds.question} missed his question, ${mem.verifyToday().kinds.past || 0} talked past him, ${mem.verifyToday().kinds.assistant} assistant voice)`,
    `- model policy: ${currentModel()} only, reasoning disabled, no fallback or per-message override`,
    `- last day card: ${mem.recentDayCards(1).map((c) => c.line).join("") || "none yet (they are written as days finish)"}`,
    `- last reply timing: ${lastReaction ? `${lastReaction.mode}, ${lastReaction.delayMs === null ? "no answer" : `after ${gapWords(lastReaction.delayMs)}`}` : "none yet"}`,
    `- left unanswered: ${mem.unansweredCount()}${rx ? " | a reply is waiting to go out" : ""}`,
    `- on her list: ${tasks.pendingCount()} reminder/check-in(s)${tasks.pendingCount() ? ` (${tasks.listTasks().map((x) => x.what).slice(0, 3).join("; ")}${tasks.pendingCount() > 3 ? "..." : ""})` : ""}`,
    `- spend: ${usage.totals().totals.calls} calls, ${usage.totals().totals.prompt + usage.totals().totals.completion} tokens, $${usage.totals().totals.cost.toFixed(6)} (types: !token on a reply, !tokenall)`,
    `- web reader: ${mem.webBudgetText()}${Number(st.awakeUntil || 0) > Date.now() ? ` | awake window ${Math.ceil((st.awakeUntil - Date.now()) / 60000)} min left` : ""}`,
    `- replying under his messages: ${quoteStyle === "auto" ? "works out the API form on first use" : `yes (${quoteStyle})`}, ${mem.state.inbox.length} of his messages remembered for quoting`,
    `- next text: ${next ? `${Math.floor(next.t / 60)}:${String(next.t % 60).padStart(2, "0")} Dortmund time` : "none scheduled today"}`,
  ];
  return lines.join("\n");
}

// ------------------------------------------------------- usage commands
// "!token" as a reply to one of her messages prices that reply; "!tokenall"
// prices everything. Neither costs a model call.

async function handleUsageCommand(msg, mode) {
  const chatId = mem.state.ownerId;
  const replyTo = msg.reply_to_message?.message_id || null;

  if (mode === "all") {
    const t = usage.totals().totals;
    log(`[usage] whole-history report: ${t.calls} calls, ${t.prompt + t.completion} tokens, $${t.cost.toFixed(6)}`);
    const balance = await usage.accountBalance();
    return sendRaw(`${usage.renderTotals()}\n${usage.balanceLine(balance)}`, chatId, msg.message_id);
  }

  if (!replyTo) {
    log("[usage] !token without a reply - sending instructions");
    const balance = await usage.accountBalance();
    return sendRaw(`${usage.helpText()}\n${usage.balanceLine(balance)}`, chatId, msg.message_id);
  }
  const bucket = usage.bucketForMessage(replyTo);
  if (!bucket) {
    log(`[usage] no ledger entry for message ${replyTo} (probably sent before tracking started)`);
    return sendRaw(usage.notFoundText(replyTo), chatId, msg.message_id);
  }
  log(`[usage] priced reply ${bucket.key} (${bucket.calls} call(s), $${bucket.cost.toFixed(6)})`);
  const balance = await usage.accountBalance();
  return sendRaw(`${usage.renderReply(bucket)}\n${usage.balanceLine(balance)}`, chatId, msg.message_id);
}

async function handleCommand(msg) {
  const st = mem.state;
  const text = String(msg.text || "").trim();

  if (text === "/reset") {
    mem.resetMemory();
    await sendBubbles(RESET_LINE, { chatId: st.ownerId });
    log("[cmd] memory reset");
    return true;
  }
  if (/^\/quiet/.test(text)) {
    const m = text.match(/(\d+)\s*(h|hour|hours|m|min|mins|minutes)?/i);
    const hours = m ? (m[2] && /^m/i.test(m[2]) ? Number(m[1]) / 60 : Number(m[1])) : 2;
    st.quietUntil = Date.now() + Math.max(0.25, Math.min(24, hours)) * 3600000;
    mem.save();
    await sendRaw(`quiet mode: she will not text first for ${Math.min(24, Math.max(0.25, hours))}h. /awake cancels it.`, st.ownerId);
    log(`[cmd] quiet until ${new Date(st.quietUntil).toISOString()}`);
    return true;
  }
  if (text === "/awake") {
    st.quietUntil = 0;
    st.holdUntil = 0;
    st.holdWhy = null;
    mem.resetInitiations();
    mem.save();
    await sendRaw("quiet mode off, holds cleared. she can text first again.", st.ownerId);
    log("[cmd] quiet/holds cleared");
    return true;
  }
  if (text === "/status") {
    await sendBubbles(statusText(), { chatId: st.ownerId });
    return true;
  }
  if (text === "/start") {
    await sendBubbles(pick(WELCOME_BACK), { chatId: st.ownerId });
    return true;
  }
  if (text === "/remember" || text === "/mem") {
    const facts = st.facts;
    await sendBubbles(facts.length ? `what i keep in my head:\n${facts.map((f) => `- ${f}`).join("\n")}` : "nothing yet. tell me things starting with remember and i keep them", { chatId: st.ownerId });
    log(`[cmd] /remember listed ${facts.length} fact(s)`);
    return true;
  }
  if (text === "/tasks") {
    const open = tasks.listTasks();
    await sendBubbles(open.length ? open.map((x) => `- ${x.what} (${x.kind === "fact-day" ? "i want to ask about this" : "reminder"}, ${x.date}${x.whenMin !== null ? ` ${Math.floor(x.whenMin / 60) % 24}:${String(x.whenMin % 60).padStart(2, "0")}` : ""})`).join("\n") : "nothing on the list right now", { chatId: st.ownerId });
    log(`[cmd] /tasks listed ${open.length} item(s)`);
    return true;
  }
  if (text.startsWith("/forget")) {
    const part = text.replace(/^\/forget\b\s*/i, "");
    const removed = part ? mem.forgetMemory(part) : 0;
    const gone = removed > 0;
    await sendBubbles(gone ? "ok, that one is gone from my head" : "i dont have anything like that in my head", { chatId: st.ownerId });
    log(`[cmd] /forget "${truncate(part, 60)}" -> ${gone ? `${removed} record(s) removed` : "not found"}`);
    return true;
  }
  if (text === "/web") {
    await sendRaw(`web reader: ${mem.webBudgetText()}. it reads links you send; the limit resets with Dortmund time.`, st.ownerId, msg.message_id);
    log("[cmd] /web reported web-reader budget");
    return true;
  }
  if (text === "/promises") {
    const open = mem.openPromises();
    await sendRaw(open.length ? open.map((p) => `- [${p.by}] "${p.text}" (${new Date(p.madeAt).toISOString().slice(0, 10)}${p.followedUp ? ", followed up" : ""})`).join("\n") : "no open promises tracked", st.ownerId);
    log(`[cmd] /promises listed ${open.length}`);
    return true;
  }
  if (text === "/bond" || text === "!bond") {
    await sendRaw(`the two of you:\n${bond.describe(st)}`, st.ownerId);
    log("[cmd] /bond reported the relationship ledger");
    return true;
  }
  if (text === "/canon") {
    const canon = st.herCanon || [];
    await sendRaw(canon.length ? `her canon (her own life, as she told it):\n${canon.map((f) => `- ${f}`).join("\n")}` : "her canon is empty - it fills as she talks about her life", st.ownerId);
    return true;
  }
  if (text === "/media") {
    const media = st.mediaLog || [];
    await sendRaw(media.length ? `media he sent (she can bring these up later):\n${media.map((x) => `- ${x.label}${x.desc ? ` - ${x.desc}` : ""}`).join("\n")}` : "no media remembered yet", st.ownerId);
    return true;
  }
  if (text === "/weather") {
    const w = weather.current();
    await sendRaw(w ? `Dortmund right now: ${w.desc}, ${w.temp}C (wind ${w.wind} km/h, rain chance ${w.pop}%)` : "no weather reading yet - it will appear once she plans her day", st.ownerId);
    return true;
  }
  if (text === "/her") {
    const me = identity.ensure();
    await sendRaw(
      [
        `her biography (rolled ${me.rolledOn}, fixed forever):`,
        `- favourite song: ${me.favorites.song}`,
        `- favourite food: ${me.favorites.dish}`,
        `- favourite drink: ${me.favorites.drink}`,
        `- favourite colour: ${me.favorites.color}`,
        `- her spots: ${me.places.regulars.join(", ")}`,
        `- hobbies: ${me.hobbies.map((h) => `${h.key} (${h.detail})`).join(", ")}`,
        `- cities she has visited: ${me.places.visited.join(", ")} | dream trip: ${me.places.dreamTrip}`,
        `- little habits: ${me.habits.join("; ")}`,
        `- her flat: ${me.flat.detail}, with ${me.flat.decor}; no plants`,
        me.fears ? `- quietly afraid of: ${me.fears}` : "",
      ].filter(Boolean).join("\n"),
      st.ownerId,
    );
    return true;
  }
  if (text.startsWith("/herfavorite ")) {
    const [key, ...rest] = text.replace(/^\/herfavorite\s+/i, "").split(/\s+/);
    const done = identity.setFavorite(key, rest.join(" "));
    await sendBubbles(done ? `fixed. ${key} is now "${rest.join(" ")}" - it stays that way` : `i dont have a favourite called "${key}" - song, dish, drink, color, place, cafe, bar`, { chatId: st.ownerId });
    return true;
  }
  // /force - she answers RIGHT NOW on the current context. SILENT by design:
  // slash commands are control-plane, she never converses about them.
  //   /force            -> pending answer (waiting timer, left-on-read, the
  //                        overnight queue) fires immediately; if nothing is
  //                        pending, the NEXT message he sends is answered now
  //   /force <text>     -> that text is treated as his message and answered now
  //   reply-to + /force -> the answer hangs on that thread
  // It skips the human delay, busy windows and even her sleep - that is its job.
  if (/^\/force\b/i.test(text) || /^!force\b/i.test(text)) {
    const chatId = st.ownerId;
    if (!chatId) return true;
    // This command is silent by itself, but it gives the next 10-15 minutes a
    // persisted wake window so sleep cannot swallow the following conversation.
    armAwakeWindow();
    const part = text.replace(/^[\/!]force\b\s*/i, "").trim();

    if (part) {
      // a forced message joins any pending batch, or starts one on the spot
      const fake = {
        message_id: msg.message_id,
        text: part,
        chat: { id: chatId, type: "private" },
        from: msg.from,
        reply_to_message: msg.reply_to_message,
      };
      if (rx) {
        if (rx.plan?.mode === "asleep") mem.takeOvernight(); // they are being answered this second
        clearTimeout(rx.timer);
        rx.msgs.push(fake);
        rx.count = rx.msgs.length;
      } else {
        rx = { msgs: [fake], count: 1, firstAt: Date.now(), plan: null, timer: null };
      }
      rx.plan = {
        mode: "instant",
        delayMs: 400,
        note: "he sent this with /force - he wants your answer right now, no delay, like you were already holding your phone",
      };
      rx.timer = setTimeout(() => { fireReaction().catch((err) => logErr("[bot] reaction failed:", err.message)); }, 400);
      log(`[cmd] /force <text> - answering now (${rx.msgs.length} message(s) in the batch)`);
      return true;
    }

    if (rx) {
      // something is already pending: pull the trigger on it
      const wasAsleep = rx.plan?.mode === "asleep";
      if (wasAsleep) mem.takeOvernight();
      clearTimeout(rx.timer);
      rx.plan = {
        mode: "instant",
        delayMs: 400,
        note: wasAsleep
          ? "you were asleep and he woke you on purpose - answer now, a bit groggy is fine"
          : "he asked you to answer right now - whatever you were waiting for, stop waiting",
      };
      rx.timer = setTimeout(() => { fireReaction().catch((err) => logErr("[bot] reaction failed:", err.message)); }, 400);
      log(`[cmd] /force - pending answer fires now (${rx.msgs.length} message(s) waiting)`);
      return true;
    }

    // nothing pending and nothing left hanging: arm the latch. His NEXT message
    // is answered instantly (st.forceNext, read in handleMessage). No reply here
    // - a slash command never gets a conversational answer.
    st.forceNext = true;
    mem.save();
    log("[cmd] /force - nothing pending; next message from him will be answered instantly");
    return true;
  }
  return false;
}

/** Natural-language forgetting is a memory operation, never a conversation topic. */
function forgetRequest(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const direct = value.match(/^(?:please\s+)?(?:forget|erase|delete|remove)\s+(?:that|this|it)\s*[.!?]*$/i);
  if (direct) return { query: "", previous: true };
  const undo = value.match(/^(?:i\s+)?(?:didn'?t|did not)\s+mean\s+(?:that|this|it)\b[\s,.;:-]*(?:forget(?:\s+(?:that|this|it))?|never mind|ignore it)?\s*[.!?]*$/i);
  if (undo) return { query: "", previous: true };
  const named = value.match(/^(?:please\s+)?(?:forget|erase|delete|remove)\s+(?:about\s+)?(.+?)\s*[.!?]*$/i);
  if (named && named[1] && !/^(?:that|this|it)$/i.test(named[1].trim())) return { query: named[1].trim(), previous: false };
  const dont = value.match(/^(?:please\s+)?(?:don'?t|do not)\s+(?:remember|keep)\s+(.+?)\s*[.!?]*$/i);
  if (dont && dont[1]) {
    const query = dont[1].trim();
    return /^(?:that|this|it)$/i.test(query)
      ? { query: "", previous: true }
      : { query, previous: false };
  }
  return null;
}

// ------------------------------------------------------------ weekly recap
/** !recap - the week in her voice. Costs one model call, no memory writes. */
async function handleRecap(msg) {
  const st = mem.state;
  const weekAgo = Date.now() - 7 * 86400000;
  const days = Object.entries(st.usage?.days || {})
    .filter(([d]) => new Date(`${d}T12:00:00Z`).getTime() >= weekAgo)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const facts = (st.facts || []).slice(-8);
  const canon = (st.herCanon || []).slice(-6);
  const promises = mem.openPromises();
  const moods = st.mood ? [`right now: ${st.mood.key} (${st.mood.why || "no reason"})`] : [];
  const ctx = [
    days.length ? `Spending by day (activity proxy): ${days.map(([d, v]) => `${d.slice(5)}: ${v.calls} calls`).join(", ")}` : "",
    facts.length ? `What she knows about him: ${facts.join(" | ")}` : "",
    canon.length ? `Her own life lately: ${canon.join(" | ")}` : "",
    promises.length ? `Still open between them: ${promises.map((p) => `[${p.by}] ${p.text}`).join(" | ")}` : "",
    moods.join("\n"),
  ].filter(Boolean).join("\n") || "(the week is basically empty)";
  try {
    const out = await llm(
      [{ role: "system", content: SYSTEM_BASE }, { role: "user", content: recapPrompt(ctx) }],
      { maxTokens: 200, temperature: 0.9 },
    );
    const shaped = style.prepare(tidyReply(out), style.plan(mood.currentMood(st) || herMood({ t: nowBerlin() })));
    await sendBubbles(shaped, { chatId: st.ownerId, replyTo: msg.message_id });
    log("[cmd] !recap sent");
  } catch (err) {
    logErr("[recap] failed:", err.message);
    await sendRaw("recap failed (model unreachable) - try again in a minute", st.ownerId, msg.message_id);
  }
}

// --------------------------------------------------------------- routing

const queue = [];
let flushing = false;

function enqueue(msg) {
  queue.push(msg);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 1500);
}

let flushTimer = null;

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    scheduleReaction(batch);
  } catch (err) {
    logErr("[bot] scheduling crashed:", err.message);
  } finally {
    flushing = false;
    if (queue.length) flush();
  }
}

// --------------------------------------------------- human reaction timing
// She does not answer in 300 ms. Sometimes she is already holding the phone,
// sometimes she gets to it in a few minutes, sometimes she reads it and says
// nothing for an hour, and past midnight she is simply asleep. timing.js makes
// the decision; this keeps the timer and the pending messages.

let rx = null; // { msgs, count, firstAt, plan, timer }
let lastReaction = null;

function idleSinceLastBotMs() {
  const last = mem.state.lastBotTs;
  return last ? Date.now() - last : Infinity;
}

/** Short text standing in for whatever he sent, so it can be remembered and quoted. */
function messageLabel(msg) {
  const kind = kindOf(msg);
  const caption = String(msg.caption || "").trim();
  const text = kind === "text"
    ? String(msg.text || "").trim()
    : `${kindLabel(kind)}${caption ? ` - "${caption}"` : ""}`;
  return truncate(text || "something", 120);
}

function unansweredEntries(msgs) {
  return msgs.map((msg) => ({ id: msg.message_id, text: messageLabel(msg), ts: Date.now() }));
}

/**
 * Which message her answer hangs on. Only an explicit Telegram reply creates a
 * thread; old inbox/unanswered messages are never selected automatically.
 */
function resolveQuote(reply) {
  const threadId = Number(reply?.message_id || 0);
  if (!threadId) return null;
  const known = mem.findAnyMessage(threadId);
  mem.clearUnanswered([threadId]);
  // Telegram embeds the quoted message in the update itself, so a reply to
  // something older than her inbox window (12 entries / 36h) still carries its
  // text - she never has to shrug at a thread she cannot see.
  const apiText = String(reply?.text || reply?.caption || "").trim();
  const target = known || {
    id: threadId,
    text: (apiText || (kindOf(reply) !== "text" ? `[${kindLabel(kindOf(reply))}]` : "")).slice(0, 300),
    mine: Boolean(reply?.from?.is_bot),
  };
  return { id: threadId, source: "thread", target };
}

function herNight(extra = {}) {
  const sched = nights.ensureWindow(mem.state, { t: nowBerlin(), mood: mood.currentMood(mem.state), ...extra });
  if (sched.fresh) {
    delete sched.fresh;
    mem.saveSoon();
  }
  return sched;
}

/** Plain words for why her initiations are holding, for her internal notes. */
function heldNote() {
  const until = mem.holding();
  if (!until) return "";
  const mins = Math.max(1, Math.round((until - Date.now()) / 60000));
  return `he said he would come back later (${mem.state.holdWhy || "away"}) - you know better than to spam someone who just said that; it has been about ${mins < 60 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`}`;
}

function nextPlan(burstCount) {
  const activeChat = Number(mem.state.activeChatUntil || 0) > Date.now();
  return planReaction({
    burstCount,
    sinceLastBotMs: idleSinceLastBotMs(),
    mood: herMood({ t: nowBerlin() }),
    sched: herNight(),
    activeChat,
    awakeUntil: mem.state.awakeUntil,
  });
}

function activeConversation() {
  return Number(mem.state.activeChatUntil || 0) > Date.now()
    || Number(mem.state.awakeUntil || 0) > Date.now();
}

function armAwakeWindow() {
  const min = Math.max(10, Number(CONFIG.schedule.forceAwakeMin || 10));
  const max = Math.min(15, Math.max(min, Number(CONFIG.schedule.forceAwakeMax || 15)));
  const minutes = rand(min, max);
  const until = Date.now() + minutes * 60000;
  mem.state.awakeUntil = Math.max(Number(mem.state.awakeUntil || 0), until);
  mem.state.activeChatUntil = Math.max(Number(mem.state.activeChatUntil || 0), until);
  mem.save();
}

function lifeShareCue(him, state) {
  if (him?.asking || him?.serious || !state) return "";
  const turns = Number(mem.state.turnsSinceLifeShare || 0);
  if (turns < 2) return "";
  const hooks = [
    ...(state.diary?.events || []).slice(0, 3),
    ...(mem.state.storylines || []).map((s) => `${s.title}: ${s.beat}`),
    identity.hobby()?.detail || "",
    identity.habit() || "",
  ].filter(Boolean);
  if (Math.random() < Number(CONFIG.dataScience?.proactiveShare ?? 0.45)) {
    hooks.unshift(roadmap.proactiveCue());
  }
  if (!hooks.length) return "";
  return `- Share ONE fresh, concrete detail from YOUR life in this reply (pick one naturally: ${hooks.slice(0, 4).join(" | ")}). Keep it as a clause or short second bubble, not a biography or a list.`;
}

/**
 * Her mood for this reaction: rolled if it ran out, and her state is saved so it
 * survives a restart. Everything else (timing, length, tone, temperature) reads
 * from here, which is what makes her inconsistent in a way that holds together.
 */
function herMood(ctx = {}) {
  const before = mem.state.mood?.key;
  // a short night follows her into the morning, like it does for everyone
  const sched = herNight();
  const t = ctx.t || nowBerlin();
  if (nights.minutesSinceWaking(sched, t) !== null && nights.sleptBadly(sched) && mem.state.sleep.wokeTiredOn !== t.dateStr) {
    mem.state.sleep.wokeTiredOn = t.dateStr;
    if (mood.wakeUp(mem.state, { hours: sched.hours })) {
      log(`[sleep] about ${sched.hours}h of sleep - she is not going to be chirpy this morning`);
    }
  }
  // he can move her: opening up, being sweet, explaining himself, making her
  // laugh, or answering in two words for ten messages in a row
  const turned = ctx.signal ? mood.react(mem.state, ctx.signal, { engagement: ctx.engagement || null }) : null;
  if (ctx.signal) mood.noteHisMessage(mem.state);
  // a grudge that turned into warmth is a fight that got made up, and that is a
  // thing a relationship remembers - and if there was something unresolved from
  // yesterday, this is the moment it is over
  if (turned && (before === "sulky" || before === "distant") && (turned.key === "warm" || turned.key === "soft")) {
    const closed = bond.resolveArc(mem.state);
    if (closed) log(`[bond] the thing from ${closed.since} is over - ${closed.cause || "something was off"}`);
    else {
      bond.noteRepair(mem.state);
      log("[bond] that is a fight that got made up rather than dropped");
    }
  }
  const m = mood.ensureMood(mem.state, { ...ctx, sinceLastUserMs: idleSinceLastUserMs(), tension: Boolean(bond.arc(mem.state)) });
  if (m.key !== before) {
    const how = turned && turned.key === m.key ? "the conversation turned you" : (m.why || "no particular reason");
    log(`[mood] now ${m.def.label} for ~${m.hours}h (${how})`);
    mem.saveSoon();
  }
  return m;
}

function idleSinceLastUserMs() {
  const last = mem.state.lastUserTs;
  return last ? Date.now() - last : Infinity;
}

function adopt(plan, why = "") {
  rx.plan = plan;
  clearTimeout(rx.timer);
  rx.timer = null;

  if (plan.mode === "ignore") {
    const batch = rx.msgs;
    mem.addUnanswered(unansweredEntries(batch));
    lastReaction = { ...plan, at: Date.now() };
    rx = null;
    // "read it and said nothing" is not the only silent option a person has.
    // Sometimes she reads it, leaves a heart on it and gets on with her day -
    // present, affectionate, no words. Costs nothing and needs no model call.
    reactions
      .heartInsteadOfWords(mem.state, mem.state.ownerId, batch[batch.length - 1], mood.currentMood(mem.state), { dry: DRY_RUN })
      .then((hearted) => { if (hearted) mem.saveSoon(); })
      .catch(() => {});
    log(`[timing] ${plan.mode} - she read it and stays quiet (${mem.unansweredCount()} message(s) left hanging)`);
    return;
  }

  // asleep is a hard stop with a long timer: the plan (and his messages) go into
  // state.json so a crash or a supervisor restart at 3am cannot eat the morning
  // answer. He can keep texting all night - they queue and go out with the rest.
  if (plan.mode === "asleep") {
    mem.addOvernight(unansweredEntries(rx.msgs));
  }

  lastReaction = { ...plan, at: Date.now() };
  log(`[timing] ${plan.mode} - answering in ${Math.round(plan.delayMs / 1000)}s${why ? ` (${why})` : ""}${plan.note ? ` | ${plan.note}` : ""}`);

  // She saw it. Sometimes that shows before her answer does: a reaction lands
  // while the words are still 20-75 minutes away (or on the few reads with no
  // words at all). Mood picks the odds and the emoji; the message's topic bends
  // which one. Never on her own messages, never in previews.
  if (!DRY_RUN && (plan.mode === "later" || plan.mode === "ignore") && rx.msgs.length) {
    const lastHis = rx.msgs[rx.msgs.length - 1];
    reactions
      .reactWhileReading(mem.state, mem.state.ownerId, lastHis, mood.currentMood(mem.state))
      .then((did) => { if (did) mem.saveSoon(); })
      .catch(() => {});
  }

  let wait = Math.max(300, plan.delayMs);
  // a scripted conversation is about what she says, not how long she takes, so the
  // pauses collapse and a ten-turn chat finishes while you are still watching
  if (DRY_SCRIPT.length) wait = 1200;
  else if (DRY_RUN && wait > 20000) {
    log(`[dry-run] shortening that ${gapWords(wait)} wait to 3s so the preview finishes`);
    wait = 3000;
  }
  rx.timer = setTimeout(() => {
    fireReaction().catch((err) => logErr("[bot] reaction failed:", err.message));
  }, wait);
}

function scheduleReaction(batch) {
  if (!mem.state.ownerId || !batch.length) return;

  // an armed "/force with nothing pending" latch: THIS message is answered now,
  // no matter what the timing dice would have said ("/force" then "hey" => now)
  if (mem.state.forceNext) {
    mem.state.forceNext = false;
    mem.save();
    const forced = {
      mode: "instant",
      delayMs: 400,
      note: "he sent /force a moment ago - he wants your answer right now, no delay, like you were already holding your phone",
    };
    if (rx) {
      if (rx.plan?.mode === "asleep") mem.takeOvernight();
      clearTimeout(rx.timer);
      for (const msg of batch) if (!rx.msgs.some((x) => sameMessage(x, msg))) rx.msgs.push(msg);
      rx.count = rx.msgs.length;
    } else {
      rx = { msgs: batch.slice(), count: batch.length, firstAt: Date.now(), plan: null, timer: null };
    }
    adopt(forced, "/force armed");
    return;
  }

  if (rx) {
    // more messages while he waits: she is not starting over, she just has more
    // to read - only a "left on read" plan can be turned into a real answer
    // ...unless he is just correcting a typo: "i was chatting..." 20s after the
    // same sentence with one word changed. One answer, not two.
    for (const msg of batch) {
      const near = rx.msgs.find((x) => sameMessage(x, msg));
      if (near) {
        log(`[batch] near-duplicate within ${Math.round((Date.now() - (rx.firstAt || Date.now())) / 1000)}s - answering once`);
        continue;
      }
      rx.msgs.push(msg);
    }
    rx.count = rx.msgs.length;
    if (!rx.count) return;
    if (rx.plan?.mode === "asleep") {
      // the morning answer is already set - he kept texting, it joins the same
      // reply. A busy window must not bury the night backlog either.
      return;
    }
    if (rx.plan?.mode === "ignore" || rx.plan?.mode === "later") {
      const fresh = nextPlan(rx.count);
      if (fresh.mode !== "ignore") adopt(fresh, "he kept texting");
    }
    return;
  }

  // a resend within 90s (typo fix, double-tap) is one message, not two
  const deduped = [];
  for (const msg of batch) {
    if (!deduped.some((x) => sameMessage(x, msg))) deduped.push(msg);
    else log("[batch] near-duplicate dropped before planning");
  }
  if (!deduped.length) return;
  rx = { msgs: deduped, count: deduped.length, firstAt: Date.now(), plan: null, timer: null };
  adopt(nextPlan(rx.count));
}

/** Same message twice: ~same words within 90 seconds (a typo resend). */
function sameMessage(a, b) {
  if (!a || !b || a === b) return false;
  const ta = String(a.text || a.caption || "").trim().toLowerCase();
  const tb = String(b.text || b.caption || "").trim().toLowerCase();
  if (!ta || !tb) return false;
  const norm = (s) => s.replace(/[\p{P}\p{S}]+/gu, "").replace(/\s+/g, " ");
  const x = norm(ta);
  const y = norm(tb);
  if (!x || !y) return false;
  if (x === y) return true;
  // one word difference at most ("with" -> "wish")
  if (Math.abs(x.length - y.length) > 6) return false;
  const wa = new Set(x.split(" "));
  const wb = new Set(y.split(" "));
  let diff = 0;
  for (const w of wa) if (!wb.has(w)) diff += 1;
  for (const w of wb) if (!wa.has(w)) diff += 1;
  return diff <= 2 && wa.size >= 3;
}

/**
 * He texted overnight and a restart wiped the in-memory timer? The queue in
 * state.json still has his messages, so she answers them once she is up - no
 * matter how many times the supervisor had to restart her during the night.
 */
function restoreOvernight() {
  if (!mem.state.ownerId || !mem.overnightCount()) return;
  const items = mem.takeOvernight();
  const t = nowBerlin();
  const sched = herNight();
  const stillAsleep = nights.isAsleepAt(sched, t);
  const fresh = nights.minutesSinceWaking(sched, t, 120); // up within the last two hours
  const plan = { mode: "asleep", delayMs: 0, note: "" };
  if (stillAsleep) {
    // booted in the middle of the night: sleep on, answer at her real wake time
    const p = wakePlan({ t, sched });
    plan.delayMs = p.delayMs;
    plan.note = p.note;
  } else if (fresh !== null) {
    // just got up: the wait is her not being a morning person, not the night
    plan.delayMs = Math.min(wakePlan({ t, sched }).delayMs, 25 * 60000);
    plan.note = "you were asleep when he wrote and have only just picked your phone up";
  } else {
    // machine was off all morning: she finds his night messages whenever she
    // picks the phone up now, and answers like a person catching up
    plan.delayMs = rand(45000, 8 * 60000);
    plan.note = "he wrote these while you were asleep and you are only seeing them now - answer them like you just found them, no drama about it";
  }
  log(`[night] ${items.length} message(s) he sent while she was asleep - ${stillAsleep ? `still night, answering when she wakes (${gapWords(plan.delayMs)})` : fresh !== null ? "she just got up" : "she is up, answering now"}`);
  rx = { msgs: items.map((it) => ({ message_id: it.id, text: it.text })), count: items.length, firstAt: Date.now(), plan: null, timer: null };
  // mode "asleep" makes adopt() re-file them in state.json, so even a crash
  // between now and the send cannot lose them a second time
  adopt(plan, "her phone remembered his night messages");
}

/**
 * He edited a message. Her memory holds the old version as if he had said it, so
 * she would answer words that no longer exist - which is exactly the kind of thing
 * that makes a chat partner feel like a database instead of a person. The record
 * is corrected, and if she has not answered yet, her pending reply gets the new
 * version too.
 */
async function handleEdit(msg) {
  const st = mem.state;
  if (!msg || msg.chat?.type !== "private" || !msg.from || msg.chat.id !== st.ownerId) return;
  const edited = String(msg.text || msg.caption || "").trim();
  if (!edited) return;
  const before = mem.findInbox(msg.message_id);
  if (before && before.text === edited) return; // an edit that changed nothing she can see
  mem.updateInbox({ id: msg.message_id, text: messageLabel(msg), ts: (msg.edit_date || msg.date || 0) * 1000 });
  st.lastEdit = { text: truncate(edited, 140), was: before ? truncate(before.text, 90) : "", at: Date.now() };
  if (rx) {
    const held = rx.msgs.find((x) => Number(x.message_id) === Number(msg.message_id));
    if (held) {
      held.text = edited;
      log("[edit] her pending answer is now about the edited version");
      return;
    }
  }
  mem.saveSoon();
  log(`[edit] he changed a message${before ? `: "${truncate(before.text, 40)}" -> "${truncate(edited, 40)}"` : ""}`);
}

async function fireReaction() {
  const current = rx;
  if (!current) return;
  rx = null;
  clearTimeout(current.timer);
  await processBatch(current.msgs, current.plan);
}

// --------------------------------------------------------------- reactions
// A reaction is a message with no words in it, and a girl notices. His heart on
// her line is the one piece of feedback that used to be thrown away entirely.

/**
 * He reacted to one of her messages. She always learns about it (it goes into her
 * next reply's notes either way); on her very last bubble, in a warm or clingy
 * mood, she may answer it out loud straight away - one short call, only then.
 */
async function handleReaction(ev) {
  const st = mem.state;
  if (!st.ownerId || ev?.chat?.id !== st.ownerId) return;
  const mine = mem.findAnyMessage(ev.message_id);
  if (!mine?.mine) return;
  const note = reactions.noteHis(st, ev, { herText: mine.text, ownerId: st.ownerId });
  if (!note) return;
  mem.saveSoon();
  log(`[reaction] he left ${note.emoji} on hers: "${truncate(mine.text, 50)}"`);

  const moodNow = mood.currentMood(st);
  const latest = (st.sent || [])[st.sent.length - 1]?.id === ev.message_id;
  const eager = moodNow?.key === "clingy" || moodNow?.key === "warm";
  if (!latest || !eager || rx || DRY_RUN) return;
  if (Math.random() > 0.5) return; // the rest of the time she brings it up next time
  await answerReaction(note, moodNow);
}

/** One short line, out loud, about the heart he just left. */
async function answerReaction(note, moodView) {
  const st = mem.state;
  const usageKey = usage.begin({ kind: "reaction-reply" });
  const dress = style.plan(moodView, { energy: "normal", closeness: bond.closeness(st) });
  try {
    const raw = await llm(
      [
        {
          role: "system",
          content: [SYSTEM_BASE, contextBlock(st), mood.block(moodView), toneBlock(st.tone, null), reactionBlock(st)].filter(Boolean).join("\n\n"),
        },
        { role: "user", content: "(Internal: he just put a reaction on one of your messages instead of writing anything. Send ONE short line about it - you noticed, and you are pleased, in your own way, without making a thing out of it. At most 12 words, lowercase, no question, no emojis.)" },
      ],
      { maxTokens: 60, temperature: mood.temperature(moodView) },
    );
    const shaped = shapeReply(raw, dress).text;
    if (!shaped) return;
    reactions.acknowledge(st);
    mem.noteHerQuestion(shaped);
    mem.pushHistory("assistant", shaped);
    mem.noteDayStat({ hers: 1 });
    await sendBubbles(shaped, { chatId: st.ownerId, replyTo: note.messageId, usageKey, maxBubbles: 2 });
    mem.save();
    log("[reaction] she answered his reaction out loud");
  } catch (err) {
    logErr("[reaction] answer failed:", err.message);
  } finally {
    usage.end(usageKey);
  }
}

/**
 * "put a reaction on my message" - an explicit request is done, not rolled for.
 * Like "remind me": she agrees in her own voice and does it right away. The same
 * API-shape learning and the same daily ceiling as her unprompted hearts apply
 * (a request cannot make her a reaction bot, only punctual), except in previews,
 * where the request is announced and nothing is sent.
 */
async function doReactionRequest(msg) {
  const st = mem.state;
  const chatId = st.ownerId;
  const req = reactions.parseRequest(String(msg.text || ""));
  const target = reactions.targetOf(msg);
  if (!target) {
    await sendBubbles(pick(["on what. send the thing first", "reaction to what, theres nothing there"]), { chatId });
    log("[reaction] request without a target - she asked which message");
    return true;
  }
  const emoji = req?.emoji || "❤";
  if (DRY_RUN) {
    log(`[reaction] (dry-run) she would put ${emoji} on message ${target} because he asked`);
    return true;
  }
  if (st.reactionStyle === "off") {
    await sendBubbles(pick(["i tried, this thing wont let me react. rude of it", "telegram refuses my reactions here. i said it with words instead"]), { chatId });
    log("[reaction] request refused by the server earlier - she says so instead");
    return true;
  }
  const ok = await reactions.send(st, chatId, target, emoji);
  mem.saveSoon();
  if (!ok) {
    await sendBubbles(pick(["i tried, this thing wont let me react. rude of it", "telegram refuses my reactions here. i said it with words instead"]), { chatId });
    return true;
  }
  reactions.noteSent(st);
  // An asked-for reaction is never argued with: the daily cap only governs the
  // ones she leaves on her own. First ask in a while gets a short line with it;
  // the second and third ask in a row just get the heart - a person does not
  // re-narrate the same favour every minute, she taps it and moves on.
  const nowMs = Date.now();
  const recentAsk = Number(st.lastRequestedReactionAt || 0);
  st.lastRequestedReactionAt = nowMs;
  const moodNow = mood.currentMood(st);
  const dress = style.plan(moodNow, { energy: "normal", closeness: bond.closeness(st) });
  const ack = nowMs - recentAsk > 10 * 60000
    ? style.prepare(pick(["there. happy now", "done. one reaction, as requested", "ok ok. there it is", "fine. but i do that because i want to anyway"]), dress)
    : "";
  mem.pushHistory("user", String(msg.text || "").trim());
  if (ack) mem.pushHistory("assistant", ack);
  mem.state.userMsgCount += 1;
  mem.state.lastUserTs = Date.now();
  mem.noteDayStat({ his: 1, hers: ack ? 1 : 0, text: String(msg.text || "").trim() });
  mem.save();
  if (ack) await sendBubbles(ack, { chatId, replyTo: msg.message_id });
  log(`[reaction] he asked for it - she put ${emoji} on message ${target}${ack ? "" : " (quietly - he just asked a minute ago)"}`);
  return true;
}

async function handleMessage(msg) {
  if (!msg || msg.chat?.type !== "private" || !msg.from) return;
  const chatId = msg.chat.id;
  const st = mem.state;
  const text = String(msg.text || "").trim();

  // privacy: the first private message ever claims the bot, everyone else is ignored
  if (!st.ownerId) {
    mem.bindOwner(chatId, msg.from.first_name || msg.from.username || "Commander");
    log(`[bind] this bot is now locked to chat ${chatId} (${st.ownerName}). everybody else will be ignored.`);
    let greeting = "";
    try {
      greeting = await llm(
        [
          { role: "system", content: `${SYSTEM_BASE}\n\n${contextBlock(mem.state)}` },
          { role: "user", content: FIRST_MEET_HINT },
        ],
        { maxTokens: 140, temperature: 1.0 },
      );
    } catch (err) {
      logErr("[bind] greeting generation failed:", err.message);
    }
    await sendBubbles(greeting || welcomeLine(), { chatId });
    mem.pushHistory("assistant", tidyReply(greeting || "") || "hey. i'm Negev. you're mine now");
    return;
  }
  if (chatId !== st.ownerId) {
    log(`[ignore] message from stranger chat ${chatId}`);
    return;
  }

  // every message that reaches her is logged, so "it did not arrive" and
  // "she ignored it" can always be told apart from the log
  log(`[msg] ${chatId}${msg.reply_to_message ? ` (reply to ${msg.reply_to_message.message_id})` : ""}: ${truncate(text || `[${kindOf(msg)}]`, 80)}`);

  // "!token" / "!tokenall" - and the slash variants, so they also work as
  // registered Telegram commands from the command menu
  const usageMode = usage.parseCommand(text);
  if (usageMode) {
    await handleUsageCommand(msg, usageMode);
    return;
  }

  // "put a reaction on my message" - an explicit request is done now, like a
  // reminder. /react is the spelled-out variant of the same thing. It has to sit
  // before the slash-command branch or /react would die as an unknown command.
  // The request message itself never reaches her reply dice (a request is not a
  // conversation turn) - but a harmless-byproduct cancellation is:
  if (reactions.parseRequest(text) || /^[/!]react\b/i.test(text)) {
    if (rx) {
      clearTimeout(rx.timer);
      rx = null;
      lastReaction = { mode: "done", delayMs: 0 };
    }
    await doReactionRequest(msg);
    return;
  }

  if (text.startsWith("/")) {
    // Every slash command is control-plane traffic. Known commands may send a
    // report, but an unknown command must never fall through to the girlfriend
    // model as if it were ordinary conversation.
    await handleCommand(msg);
    return;
  }
  // !force as a plain-text alias of /force (handleCommand only sees slash text)
  if (/^!force\b/i.test(text) && (await handleCommand(msg))) return;
  // !recap: the week in her voice. Typed like her, one model call, no memory writes.
  if (/^[/!]?recap[.!?]*$/i.test(text)) {
    await handleRecap(msg);
    return;
  }
  if (!msg.text && !msg.caption && kindOf(msg) === "text") return; // nothing usable

  const forget = forgetRequest(text);
  if (forget) {
    const previous = forget.previous
      ? [...mem.history].reverse().find((h) => h?.r === "u")?.t || ""
      : "";
    const removed = mem.forgetMemory(forget.query, previous);
    const ack = removed ? "ok. that is gone from my head now" : "ok. i wont keep that";
    mem.pushHistory("assistant", ack);
    st.userMsgCount += 1;
    st.lastUserTs = Date.now();
    st.activeChatUntil = Date.now() + Number(CONFIG.schedule.activeConversationMin || 15) * 60000;
    mem.save();
    await sendBubbles(ack, { chatId, replyTo: msg.message_id });
    log(`[forget] natural request removed ${removed} record(s)${forget.query ? ` matching "${truncate(forget.query, 80)}"` : " from the previous message"}`);
    return;
  }

  // remember his messages so a later reply can be hung on any of them
  mem.pushInbox({
    id: msg.message_id,
    text: messageLabel(msg),
    ts: msg.date ? msg.date * 1000 : Date.now(),
  });
  // ...and when he is up and answering, so her own texts can land in those hours
  signal.noteActivity(st, msg.date ? msg.date * 1000 : Date.now());
  // he is putting her right about something: that is a memory-integrity job, not a
  // mood one - she owns it in one breath and the wrong version goes
  if (signal.readHis(text).correction) {
    // ...unless she is right. Caving to a correction that contradicts what he told
    // her himself is the most assistant-like thing she could do, so her own memory
    // gets a vote before the block is written: it is the correction that is checked
    // against the facts, not the other way round.
    const held = heldGround(text);
    st.correction = held
      ? { text: truncate(text, 140), at: Date.now(), holdsGround: true, held }
      : { text: truncate(text, 140), at: Date.now() };
    log(held
      ? `[fix] he corrected her, but her own note says otherwise ("${truncate(held, 60)}") - she will hold her ground`
      : "[fix] he corrected her - she will own it in the next reply");
  }

  // anything he writes settles the questions she asked a while ago, answers the
  // promise that he would come back, and resets her unanswered-initiation counter
  mem.settleOpenQuestions();
  if (st.holdUntil) {
    st.holdUntil = 0;
    st.holdWhy = null;
    mem.resetInitiations();
    mem.saveSoon();
    log("[holds] he is back - initiations unblocked");
  }

  // "remind me ..." / "remember ..." never go through the reaction dice: a girl
  // who says "ok deal" and then ignores her own promise is a broken promise, not
  // a personality. They are handled here, directly, before any timing plan.
  const noteText = String(msg.text || "").trim();
  if (noteText) {
    const reminderTask = tasks.parseTask(noteText);
    if (reminderTask) {
      tasks.addTask(reminderTask);
      mem.pushHistory("user", noteText);
      const ack = style.prepare(ackReminder(reminderTask), style.plan(herMood({ t: nowBerlin() }), { energy: "normal" }));
      mem.pushHistory("assistant", ack);
      mem.state.userMsgCount += 1;
      mem.state.lastUserTs = Date.now();
      mem.save();
      await sendBubbles(ack, { chatId });
      maybeExtractFacts();
      return;
    }
    const rememberFacts = mem.parseRemember(noteText);
    if (rememberFacts) {
      mem.pushHistory("user", noteText);
      // a pinned fact that carries a day gets a check-in on that day (tasks.js)
      for (const fact of rememberFacts) {
        const dayTask = tasks.parseFactDay(fact);
        if (dayTask && tasks.addTask(dayTask)) log(`[tasks] she will check in on ${dayTask.date}: "${fact}"`);
      }
      const ack = style.prepare(ackRemember(rememberFacts), style.plan(herMood({ t: nowBerlin() }), { energy: "normal" }));
      mem.pushHistory("assistant", ack);
      mem.state.userMsgCount += 1;
      mem.state.lastUserTs = Date.now();
      mem.save();
      await sendBubbles(ack, { chatId });
      maybeExtractFacts();
      return;
    }
  }

  enqueue(msg);
}

// ------------------------------------------------------------------- boot

async function main() {
  initFileLog();
  if (DRY_RUN) mem.setReadOnly(true);
  else await acquireLock();
  mem.load();
  setUsageSink(usage.record); // every completion is priced into the ledger

  const me = await tg("getMe");
  if (!me.ok) {
    logErr(`[boot] cannot reach Telegram: ${me.error}`);
    process.exit(1);
  }
  log(`[boot] logged in as @${me.result.username} (id ${me.result.id})`);

  await tg("deleteWebhook", { drop_pending_updates: false });
  await tg("setMyName", { name: CONFIG.botName });
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "wake her up" },
      { command: "status", description: "her pulse" },
      { command: "reset", description: "wipe her memory" },
      { command: "remember", description: "everything she keeps in her head about you" },
      { command: "tasks", description: "reminders and check-ins she is holding" },
      { command: "forget", description: "remove a memory (e.g. /forget sister)" },
      { command: "web", description: "show the web-reader limit" },
      { command: "quiet", description: "she will not text first (e.g. /quiet 2h)" },
      { command: "awake", description: "cancel quiet mode / holds" },
      { command: "force", description: "answer right now: /force <text>, or /force then your next message" },
      { command: "react", description: "she reacts to the message you reply to (or her last reaction, asked and done)" },
      { command: "promises", description: "open promises she is tracking" },
      { command: "canon", description: "her own life, as she told it" },
      { command: "media", description: "media you sent that she remembers" },
      { command: "weather", description: "what she thinks the sky is doing" },
      { command: "her", description: "her biography: favourites, hobbies, places" },
      { command: "bond", description: "what the two of you have become so far" },
      { command: "token", description: "price the message you reply to (reply to her with /token)" },
      { command: "tokenall", description: "tokens and cost of everything so far" },
    ],
  });
  await tg("setMyDescription", {
    description: "reply to any of her messages with !token to see what that reply cost in tokens and money. !tokenall for everything so far.",
  });

  // her biography rolls once, here, so her very first reply already knows who she is
  const bio = identity.ensure();
  log(`[boot] her identity: fav song "${bio.favorites.song}" | ${bio.hobbies.map((h) => h.key).join(", ")} | been to ${bio.places.visited.join(", ")}`);

  // the operator's live settings, then the control panel (localhost only)
  settings.load();
  internals.register({
    herNight,
    herMood,
    activeConversation,
    handlePanelText: (text) => {
      // exactly what a Telegram message would do: join the batch queue
      enqueue({ message_id: 0, text: String(text || ""), chat: { id: mem.state.ownerId, type: "private" }, from: { is_bot: false, first_name: mem.state.ownerName || "Commander" } });
      return Boolean(mem.state.ownerId);
    },
  });
  startPanel();

  const swept = media.sweepTmp();
  if (swept) log(`[boot] cleaned ${swept} stale temp file(s)`);

  const tools = media.resolveTools();
  log(`[boot] local pipeline: ${media.pipelineAvailable() ? `${tools.pipeline.script} (whisper ${CONFIG.pipeline.model}, ffmpeg ${tools.ffmpeg})` : "NOT found - videos will fall back to frames only"}`);
  log(`[boot] model: ${currentModel()} | timezone: ${CONFIG.timezone} | pid ${process.pid} | singleton port ${lockStatus().port}`);
  log(`[boot] human timing: on - she answers instantly or late; waking-hour messages are not dropped (${mem.unansweredCount()} older message(s) still unanswered)`);
  log(mem.state.ownerId
    ? `[boot] locked to chat ${mem.state.ownerId}`
    : "[boot] NOT bound yet - the first private message claims this bot");

  // he may have texted overnight, and a restart must not eat the morning answer
  restoreOvernight();

  // her spontaneous texts carry their own usage bucket, so !token works on them
  // too - and they get the same imperfect typing as her replies
  startProactive((text, opts = {}) => {
    const dress = style.plan(mood.currentMood(mem.state));
    const shaped = style.prepare(text, dress);
    return sendBubbles(shaped, { chatId: mem.state.ownerId, ...opts });
  });

  // she does text first on her own schedule, but that would drop unrelated lines
  // into the middle of a scripted conversation
  if (DRY_SCRIPT.length) stopProactive();
  if (DRY_RUN) return DRY_SCRIPT.length ? dryRunScript() : dryRunPreview();

  let backoff = 2000;
  for (;;) {
    const res = await tg("getUpdates", {
      timeout: 50,
      offset,
      // reactions are a signal too, and an edit changes what she thinks he said
      allowed_updates: ["message", "edited_message", "message_reaction"],
    });
    if (!res.ok) {
      const conflict = /conflict|409/i.test(res.error || "");
      logErr(`[poll] ${res.error}`);
      await sleep(conflict ? 10000 : backoff);
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    backoff = 2000;
    for (const update of res.result) {
      offset = update.update_id + 1;
      if (update.message_reaction) {
        handleReaction(update.message_reaction).catch((err) => logErr("[reaction] handler error:", err.message));
        continue;
      }
      if (update.edited_message) {
        handleEdit(update.edited_message).catch((err) => logErr("[edit] handler error:", err.message));
        continue;
      }
      handleMessage(update.message).catch((err) => logErr("[bot] handler error:", err.message));
    }
  }
}

// ------------------------------------------------------------- dry run
// NEGEV_DRY_MESSAGE="look at this" NEGEV_DRY_RUN=1 node bot.js
// She decides how fast she would answer and writes the reply she would send, but
// nothing goes to Telegram and nothing is written to memory. Safe to run while
// she is live, because it never touches the singleton lock or the data files.
async function dryRunPreview() {
  const message = String(process.env.NEGEV_DRY_MESSAGE || "hey. you there?");
  const runForMs = Number(process.env.NEGEV_DRY_WAIT_MS || 45000);

  if (!mem.state.ownerId) {
    logErr("[dry-run] no owner bound yet - send her /start on Telegram first");
    process.exit(1);
  }
  // NEGEV_DRY_RESTORE=1 (or ="the text") seeds his night messages and runs the
  // real restart-recovery path: nothing is sent, nothing is saved.
  if (process.env.NEGEV_DRY_RESTORE) {
    const seeded = process.env.NEGEV_DRY_RESTORE === "1" ? "ok so what did you think of it" : String(process.env.NEGEV_DRY_RESTORE);
    mem.addOvernight([{ id: 990001, text: seeded, ts: Date.now() - 6 * 3600000 }]);
    log(`[dry-run] seeded his night message: "${seeded}"`);
  }
  // NEGEV_DRY_TASKS="what|date|whenMin,..." seeds the task ledger and runs one
  // tasks tick, so a reminder firing can be watched without waiting for 6pm.
  if (process.env.NEGEV_DRY_TASKS) {
    for (const spec of process.env.NEGEV_DRY_TASKS.split(";")) {
      const [what, date, whenMin, kind] = spec.split("|");
      tasks.addTask({ what, date, whenMin: Number(whenMin), kind: kind || "reminder", byWhom: "him" });
    }
    log(`[dry-run] seeded ${process.env.NEGEV_DRY_TASKS.split(";").length} task(s)`);
    stopProactive();
    await tasksTickPreview();
  }
  restoreOvernight();
  log("[dry-run] previewing one reaction: nothing is sent, nothing is saved");
  log(`[dry-run] he says: "${message}"`);
  // goes through the real handler, so the plan, the debounce and any quoting all
  // behave exactly as they would for a live message
  await handleMessage({
    message_id: 990001,
    date: Math.floor(Date.now() / 1000),
    chat: { id: mem.state.ownerId, type: "private" },
    from: { first_name: mem.state.ownerName || "Commander" },
    text: message,
    ...(process.env.NEGEV_DRY_REPLY_TO ? { reply_to_message: { message_id: Number(process.env.NEGEV_DRY_REPLY_TO) } } : {}),
  });
  setTimeout(() => {
    log(`[dry-run] preview finished (last reaction: ${lastReaction ? `${lastReaction.mode}, ${lastReaction.delayMs === null ? "no answer" : gapWords(lastReaction.delayMs)}` : "none"})`);
    process.exit(0);
  }, Number.isFinite(runForMs) ? runForMs : 45000);
}

/**
 * One tasks tick for the preview: fires what is due through the real send path
 * (which prints instead of sending), then exits so the preview ends cleanly.
 */
async function tasksTickPreview() {
  const mod = await import("./proactive.js");
  await mod.tasksTickForPreview(nowBerlin());
  log("[dry-run] tasks preview finished");
  process.exit(0);
}

/**
 * His messages, one after another, through the real handler - so she keeps the
 * whole conversation in mind (her own replies included) exactly as she would in
 * Telegram. Nothing is sent and nothing is saved, and an ignored message stays
 * ignored rather than being retried.
 */
async function dryRunScript() {
  log(`[dry-run] conversation preview: ${DRY_SCRIPT.length} of his messages, nothing sent, nothing saved`);
  if (DRY_TRANSCRIPT) log(`[dry-run] transcript: ${DRY_TRANSCRIPT} (grade it with: node grader.js ${DRY_TRANSCRIPT})`);
  for (const [i, turn] of DRY_SCRIPT.entries()) {
    log(`\n[dry-run] him (${i + 1}/${DRY_SCRIPT.length}): ${turn}`);
    transcriptLine("u", turn);
    const replied = new Promise((resolve) => { dryTurnResolve = resolve; });
    await handleMessage({
      message_id: 990100 + i,
      date: Math.floor(Date.now() / 1000),
      chat: { id: mem.state.ownerId, type: "private" },
      from: { first_name: mem.state.ownerName || "Commander" },
      text: turn,
    });
    // she may leave him on read (that is her right), so the wait is bounded
    await Promise.race([replied, sleep(30000)]);
    dryTurnResolve = null;
    await sleep(700);
  }
  // the last reply's bucket may still be open (its memory passes take a moment),
  // so give them a beat before the preview reports what the whole thing cost
  await sleep(2500);
  const spent = usage.renderTotals().split("\n").filter((l) => /^- (model calls|total|cost)/.test(l));
  log(`\n[dry-run] what this preview cost - nothing was sent, nothing was saved:\n${spent.join("\n")}`);
  process.exit(0);
}

process.on("uncaughtException", (err) => logErr("[uncaught]", err?.stack || err));
process.on("unhandledRejection", (err) => logErr("[unhandled]", err?.stack || err));
process.on("SIGINT", () => {
  mem.save();
  releaseLock();
  log("[boot] saving memory and exiting");
  process.exit(0);
});
process.on("SIGTERM", () => {
  mem.save();
  releaseLock();
  process.exit(0);
});
process.on("exit", releaseLock);

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (IS_MAIN) {
  main().catch((err) => {
    logErr("[boot] fatal:", err?.stack || err);
    process.exit(1);
  });
}
