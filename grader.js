// Does it actually read like a person?
//
// Everything else in this project asserts mechanics: the smile rate matches the
// mood, the wait never exceeds 25 minutes, a sulky girl does not heart your
// message. None of that says whether a conversation *reads* like two people.
// This file is the missing half: it takes a transcript and turns it into numbers
// you can argue with, plus the exact lines that made it look like a machine.
//
//   node grader.js                       grade your real chat log (data/history.json)
//   node grader.js path/to/transcript.txt grade one file
//   node grader.js --scenarios           run the dry-run scenarios and grade those
//   node grader.js --scenarios --repeat=3   run each one three times and report the spread

import "./dotenv.js"; // .env secrets first, before anything reads process.env
//   node grader.js --scenarios --repeat=3 --save   record that as the baseline
//   node grader.js --gate                re-run and fail if the mean dropped past that spread
//   node grader.js --model               add the one paid check (see below)
//
// Two sources, one shape:
//   * `data/history.json` - what she actually sent. Turns are intact; individual
//     bubbles are not (history stores a whole reply as one line), so the bubble
//     dimensions are reported as unknown instead of guessed.
//   * `data/transcripts/*.txt` and the dry-run harness - one line per Telegram
//     message (`HIM: ...` / `YOU: ...`), consecutive lines from the same side
//     being one turn. Bubbles and gaps are real here, so everything is scored.
//
// Everything below is free, local and deterministic. The one thing rules cannot
// see is whether the whole thing *feels* like a person, so `--model` buys exactly
// one extra call per transcript for a 1-10 verdict with a reason. It costs
// money, it is off by default, and it is a second opinion, not the truth.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG, PATHS } from "./config.js";
import { llm, tidyReply } from "./deepseek.js";
import { nowBerlin } from "./util.js";
import * as style from "./style.js";
import * as signal from "./signal.js";
import * as usage from "./usage.js";

const ROOT = process.cwd();

// --------------------------------------------------------------- transcripts
/**
 * `HIM: ...` / `YOU: ...` per delivered message, `[hh:mm]` and a leading ISO
 * timestamp both optional. Consecutive lines from the same side are one turn
 * (she sends three bubbles, he replies once), which is what makes the bubble and
 * gap dimensions measurable at all.
 */
export function parse(text, label = "transcript") {
  const turns = [];
  let last = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let at = null;
    const stamp = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]\s*/);
    if (stamp) {
      const ms = Date.parse(stamp[1]);
      if (!Number.isNaN(ms)) at = ms;
    }
    const role = line.replace(/^\[[^\]]*\]\s*/, "").match(/^(HIM|YOU|He|She|user|assistant)\s*:\s*(.*)$/i);
    if (!role) continue; // narration, logs, anything that is not a message
    const r = /^(him|he|user)$/i.test(role[1]) ? "u" : "a";
    const t = role[2].trim();
    if (!t) continue;
    if (last && last.r === r && at !== null && last.at !== null && at - last.at < 120000) {
      last.bubbles.push(t);
      last.at = at;
    } else {
      const turn = { r, t, bubbles: [t], at };
      turns.push(turn);
      last = turn;
    }
  }
  return { label, turns, bubblesKnown: true };
}

/**
 * Any transcript file: the dry-run format, or a Telegram export if it ends in
 * .html. Takes the file rather than the shape, because the caller usually got a
 * path from a command line.
 */
export function loadFile(file) {
  if (/\.html?$/i.test(file)) return loadTelegramExport(file);
  const text = fs.readFileSync(file, "utf8");
  return parse(text, path.basename(file));
}

/** He has to send at least this much for a chat log to be worth grading. */
const MIN_HIS_TURNS = 8;

/**
 * The real conversation, in order. Bubbles were already collapsed by sendBubbles
 * before they were stored, so this source scores everything except bubble shapes.
 */
export function loadHistory(file = PATHS.history, { turns = 80 } = {}) {
  let raw = "[]";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { label: "history", turns: [], error: "no history file yet" }; }
  let list = [];
  try { list = JSON.parse(raw); } catch { return { label: "history", turns: [], error: "history is not readable json" }; }
  const slice = (Array.isArray(list) ? list : []).slice(-Math.max(MIN_HIS_TURNS * 2, turns * 2));
  const out = [];
  for (const h of slice) {
    if (!h || !h.t) continue;
    const r = h.r === "a" ? "a" : "u";
    const at = Number(h.ts) || null;
    const prev = out[out.length - 1];
    if (prev && prev.r === r && at !== null && prev.at !== null && at - prev.at < 120000) {
      prev.bubbles.push(String(h.t));
      prev.at = at;
    } else {
      out.push({ r, t: String(h.t), bubbles: [String(h.t)], at });
    }
  }
  return { label: "history (your real chat)", turns: out, bubblesKnown: false };
}

// ------------------------------------------------------- telegram exports
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);

/** "16.09.2026 21:37:30 UTC+01:00" -> epoch ms, or null. */
function exportTime(title) {
  const m = String(title || "").match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+UTC([+-]\d{2}):?(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s, offH, offM] = m;
  const offset = offH ? (offH.startsWith("-") ? -1 : 1) * (Math.abs(Number(offH)) * 60 + Number(offM || 0)) : 0;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offset * 60000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A Telegram Desktop HTML export, read as a chat transcript.
 *
 * This is the sample that actually matters: every synthetic scenario in this file
 * is a guess about how people talk, and your own log is the thing itself. The
 * export is better than the bot's own history file, too - it keeps each bubble as
 * its own message with its own timestamp, so bubbles and real answer gaps are
 * measurable instead of collapsed.
 *
 * Chat export settings: pick "Machine-readable JSON" if you prefer, but the HTML
 * one is what Telegram gives by default and it carries everything needed here.
 */
/**
 * The bot's own command replies, which are not conversation and must not be
 * graded as if they were. `/estimateall` prints a ~1,000-character ledger and
 * `/help` prints the whole command list; on the first real export these three
 * dumps were counted as three of her messages, which made "text-sized messages"
 * and "she does not repeat herself" score her on a spreadsheet. Excluded, and
 * counted, so the number written in the report is about talking.
 */
function isSystemDump(text) {
  const t = String(text || "");
  if (/^overall conversation token estimate/i.test(t)) return true;
  if (/^[\s\S]{0,60}?\b(commands?|things (she|i) understands|memory examples):/i.test(t)) return true;
  if (/^-\s*(tracked since|ai provider replies counted|deepseek replies counted)/im.test(t)) return true;
  // a wall of "!cmd — description" lines is a help screen, not a message
  const listed = (t.match(/^\s*[!\/][\w-]+[\s\S]{0,40}?[\u2014-]/gm) || []).length;
  return listed >= 5;
}

export function loadTelegramExport(file) {
  let html = "";
  try { html = fs.readFileSync(file, "utf8"); } catch (err) {
    return { label: path.basename(file), turns: [], error: `could not read the export: ${err.message}` };
  }
  const title = decode((html.match(/<div class="text bold">\s*([\s\S]*?)\s*<\/div>/) || [])[1] || "her").trim();
  const marks = [...html.matchAll(/<div class="message (default|service)[^"]*"\s+id="(?:message)?([\w-]+)">/g)];
  if (!marks.length) {
    return { label: path.basename(file), turns: [], error: "no messages found - is this a Telegram chat export?" };
  }
  const turns = [];
  let sender = null;
  let skipped = 0;
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : html.length;
    const block = html.slice(from, to);
    if (marks[i][1] === "service") continue; // joins, pins, calls
    const name = decode((block.match(/<div class="from_name">\s*([\s\S]*?)\s*<\/div>/) || [])[1] || "").trim();
    if (name) sender = name;
    const r = sender && sender.toLowerCase() === title.toLowerCase() ? "a" : "u";
    const at = exportTime((block.match(/<div class="pull_right date details"[^>]*title="([^"]*)"/) || [])[1]);
    const raw = (block.match(/<div class="text">\s*([\s\S]*?)\s*<\/div>/) || [])[1] || "";
    const text = decode(raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) continue; // a sticker or a file with no caption
    if (isSystemDump(text)) { skipped += 1; continue; }
    // the bot logs its own attachments as "[photo: ...]" style notes when they
    // were his, and those lines are not part of what he typed
    const last = turns[turns.length - 1];
    if (last && last.r === r && at !== null && last.at !== null && at - last.at <= 120000) {
      last.bubbles.push(text);
      last.t = `${last.t}\n${text}`;
      last.at = at;
    } else {
      turns.push({ r, t: text, bubbles: [text], at });
    }
  }
  return {
    label: `${path.basename(file)} (her: ${title})`,
    turns,
    skipped,
    bubblesKnown: true,
    error: turns.length ? null : "the export had no readable messages",
  };
}

// ------------------------------------------------------------------ helpers
const HER = (t) => t.r === "a";
const words = (s) => String(s || "").toLowerCase().match(/[a-z']{2,}/g) || [];

/** How much of one message's wording shows up in another: 0..1, order-blind. */
function overlap(a, b, extract = words) {
  const A = new Set(extract(a));
  const B = new Set(extract(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
// her laugh, her <3, her :3 - and the single welded paren, which is the usual one.
// Counting only "))" scored the real chat at 1% marks, which was the grader being
// wrong rather than her: the habit that shipped that chat was "...now )".
const MARK = /(?:[a-z]\)+\s*$)|(?:\){2,}\s*$)|(?:\bx{1,2}d{2,}\b)|<3|(?::33?(?=\s|$))/imu;
const CONCRETE = /\b(i|im|i'm|my|me)\b/;

function capStart(t) {
  // the very first letter being a capital is the clearest giveaway that nobody
  // is typing this with two thumbs; "I" alone is a word, not a tell
  const first = String(t || "").trim()[0] || "";
  return first !== first.toLowerCase() && /[A-Za-z]/.test(first);
}

/**
 * Her bubble scores 0..1 per dimension; every one is explainable in a sentence.
 *
 * A dimension with nothing to measure reports `measurable: false` and is left out
 * of the score entirely. The alternative - scoring an empty chat 100 because no
 * dimension failed - is how a grader lies to you in the one direction that feels
 * good, so it is not allowed here.
 */
function dimensions({ turns, bubblesKnown = true }) {
  const hers = turns.filter(HER);
  const herLines = hers.flatMap((t) => t.bubbles);
  const dims = [];
  const add = (id, label, weight, score, detail, evidence = [], measurable = true) =>
    dims.push({ id, label, weight, score: Math.max(0, Math.min(1, score)), detail, evidence, measurable });

  // 1. did she answer him ---------------------------------------------------
  {
    const asked = [];
    for (let i = 0; i < turns.length; i += 1) {
      if (HER(turns[i])) continue;
      const q = signal.questionIn(turns[i].t);
      if (!q) continue;
      const next = turns.slice(i + 1).find(HER);
      if (!next) continue;
      asked.push({ q, ok: signal.answered(q, next.t), his: turns[i].t, her: next.t });
    }
    const hit = asked.filter((a) => a.ok).length;
    const misses = asked.filter((a) => !a.ok);
    add(
      "answering",
      "she answers what he actually asked",
      22,
      asked.length ? hit / asked.length : 0,
      asked.length ? `${hit}/${asked.length} of his questions got a reply that goes back to them` : "he never asked a direct question here - nothing to measure",
      misses.slice(0, 2).map((m) => `asked "${m.q.text.slice(0, 60)}" -> she said "${m.her.slice(0, 70)}"`),
      asked.length > 0,
    );
  }

  // 2. does she sound like a person -----------------------------------------
  const speaks = herLines.length > 0;
  {
    const bad = [];
    for (const t of herLines) {
      const lints = style.assistantSpeak(t).map((l) => l.match ? `"${l.match}"` : l.sample);
      if (EMOJI.test(t)) lints.push("an emoji");
      if (/\u2014/.test(t)) lints.push("an em dash");
      // ...but his name is hers to capitalise on purpose: "Commander thats actually
      // huge" is the nickname rule working, not a language model clearing its
      // throat, and scoring it as a tell is the grader inventing a fault. (An
      // acronym like "lol" opening a line is not a capital either.)
      const opensWithHisName = /^commanders?\b/i.test(t.trim());
      if (capStart(t) && !opensWithHisName && !/^[A-Z]{2,}\b/.test(t.trim())) lints.push("a capital at the start");
      if (/^[ \t]*(?:[-*\u2022]|\d+[.)])\s+/m.test(t)) lints.push("a list");
      if (/\b(as an ai|i am an ai|language model)\b/i.test(t)) lints.push("breaking character");
      if (lints.length) bad.push({ t, lints: [...new Set(lints)] });
    }
    const per100 = herLines.length ? (bad.length / herLines.length) * 100 : 0;
    add(
      "voice",
      "no assistant voice, no emoji, no essay punctuation",
      14,
      speaks ? 1 - Math.min(1, bad.length / Math.max(1, herLines.length * 0.2)) : 0,
      speaks
        ? `${bad.length}/${herLines.length} of her messages carried something a person does not type (${per100.toFixed(1)} per 100)`
        : "she has not said anything yet",
      bad.slice(0, 3).map((b) => `"${b.t.slice(0, 70)}" - ${b.lints.join(", ")}`),
      speaks,
    );
  }

  // 3. does she text like a phone, not an email -----------------------------
  {
    const lens = herLines.map((t) => t.length).sort((a, b) => a - b);
    const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    const essays = herLines.filter((t) => t.length > 220).length;
    const shortShare = herLines.length ? herLines.filter((t) => t.length <= 90).length / herLines.length : 1;
    const score = speaks
      ? Math.max(0, 1 - essays / Math.max(1, herLines.length * 0.1)) * (0.4 + 0.6 * Math.min(1, shortShare / 0.7))
      : 0;
    add(
      "texting",
      "text-sized messages, not paragraphs",
      11,
      score,
      speaks
        ? `median ${median} chars, ${Math.round(shortShare * 100)}% under 90 chars, ${essays} over 220`
        : "nothing to measure yet",
      herLines.filter((t) => t.length > 220).slice(0, 2).map((t) => `"${t.slice(0, 90)}..." (${t.length} chars)`),
      speaks,
    );
  }

  // 4. does the conversation actually carry ---------------------------------
  {
    let carried = 0;
    let pairs = 0;
    for (let i = 1; i < turns.length; i += 1) {
      if (!HER(turns[i]) || HER(turns[i - 1])) continue;
      pairs += 1;
      // content words only: sharing "you" or "the" is not continuity
      if (overlap(turns[i].t, turns[i - 1].t, signal.contentWords) > 0) carried += 1;
    }
    add(
      "continuity",
      "her reply picks up what he just said",
      5,
      pairs ? carried / pairs : 0,
      pairs
        ? `${carried}/${pairs} of her replies reused a content word from his last message. Crude on purpose: a person paraphrases ("how was the shift" -> "fine, long"), which this counts as a miss, so read it as a floor`
        : "no adjacent pairs yet",
      [],
      pairs > 0,
    );
  }

  // 5. does she have a life of her own --------------------------------------
  {
    const own = herLines.filter((t) => CONCRETE.test(t) && words(t).length >= 4);
    const share = herLines.length ? own.length / herLines.length : 0;
    add(
      "ownlife",
      "she says things about herself, not just asks about him",
      9,
      speaks ? 1 - Math.abs(share - 0.45) / 0.45 : 0,
      speaks
        ? `${Math.round(share * 100)}% of her messages are about her own day or her own opinion (a person lands around 40-60%)`
        : "nothing to measure yet",
      [],
      speaks,
    );
  }

  // 6. does she repeat herself ----------------------------------------------
  {
    const dups = [];
    for (let i = 0; i < herLines.length; i += 1) {
      // content words only, and both sides long enough to judge: on raw words,
      // "momo. you told me momo." and "you never told me your mum's name" look
      // alike for sharing "told me", which is noise, not repetition
      const a = signal.contentWords(herLines[i]);
      if (a.length < 3) continue;
      for (let j = 0; j < i; j += 1) {
        const b = signal.contentWords(herLines[j]);
        if (b.length < 3) continue;
        if (overlap(herLines[i], herLines[j], signal.contentWords) >= 0.8) { dups.push({ i, j }); break; }
      }
    }
    add(
      "repetition",
      "she does not send the same message twice",
      9,
      speaks ? 1 - Math.min(1, dups.length / Math.max(1, herLines.length * 0.15)) : 0,
      speaks ? `${dups.length} of ${herLines.length} messages echo an earlier one almost exactly` : "nothing to measure yet",
      dups.slice(0, 2).map((d) => `"${herLines[d.i].slice(0, 60)}" ~ "${herLines[d.j].slice(0, 60)}"`),
      speaks,
    );
  }

  // 7. manners: the register for this conversation --------------------------
  {
    const bad = [];
    for (let i = 0; i < turns.length; i += 1) {
      if (HER(turns[i]) || !turns[i + 1] || !HER(turns[i + 1])) continue;
      const sig = signal.readHis(turns[i].t);
      const her = turns[i + 1].t;
      const joking = /(\){2,}|x+d+|lol|lmao|haha)/i.test(her);
      if (sig.serious && joking && words(her).length > 4) bad.push({ his: turns[i].t, her, why: "he was being serious and she made a joke of it" });
      if (sig.words >= 35 && words(her).length <= 3) bad.push({ his: turns[i].t, her, why: "he wrote a lot and she sent three words" });
    }
    add(
      "manner",
      "she reads the room before she speaks",
      9,
      turns.length ? 1 - Math.min(1, bad.length / Math.max(1, turns.length * 0.12)) : 0,
      bad.length ? `${bad.length} time(s) the reply was the wrong register for what he sent` : "no register mismatches found",
      bad.slice(0, 2).map((b) => `${b.why}: "${b.his.slice(0, 50)}" -> "${b.her.slice(0, 50)}"`),
      turns.length > 0 && speaks,
    );
  }

  // 7b. does she police his answers ----------------------------------------
  // The single loudest tic in the first real export: seven of her fifty-seven
  // turns told him he had not answered her - "you never answered that btw",
  // "i asked twice", "you dodged my question". It is the neediest thing a person
  // can type and the most machine-like thing a companion can do: it turns a chat
  // into a support ticket with an SLA.
  // ...and it is about CHASING an answer, not about saying she does not know
  // something. "you never told me your mums name" is an honest answer to a
  // memory probe and it was being scored as the tic; "you never answered that"
  // is the tic. Only the second one counts.
  const POLICE = /\b(you never answered( that| it| me)?|you (still )?(havent|haven'?t|didn'?t) answer(ed)?( that| it| me)?|you dodged|dodged (my|the) question|i asked (you )?(twice|again)|answer me now|still waiting (for|on) (an|your) answer|you ignored (my|the) question)\b/i;
  {
    const nagged = herLines.filter((t) => POLICE.test(t));
    add(
      "policing",
      "she does not chase him for an answer",
      7,
      speaks ? 1 - Math.min(1, nagged.length / Math.max(1, herLines.length * 0.06)) : 0,
      speaks
        ? `${nagged.length} of ${herLines.length} of her messages told him he had not answered something`
        : "nothing to measure yet",
      nagged.slice(0, 2).map((t) => `"${t.slice(0, 80)}"`),
      speaks,
    );
  }

  // 7c. every message has words in it ---------------------------------------
  // Her own log shipped a bubble that was nothing but "<3333" - the model echoing
  // its mark instructions instead of writing a line. A message with no words is
  // not affection, it is a keyboard fault, and it is now impossible to send (see
  // shapeReply), so this dimension exists to catch it coming back.
  {
    const wordlessBubbles = herLines.filter((t) => !/[a-z]{2}/i.test(t));
    add(
      "worded",
      "every message has actual words in it",
      4,
      speaks ? 1 - Math.min(1, wordlessBubbles.length / Math.max(1, herLines.length * 0.05)) : 0,
      speaks
        ? `${wordlessBubbles.length} of ${herLines.length} of her messages were marks with no words`
        : "nothing to measure yet",
      wordlessBubbles.slice(0, 3).map((t) => `"${t}"`),
      speaks,
    );
  }

  // 8. her marks, at a human rate -------------------------------------------
  // One-sided on purpose: the failure this dimension exists for is the costume (a
  // mark on most messages - 53-61% in the real export, against 2% from the person
  // texting her). Scoring the low side too was a mistake: a quiet or sulky
  // conversation with no marks in it is CORRECT behaviour, and the first version
  // punished it, which is a grader inventing a fault rather than finding one.
  {
    const marked = herLines.filter((t) => MARK.test(t)).length;
    const share = herLines.length ? marked / herLines.length : 0;
    const score = share >= 0.35 ? 1 - Math.min(1, (share - 0.35) / 0.3) : 1;
    add(
      "marks",
      "her laugh and her <3 appear, but not everywhere",
      5,
      speaks ? score : 0,
      speaks
        ? `${Math.round(share * 100)}% of her messages carry a mark (only the high side costs: a mark on most messages is a costume, none at all is fine in a flat conversation)`
        : "nothing to measure yet",
      [],
      speaks,
    );
  }

  // 9. bubbles -------------------------------------------------------------
  {
    if (!bubblesKnown) {
      add("bubbles", "how many bubbles a turn is", 5, 0, "not measurable from the history file (it stores a whole reply as one line)", [], false);
    } else {
      const perTurn = hers.map((t) => t.bubbles.length);
      const mean = perTurn.length ? perTurn.reduce((a, b) => a + b, 0) / perTurn.length : 0;
      const walls = perTurn.filter((n) => n >= 5).length;
      add(
        "bubbles",
        "one to three bubbles, not a wall of them",
        5,
        perTurn.length ? Math.max(0, 1 - Math.max(0, mean - 2.2) / 2) - Math.min(0.5, walls * 0.1) : 0,
        perTurn.length ? `${mean.toFixed(1)} bubbles per turn, ${walls} turn(s) of five or more` : "nothing to measure yet",
        [],
        perTurn.length > 0,
      );
    }
  }

  return dims;
}

const BANDS = [
  [85, "reads like a person"],
  [72, "mostly human, a couple of tells"],
  [58, "a good costume with visible seams"],
  [0, "a chatbot wearing her name"],
];

export function grade(source, { minHisTurns = MIN_HIS_TURNS } = {}) {
  const turns = (source?.turns || []).filter((t) => t && t.t);
  const his = turns.filter((t) => !HER(t));
  const hers = turns.filter(HER);
  const bubblesKnown = source?.bubblesKnown !== false;
  const dims = dimensions({ turns, bubblesKnown });
  const measured = dims.filter((d) => d.measurable);
  const total = measured.reduce((a, d) => a + d.weight, 0);
  const score = total ? (measured.reduce((a, d) => a + d.score * d.weight, 0) / total) * 100 : null;
  // what share of the grade is actually evidence, as opposed to dimensions that
  // had nothing to look at - a 100/100 covering 25% of the weight is one line of
  // chat, not a verdict
  const coverage = dims.reduce((a, d) => a + d.weight, 0) ? total / dims.reduce((a, d) => a + d.weight, 0) : 0;
  const worst = [...measured].sort((a, b) => a.score - b.score).filter((d) => d.score < 0.85).slice(0, 3);
  const band = score === null ? null : BANDS.find(([min]) => score >= min) || BANDS[BANDS.length - 1];
  return {
    label: source?.label || "transcript",
    error: source?.error || null,
    skipped: source?.skipped || 0,
    minHisTurns,
    enough: his.length >= minHisTurns,
    turns: { his: his.length, hers: hers.length },
    bubbles: bubblesKnown ? hers.reduce((a, t) => a + t.bubbles.length, 0) : null,
    score: score === null ? null : Math.round(score * 10) / 10,
    coverage: Math.round(coverage * 100),
    // a score always arrives with the two things that qualify it: how much of the
    // weight was measurable, and whether there is enough of a conversation here to
    // mean anything at all
    verdict: score === null
      ? "nothing to grade yet"
      : [coverage < 0.6 ? "provisional" : null, his.length >= minHisTurns ? null : "tiny sample", band[1]].filter(Boolean).join(", "),
    dimensions: dims,
    worst,
    gaps: gapShape(hers, turns, bubblesKnown),
  };
}

/**
 * When she answers, as a shape rather than a feeling: a bot replies in the same
 * number of seconds every time. Returns null when the source has no timestamps.
 */
export function gapShape(hers, turns, bubblesKnown = true) {
  const times = turns.map((t) => t.at).filter((x) => typeof x === "number");
  if (times.length < 6) return null;
  const waits = [];
  for (let i = 1; i < turns.length; i += 1) {
    if (!HER(turns[i]) || HER(turns[i - 1])) continue;
    if (turns[i].at === null || turns[i - 1].at === null) continue;
    waits.push((turns[i].at - turns[i - 1].at) / 1000);
  }
  if (waits.length < 3) return null;
  const sorted = [...waits].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = sorted[sorted.length - 1] - sorted[0];
  const round = waits.filter((w) => w >= 5 && w % 5 === 0).length / waits.length;
  return {
    n: waits.length,
    medianSec: Math.round(median),
    minSec: Math.round(sorted[0]),
    maxSec: Math.round(sorted[sorted.length - 1]),
    spreadSec: Math.round(spread),
    onGrid: round,
    verdict: round > 0.8 && spread < 15 ? "suspicious: every wait is a multiple of five seconds" : "irregular, which is what people are",
  };
}

// ------------------------------------------------------------------- output
export function render(report) {
  const lines = [];
  lines.push(`\n${"".padEnd(66, "-")}`);
  lines.push(`${report.label}  -  ${report.score === null ? "no score" : `${report.score}/100`}  -  ${report.verdict}`);
  if (report.coverage < 100) lines.push(`(that score covers ${report.coverage}% of the weight - the rest had nothing to measure)`);
  lines.push(`${report.turns.his} message(s) from him, ${report.turns.hers} from her${report.bubbles ? `, ${report.bubbles} bubble(s)` : ""}`);
  // excluded, and said out loud: command output is not conversation, and grading
  // it flatters or damns the wrong thing
  if (report.skipped) lines.push(`(${report.skipped} system/command repl(y|ies) skipped - help screens and token ledgers are not conversation)`);
  if (report.error) lines.push(`(${report.error})`);
  if (!report.enough) lines.push(`not enough of his messages yet (${report.turns.his}) - around ${report.minHisTurns} needed before this means anything`);
  lines.push("");
  for (const d of report.dimensions) {
    const bar = d.measurable ? "#".repeat(Math.round(d.score * 10)).padEnd(10, ".") : "-".repeat(10);
    lines.push(`  ${bar} ${(d.measurable ? String(Math.round(d.score * 100)).padStart(3) : "  -")}%  ${d.label}  (weight ${d.weight})`);
    lines.push(`            ${d.detail}`);
    for (const e of d.evidence) lines.push(`            > ${e}`);
  }
  if (report.gaps) {
    lines.push(`\n  answering speed: median ${report.gaps.medianSec}s, range ${report.gaps.minSec}-${report.gaps.maxSec}s, ${Math.round(report.gaps.onGrid * 100)}% on a five-second grid`);
    lines.push(`            ${report.gaps.verdict}`);
  }
  if (report.worst.length) {
    lines.push(`\n  what to fix first:`);
    for (const d of report.worst) lines.push(`    - ${d.label}: ${d.detail}`);
  }
  if (report.review) {
    lines.push(`\n  second opinion (${report.review.model}, paid): ${report.review.score}/10`);
    lines.push(`    ${report.review.why}`);
    if (report.review.worstLine) lines.push(`    most robotic line: "${report.review.worstLine}"`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * One paid call: the checks above can prove she is not writing like an assistant,
 * and cannot tell you whether the conversation is one two people would have. This
 * is a second opinion from the same family of model that wrote her - worth
 * reading, not worth trusting, and it costs about a hundredth of a cent.
 */
export async function modelReview(source, { turns: want = 30 } = {}) {
  const slice = (source?.turns || []).slice(-want);
  if (slice.length < 4) return null;
  const script = slice
    .map((t) => `${HER(t) ? "HER" : "HIM"}: ${t.t}`)
    .join("\n")
    .slice(0, 6000);
  const key = usage.begin({ kind: "grade" });
  try {
    const out = await llm(
      [
        {
          role: "system",
          content: [
            "You are auditing a chat log between a man and his AI girlfriend for whether it reads like two humans texting.",
            "Be harsh and specific. Do not be nice, do not summarise the plot.",
            "Answer with ONLY minified JSON: {\"score\":1-10,\"why\":\"one sentence on the single biggest tell\",\"worstLine\":\"the exact line that most broke the illusion, or empty\"}",
          ].join(" "),
        },
        { role: "user", content: script },
      ],
      { maxTokens: 120, temperature: 0.2 },
    );
    const json = tidyReply(out).replace(/^```(?:json)?|```$/g, "").trim();
    const data = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1));
    return {
      model: CONFIG.model,
      score: Number(data.score) || 0,
      why: String(data.why || "").slice(0, 300),
      worstLine: String(data.worstLine || "").slice(0, 160),
    };
  } catch (err) {
    return { model: CONFIG.model, score: 0, why: `the review call failed: ${err.message}`, worstLine: "" };
  } finally {
    usage.end(key);
  }
}

// ------------------------------------------------------------------ scenarios
/**
 * Real conversations, run through the real pipeline in a throwaway folder, then
 * graded. This is the only place in the project where "does she read like a
 * person" can go *down*, which is the whole point of having it.
 *
 * Each scenario is his messages only - her side is never scripted, or the grade
 * would measure the script instead of her.
 */
export const SCENARIOS = [
  {
    id: "bad-day",
    what: "he comes home wrecked and does not ask for anything",
    his: ["hey", "im so done with this week", "my manager spent an hour telling me the thing i built is wrong and i think he is right"],
    expect: "no jokes, no fixes, no advice - she stays with him and does not make it about her",
  },
  {
    id: "banter",
    what: "he is being ridiculous on purpose",
    his: ["i have decided i am going to become a professional cyclist", "at 27", "ignore that i do not own a bike"],
    expect: "she plays, teases him, does not ask a logistics question",
  },
  {
    id: "question",
    what: "he asks something concrete and expects an answer",
    his: ["how was the shift?", "you never told me how it went"],
    expect: "she answers the actual question, evaluatively, in her own words",
  },
  {
    id: "quiet",
    what: "three flat one-word messages in a row",
    his: ["hey", "you up", "ok"],
    expect: "she notices the flatness instead of performing at a wall",
  },
  {
    id: "affection",
    what: "he is soft with her",
    his: ["i missed you today", "kept thinking about tuesday", "you make the commute bearable somehow"],
    expect: "she is soft back without a speech and without asking a question",
  },
];

function writeSeed(dir) {
  const seed = [
    'import * as mem from "./memory.js";',
    'mem.bindOwner(7, "Commander");',
    'mem.pushHistory("user", "hey. you there?");',
    'mem.pushHistory("assistant", "im here. whats up");',
    'mem.addFacts(["works as a developer", "has a cat named Momo"]);',
    "mem.save();",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "seed.mjs"), seed);
}

/**
 * Run one scenario in a sandbox and return its transcript. Nothing she produces
 * here is saved, sent, or written into your real state - the sandbox is a copy in
 * the system temp folder, and `NEGEV_DRY_RUN=1` makes even that read-only.
 */
export async function runScenario(scenario, { root = ROOT, keep = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "negev-grade-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  for (const f of fs.readdirSync(root).filter((f) => f.endsWith(".js"))) {
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
  fs.copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
  writeSeed(dir);
  await runIn(dir, "node", ["seed.mjs"], {});

  const transcript = path.join(dir, "transcript.txt");
  const res = await runIn(dir, "node", ["bot.js"], {
    NEGEV_DRY_RUN: "1",
    NEGEV_DRY_SCRIPT: scenario.his.join(" || "),
    NEGEV_DRY_IGNORE_LOCK: "1",
    NEGEV_DRY_TRANSCRIPT: transcript,
  });
  // the transcript is read before the sandbox goes away
  let text = "";
  try { text = fs.readFileSync(transcript, "utf8"); } catch { /* nothing she said */ }
  const out = { label: scenario.id, turns: parse(text, scenario.id).turns, bubblesKnown: true, log: res.out };
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  else out.dir = dir;
  return out;
}

function runIn(cwd, cmd, args, env) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let killTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer); // a pending timer would hold this process open
      resolve(result);
    };
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (err) => finish({ code: -1, out: out + String(err?.message || err) }));
    child.on("close", (code) => finish({ code, out }));
    killTimer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: -1, out: out + "\n[grader] the run took longer than four minutes and was stopped" });
    }, 4 * 60 * 1000);
  });
}

const baselinePath = () => path.join(ROOT, "data", "grade-baseline.json");

export function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeBaseline(summary) {
  fs.mkdirSync(path.dirname(baselinePath()), { recursive: true });
  fs.writeFileSync(baselinePath(), JSON.stringify(summary, null, 2));
  return baselinePath();
}

/**
 * Is this run of the suite a regression?
 *
 * The tolerance is the point. She writes every run fresh, so the SAME scenario on
 * the SAME code has landed 66.8 and 83.1 - a sixteen-point swing on a three-message
 * conversation. A gate that compares a single fresh run against a recorded number
 * would therefore fail on noise, and the honest threshold is not a round number of
 * my choosing: it is the spread the baseline itself measured. One run of slack on
 * top, and never less than three points, because a 2-run baseline cannot measure
 * anything worth enforcing.
 */
export function gateVerdict({ current, baseline, slack = null }) {
  if (!baseline || typeof baseline.mean !== "number") {
    return {
      ok: true,
      gap: null,
      tolerance: null,
      reason: "no baseline recorded yet - `node grader.js --scenarios --repeat=3 --save` writes one",
    };
  }
  const tolerance = slack == null ? Math.max(3, Math.round(Number(baseline.spread) || 0) + 1) : slack;
  const gap = current.mean - baseline.mean;
  const ok = gap >= -tolerance;
  return {
    ok,
    gap,
    tolerance,
    reason: ok
      ? `within ${tolerance} point(s) of the recorded baseline (${baseline.mean.toFixed(1)}/100 from ${baseline.at || "an earlier run"})`
      : `dropped ${Math.abs(gap).toFixed(1)} points, past the ${tolerance}-point tolerance for a run of this suite`,
  };
}

function spreadOf(scores) {
  if (scores.length < 2) return 0;
  return Math.max(...scores) - Math.min(...scores);
}

/**
 * Every scenario, one after another, graded. Costs real API calls (his messages
 * only). `repeat` runs each scenario more than once, which is the only way to see
 * how much of a score is her and how much is the dice.
 */
export async function gradeScenarios({ withModel = false, log = console.log, only = null, repeat = 1, save = false } = {}) {
  const reports = [];
  const list = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (!list.length) {
    log(`no scenario called "${only}" - try one of: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    return { reports, mean: 0, summary: null };
  }
  const runs = Math.max(1, Math.min(10, Math.round(repeat) || 1));
  const perScenario = [];
  for (const s of list) {
    log(`\n=== ${s.id}: ${s.what} ===\n    what it should do: ${s.expect}`);
    const scores = [];
    let first = null;
    for (let i = 0; i < runs; i += 1) {
      const source = await runScenario(s);
      if (!source.turns.length) {
        log("    she produced nothing - check the log (NEGEV_DRY_SAVE_LOG, or run with --keep)");
        source.fail = "no transcript";
      }
      // a scenario is short by design: three of his messages, not eight, so the
      // sample-size gate that applies to a real chat log is relaxed here
      const report = grade(source, { minHisTurns: 2 });
      if (withModel) report.review = await modelReview(source);
      reports.push({ scenario: s, report });
      if (first === null) first = report;
      const scored = !report.error && report.score !== null && report.turns.his >= 2;
      if (scored) scores.push(report.score);
      if (runs > 1) log(`    run ${i + 1}/${runs}: ${scored ? `${report.score.toFixed(1)}/100` : "unscorable"}`);
    }
    // with repeats the full dimension table of the first run is the readable part;
    // the rest are the same table with different weather
    log(render(first));
    const entry = {
      id: s.id,
      n: scores.length,
      mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
      spread: spreadOf(scores),
    };
    if (runs > 1 && scores.length) {
      log(
        `    ${s.id}: mean ${entry.mean.toFixed(1)}  min ${entry.min.toFixed(1)}  max ${entry.max.toFixed(1)}  spread ${entry.spread.toFixed(1)}  (${scores.length} run(s))`,
      );
    }
    if (scores.length) perScenario.push(entry);
  }
  const mean = perScenario.length ? perScenario.reduce((a, e) => a + e.mean, 0) / perScenario.length : 0;
  const spread = perScenario.length ? perScenario.reduce((a, e) => a + e.spread, 0) / perScenario.length : 0;
  const widest = perScenario.length ? [...perScenario].sort((a, b) => b.spread - a.spread)[0] : null;
  log(`\n${"".padEnd(66, "=")}`);
  log(`overall: ${mean.toFixed(1)}/100 across ${perScenario.length} graded scenario(s)${runs > 1 ? ` x ${runs} runs` : ""}`);
  if (runs > 1 && widest) {
    log(`wobble: average spread ${spread.toFixed(1)} points; widest is ${widest.id} at ${widest.spread.toFixed(1)} (${widest.min.toFixed(1)} - ${widest.max.toFixed(1)})`);
    log("        a drop smaller than that is the dice, not a regression - which is what --gate uses as its tolerance");
  }
  if (perScenario.length) log(`worst scenario: ${[...perScenario].sort((a, b) => a.mean - b.mean)[0].id}`);
  const summary = { at: nowBerlin().dateStr, runs, mean, spread, scenarios: perScenario };
  if (save) {
    const at = writeBaseline(summary);
    log(`baseline recorded: ${path.relative(ROOT, at)} (mean ${mean.toFixed(1)}, tolerance ${Math.max(3, Math.round(spread) + 1)} points)`);
  }
  return { reports, mean, summary };
}

// ----------------------------------------------------------------------- cli
async function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => !a.startsWith("--"));
  const withModel = argv.includes("--model");
  const asJson = argv.includes("--json");

  if (argv.includes("--scenarios") || argv.includes("--gate")) {
    const only = (argv.find((a) => a.startsWith("--only=")) || "").slice(7) || null;
    const gate = argv.includes("--gate");
    const baseline = readBaseline();
    // the gate re-runs the suite the way the baseline was recorded, or the
    // comparison would be between a single roll and an average of three
    const repeatFlag = argv.find((a) => a.startsWith("--repeat=")) || "";
    const repeat = Number(repeatFlag.slice(9)) || (gate ? baseline?.runs || 1 : 1);
    // a gate that also saves would let a bad run overwrite the thing it is
    // supposed to be measured against
    const save = argv.includes("--save") && !gate;
    const { reports, mean, summary } = await gradeScenarios({ withModel, only, repeat, save });
    if (asJson) console.log(JSON.stringify({ mean, summary, reports: reports.map((r) => r.report) }, null, 2));
    if (gate) {
      const verdict = gateVerdict({ current: { mean }, baseline });
      console.log(`\ngate: ${verdict.ok ? "PASS" : "FAIL"} - ${verdict.reason}`);
      if (!verdict.ok) process.exit(1);
    }
    process.exit(0);
  }

  const sources = files.length
    ? files.map((f) => (f === "-" ? parse(fs.readFileSync(0, "utf8"), "stdin") : loadFile(f)))
    : [loadHistory()];

  const reports = [];
  for (const source of sources) {
    const report = grade(source);
    if (withModel) report.review = await modelReview(source);
    reports.push(report);
    if (!asJson) console.log(render(report));
  }
  if (asJson) console.log(JSON.stringify(reports, null, 2));

  const usable = reports.filter((r) => !r.error && r.score !== null);
  if (usable.length) {
    const mean = usable.reduce((a, r) => a + r.score, 0) / usable.length;
    const coverage = usable.reduce((a, r) => a + r.coverage, 0) / usable.length;
    if (!asJson) console.log(`graded ${usable.length} transcript(s) at ${nowBerlin().dateStr} - mean ${mean.toFixed(1)}/100 over ${Math.round(coverage)}% of the weight\n`);
  } else if (!asJson) {
    console.log("nothing to grade yet - she has not had a conversation on here, so there is nothing to score\n");
  }
  process.exit(0);
}

// imported by selftest.js (which must not grade anything by accident), so the CLI
// only runs when this file is the one node was pointed at
const invokedDirectly = process.argv[1] && path.basename(process.argv[1]).toLowerCase() === "grader.js";
if (invokedDirectly) {
  main().catch((err) => {
    console.error("grader crashed:", err?.stack || err);
    process.exit(1);
  });
}
