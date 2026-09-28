// Self-test: DeepSeek reachable, Berlin time math, local pipeline labelling
// (speech vs on-screen text vs music) and internet post reading.
//
//   node selftest.js            all checks
//   node selftest.js model      only DeepSeek
//   node selftest.js pipeline   only the local media pipeline
//   node selftest.js links      only link reading
//   node selftest.js timing     only the human reaction timing (fast, offline)
//   node selftest.js signal     only how she reads him (fast, offline)
//   node selftest.js bond       only the relationship ledger (fast, offline)
//   node selftest.js reactions  only the reaction channel (fast, offline)
//   node selftest.js voice      only the voice-note gating (fast, offline)

import "./dotenv.js"; // .env secrets first, before anything reads process.env
//   node selftest.js photos     only her own pictures (fast, offline)
//   node selftest.js memory     only corrections, edits and superseded facts
//   node selftest.js arcs       only what survives the night (fast, offline)
//   node selftest.js days       only the day cards (fast, offline)
//   node selftest.js grader     only the transcript grader (fast, offline)
//   node selftest.js identity   only her fixed biography migration (fast, offline)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { CONFIG, PATHS } from "./config.js";
import { llm, currentModel, tidyReply } from "./deepseek.js";
import * as media from "./media.js";
import { readPost } from "./links.js";
import { nowBerlin, berlinToUtc } from "./util.js";
import * as mem from "./memory.js";
import { parseRemember, pinFact } from "./memory.js";
import * as tasks from "./tasks.js";
import * as usage from "./usage.js";
import * as mood from "./mood.js";
import { MOOD_KEYS } from "./mood.js";
import * as style from "./style.js";
import * as sleep from "./sleep.js";
import * as proactive from "./proactive.js";
import * as signal from "./signal.js";
import * as bond from "./bond.js";
import * as reactions from "./reactions.js";
import * as voice from "./voice.js";
import * as photos from "./photos.js";
import * as grader from "./grader.js";
import * as identity from "./identity.js";
import { toneBlock, reactionBlock, correctionBlock, editBlock, factsPrompt } from "./persona.js";
import { planReaction, reactionNote, chooseQuote, pickReplyTarget, gapWords, isAsleep, minutesUntilMorning, wakePlan, wantsHesitation } from "./timing.js";

/** 00:00-23:59 from minutes, for readable test output. */
const hhmmOf = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(Math.round(mins) % 60).padStart(2, "0")}`;

const only = process.argv[2] || "all";
const want = (name) => only === "all" || only === name;
let failures = 0;

function ok(label, extra = "") {
  console.log(`  PASS  ${label}${extra ? ` - ${extra}` : ""}`);
}
function bad(label, extra = "") {
  failures += 1;
  console.log(`  FAIL  ${label}${extra ? ` - ${extra}` : ""}`);
}
let warnings = 0;
function warn(label, extra = "") {
  warnings += 1;
  console.log(`  WARN  ${label}${extra ? ` - ${extra}` : ""} (network dependent, not a blocker)`);
}

function run(cmd, args, env = null, cwd = null) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", () => resolve({ code: -1, out }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// The two dry-run subprocess tests must never read her LIVE data/ folder: her real
// overnight queue and unread messages are not test fixtures (one run answered her
// actual 2 a.m. backlog instead of the canary). They get a sandbox snapshot with
// her identity but an empty desk, and she "just texted" so the night grace window
// keeps the canary out of the morning queue at any test hour.
let sandboxDir = null;
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "negev-selftest-"));
  for (const f of fs.readdirSync(".")) if (f.endsWith(".js")) fs.copyFileSync(f, path.join(dir, f));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const state = JSON.parse(fs.readFileSync(PATHS.state, "utf8"));
  Object.assign(state, {
    unanswered: [], overnight: [], schedule: [], busyWindow: null, pendingSince: null,
    forceNext: false, quietUntil: 0, holdUntil: 0, holdWhy: null, initiations: 0,
    openQuestions: [], askLog: [], dropped: [], tasks: [], diary: null,
    lastBotTs: Date.now(),
  });
  fs.writeFileSync(path.join(dir, "data", "state.json"), JSON.stringify(state, null, 1));
  const h = fs.existsSync(PATHS.history) ? fs.readFileSync(PATHS.history, "utf8") : "[]";
  fs.writeFileSync(path.join(dir, "data", "history.json"), h);
  return dir;
}
process.on("exit", () => { if (sandboxDir) { try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {} } });

async function testTime() {
  console.log("\n[1] Berlin time maths");
  const summer = berlinToUtc("2026-09-16", "14:30");
  const winter = berlinToUtc("2026-01-16", "14:30");
  const summerOk = summer.toISOString() === "2026-09-16T12:30:00.000Z";
  const winterOk = winter.toISOString() === "2026-01-16T13:30:00.000Z";
  summerOk ? ok("CEST (UTC+2) mapping", summer.toISOString()) : bad("CEST mapping", summer.toISOString());
  winterOk ? ok("CET (UTC+1) mapping", winter.toISOString()) : bad("CET mapping", winter.toISOString());
  ok("current Dortmund time", `${nowBerlin().dateStr} ${nowBerlin().hhmm} (${CONFIG.timezone})`);
}

async function testModel() {
  console.log("\n[2] DeepSeek");
  /^deepseek-(flash|v4-flash)$/.test(CONFIG.model || "") && CONFIG.thinking?.type === "disabled"
    ? ok("fixed model policy", `${CONFIG.model}, reasoning disabled`)
    : bad("fixed model policy", JSON.stringify({ model: CONFIG.model, thinking: CONFIG.thinking }));
  try {
    const answer = await llm(
      [{ role: "user", content: "Reply with exactly one word: ready" }],
      { maxTokens: 12, temperature: 0 },
    );
    ok("chat completion", `${currentModel()} -> "${answer.trim().slice(0, 40)}"`);
  } catch (err) {
    bad("chat completion", err.message);
  }
}

function pipelineTestFiles() {
  const dir = CONFIG.pipeline.dir || CONFIG.pipeline.defaultDir;
  return {
    speech: [
      process.env.NEGEV_TEST_AUDIO,
      path.join(dir, "tmp", "jfk.wav"),
      path.join(dir, "tests", "german_hedda.wav"),
    ].filter(Boolean),
    slides: [process.env.NEGEV_TEST_VIDEO, path.join(dir, "tests", "slides.mp4")].filter(Boolean),
  };
}

/** A 9s clip with ONLY music (no speech) and on-screen text: tests music labelling + OCR. */
async function makeTestVideo() {
  const { ffmpeg } = media.resolveTools();
  const out = path.join(PATHS.tmp, "selftest_music.mp4");
  const dir = CONFIG.pipeline.dir || CONFIG.pipeline.defaultDir;
  const font = path.join(dir, "tests", "font.ttf");
  const vf = fs.existsSync(font)
    ? `drawtext=fontfile='${font.replace(/\\/g, "/").replace(":", "\\:")}':text='DAY 3 - NEW PROGRAM':fontsize=30:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`
    : null;
  const r = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=9",
    "-f", "lavfi", "-i", "color=c=0x101018:s=640x360:d=9",
    ...(vf ? ["-vf", vf] : []),
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
    out,
  ]);
  return r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000 ? out : null;
}

async function testPipeline() {
  console.log("\n[4] local media pipeline");
  const tools = media.resolveTools();
  if (!media.pipelineAvailable()) {
    bad("pipeline detected", "install it or set NEGEV_PIPELINE_DIR");
    return;
  }
  ok("pipeline detected", tools.pipeline.script);
  console.log(`        whisper: ${CONFIG.pipeline.model} | ffmpeg: ${tools.ffmpeg}`);

  const files = pipelineTestFiles();
  const speech = files.speech.find((f) => fs.existsSync(f));
  if (speech) {
    const res = await media.transcribeMedia(speech, { ocr: false, frames: 0 });
    if (!res) bad("speech transcription", "no result");
    else {
      const hasSpeech = /SPEECH TRANSCRIPT[\s\S]*\[0:/.test(res.brief);
      hasSpeech ? ok("speech transcript produced", `${res.meta.segmentCount} segment(s) in ${res.meta.elapsed}s`) : bad("speech transcript empty", res.brief.slice(0, 200));
      console.log("  ---- brief ----");
      console.log(res.brief.split("\n").map((l) => `  | ${l}`).join("\n"));
    }
  } else {
    console.log("  SKIP  no speech sample found (set NEGEV_TEST_AUDIO)");
  }

  const video = await makeTestVideo();
  if (video) {
    const res = await media.transcribeMedia(video, { ocr: true, frames: 2 });
    if (!res) bad("video pipeline", "no result");
    else {
      ok("video frames extracted", `${res.frames.length} frame(s)`);
      ok("OCR ran", `${res.meta.ocrCount} text block(s)`);
      const musicLabelled = /MUSIC \/ NON-SPEECH AUDIO/.test(res.brief);
      musicLabelled ? ok("music/non-speech labelled separately") : bad("music section missing", res.brief.slice(0, 240));
      console.log("  ---- brief ----");
      console.log(res.brief.split("\n").map((l) => `  | ${l}`).join("\n"));
    }
    media.cleanup([video, ...res.frames]);
  } else {
    console.log("  SKIP  could not generate a test video (ffmpeg issue)");
  }

  // a silent, text-only clip: exercises OCR + the "no audio track" path
  const slides = files.slides.find((f) => fs.existsSync(f));
  if (slides) {
    const res = await media.transcribeMedia(slides, { ocr: true, frames: 1 });
    if (!res) bad("slides pipeline", "no result");
    else {
      media.cleanup(res.frames);
      const noAudioOk = /no audio track at all/.test(res.brief);
      noAudioOk ? ok("silent video not mislabelled as music") : bad("silent video labelling", res.brief.slice(0, 200));
      res.meta.ocrCount > 0 ? ok("OCR found on-screen text", `${res.meta.ocrCount} block(s)`) : bad("OCR found nothing");
      console.log("  ---- brief ----");
      console.log(res.brief.split("\n").map((l) => `  | ${l}`).join("\n"));
    }
  } else {
    console.log("  SKIP  no slide video found for the OCR check");
  }
}

async function testLinks() {
  console.log("\n[5] internet posts");
  const hard = ["https://example.com", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"];
  const soft = [
    "https://x.com/jack/status/20",
    "https://www.reddit.com/r/telegrambots/top.json?limit=1",
    "https://www.instagram.com/reel/C8xyz/",
  ];
  for (const url of [process.env.NEGEV_TEST_LINK, ...hard].filter(Boolean)) {
    const post = await readPost(url);
    if (post.ok && post.text) ok(`read ${post.kind}`, `${post.text.replace(/\s+/g, " ").slice(0, 90)}...`);
    else bad(`read ${url}`, "no text extracted");
  }
  for (const url of soft) {
    const post = await readPost(url);
    if (post.ok && post.text) ok(`read ${post.kind}`, `${url.slice(0, 40)} -> ${post.text.replace(/\s+/g, " ").slice(0, 70)}...`);
    else warn(`read ${url.slice(0, 40)}`, "blocked from this network - she will ask you what it is instead");
  }
}

async function testText() {
  console.log("\n[3] reply formatting and imperfect typing");
  const dirty = "Negev: omg 😍🔥 look at this *flirt* you idiot\n\nplus a second bubble 💕\n\nand a third one\n\nand a fourth that must be merged";
  const clean = tidyReply(dirty);
  const parts = clean.split(/\n\s*\n+/).filter(Boolean);
  const emojiLeft = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(clean);
  const namePrefixed = /^(negev|negev-chan)\s*[:>-]/i.test(clean);
  emojiLeft ? bad("emoji stripping", clean.slice(0, 60)) : ok("no emojis survive");
  namePrefixed ? bad("name prefix stripped") : ok("model name prefix stripped");
  /\*/.test(clean) ? bad("markdown kept") : ok("markdown noise stripped");
  parts.length <= 4 ? ok("bubble count sane", `${Math.min(parts.length, 3)} bubbles after split`) : bad("too many bubbles", String(parts.length));
  console.log(`  ---- example reply ----\n  | ${parts.slice(0, 3).join("\n  | ")}`);

  // imperfect typing: mostly right, never unreadable
  const long = "i don't know why you always do this, but honestly it's kind of cute, and anyway i will be there at 8.";
  const commas = (s) => (s.match(/,/g) || []).length;
  const cleanText = style.apply(long, "clean", () => 0.99);
  const normalText = style.apply(long, "normal", () => 0.01);
  const sloppyText = style.apply(long, "sloppy", () => 0.01);

  commas(cleanText) === commas(long) && /\.$/.test(cleanText)
    ? ok("clean typing keeps its commas and full stop")
    : bad("clean typing got mangled", JSON.stringify(cleanText));
  commas(sloppyText) === 0 && !/\.$/.test(sloppyText)
    ? ok("sloppy typing drops the commas and the trailing stop", JSON.stringify(sloppyText.slice(0, 60)))
    : bad("sloppy typing still tidy", JSON.stringify(sloppyText));
  !/['\u2019]/.test(sloppyText) && /dont|im|youre/.test(sloppyText)
    ? ok("apostrophes go missing when she is typing fast", "dont / thats / youre")
    : bad("apostrophes survived", JSON.stringify(sloppyText));

  // the middle level is a rate, not a switch, so measure it over many replies
  const rateRandom = seeded(29);
  let keptCommas = 0;
  for (let i = 0; i < 400; i += 1) keptCommas += commas(style.apply(long, "normal", rateRandom));
  const kept = keptCommas / 400;
  kept > 0.8 && kept < 1.8
    ? ok("in between she forgets some but not all commas", `${kept.toFixed(2)} of ${commas(long)} kept on average`)
    : bad("normal level comma rate", kept.toFixed(2));

  const words = (s) => s.toLowerCase().replace(/['\u2019]/g, "").match(/[a-z0-9]+/g) || [];
  const sameCount = [cleanText, normalText, sloppyText].every((s) => words(s).length === words(long).length);
  const intact = words(sloppyText).filter((w, i) => w === words(long)[i]).length / words(long).length;
  sameCount && intact >= 0.85
    ? ok("she never loses a word", `${(intact * 100).toFixed(0)}% of words untouched even at her sloppiest`)
    : bad("content lost while typing", `${intact}`);

  const withLink = "look at this https://x.com/negev/status/20 it's a 4.5 out of 10, don't you think?";
  const messyLink = style.apply(withLink, "sloppy", () => 0.01);
  messyLink.includes("https://x.com/negev/status/20") && messyLink.includes("4.5")
    ? ok("links and numbers are never touched", JSON.stringify(messyLink))
    : bad("link mangled", JSON.stringify(messyLink));

  // the level has to come from her mood, not a coin flip
  const rolls = (m, seed) => {
    const r = seeded(seed);
    const out = { clean: 0, normal: 0, sloppy: 0 };
    for (let i = 0; i < 3000; i += 1) out[style.roll({ def: { mess: m } }, r).level] += 1;
    return out;
  };
  const softRolls = rolls(mood.MOODS.soft.mess, 11);
  const chaoticRolls = rolls(mood.MOODS.chaotic.mess, 11);
  console.log(`  ---- typing when soft: clean ${softRolls.clean} normal ${softRolls.normal} sloppy ${softRolls.sloppy}`);
  console.log(`  ---- typing when chaotic: clean ${chaoticRolls.clean} normal ${chaoticRolls.normal} sloppy ${chaoticRolls.sloppy}`);
  softRolls.clean > chaoticRolls.clean && chaoticRolls.sloppy > softRolls.sloppy * 2
    ? ok("a soft mood types properly, a chaotic one does not", `sloppy ${((chaoticRolls.sloppy / 3000) * 100).toFixed(0)}% vs ${((softRolls.sloppy / 3000) * 100).toFixed(0)}%`)
    : bad("typing level ignores mood", JSON.stringify({ softRolls, chaoticRolls }));
  normalText.length > 0 && sloppyText.length > 0 && cleanText.length > 0
    ? ok("no level ever produces an empty reply")
    : bad("a level wiped the reply");

  // the bare ")" smile: a habit, placed like a person places it
  const smileOn = { smile: true, double: false };
  const always = () => 0.05;
  style.applySmile("ok fine", smileOn, always) === "ok fine)"
    ? ok("she can smile with a bare )", '"ok fine)"')
    : bad("smile not applied", JSON.stringify(style.applySmile("ok fine", smileOn, always)));
  style.applySmile("im dying", { smile: true, count: 2 }, always) === "im dying))"
    ? ok("a double )) is a real laugh", '"im dying))"')
    : bad("double smile broken");
  [3, 4].every((n) => style.applySmile("im dying", { smile: true, count: n }, always) === `im dying${")".repeat(n)}`)
    ? ok("and it escalates as she laughs harder", '"im dying)))" / "im dying))))"')
    : bad("paren escalation broken");
  const parens = (moodDef, energy, seed) => {
    const r = seeded(seed);
    const out = new Array(style.MAX_PARENS + 1).fill(0);
    out.over = 0;
    for (let i = 0; i < 6000; i += 1) {
      const n = style.parenCount({ def: moodDef }, energy, r);
      if (n >= 1 && n <= style.MAX_PARENS) out[n] += 1;
      else out.over += 1;
    }
    return out;
  };
  const calm = parens(mood.MOODS.soft, null, 17);
  const hyped = parens(mood.MOODS.soft, "excited", 17);
  const messy = parens(mood.MOODS.chaotic, "excited", 17);
  const tail = (b, from) => b.slice(from).reduce((s, v) => s + v, 0) / 6000;
  const dist = (b) =>
    [1, 2, 3, 4, 5, 6, 7].map((n) => `${n}:${((b[n] / 6000) * 100).toFixed(b[n] / 6000 < 0.01 ? 1 : 0)}%`).join(" ") +
    ` 8+:${(tail(b, 8) * 100).toFixed(1)}%`;
  console.log(`  ---- () count calm:      ${dist(calm)}`);
  console.log(`  ---- () count excited:   ${dist(hyped)}`);
  console.log(`  ---- () count chaotic:   ${dist(messy)}`);
  // the tail is open-ended, so the shape has to be checked, not just the max
  const droops = [1, 2, 3, 4, 5, 6].every((n) => calm[n] > calm[n + 1]);
  calm[1] / 6000 > 0.4 && droops && calm.over === 0
    ? ok("one paren is the usual, each extra one rarer than the last", `${((calm[1] / 6000) * 100).toFixed(0)}% single, decaying`)
    : bad("paren distribution", JSON.stringify(calm));
  tail(calm, 5) > 0.005 && tail(calm, 5) < 0.15
    ? ok("but the tail does not stop at four - long rows happen", `5+ parens on ${(tail(calm, 5) * 100).toFixed(1)}% of her smiles`)
    : bad("smile count is capped or runaway", JSON.stringify({ five_plus: tail(calm, 5) }));
  tail(calm, 8) > 0 && tail(calm, 8) < 0.03
    ? ok("and a really long row is rare, not impossible", `8+ on ${(tail(calm, 8) * 100).toFixed(2)}%`)
    : bad("long laugh rows unrealistic", JSON.stringify({ eight_plus: tail(calm, 8) }));
  tail(messy, 4) > tail(calm, 4) && tail(hyped, 4) > tail(calm, 4)
    ? ok("an exciting message or a messy mood laughs longer", `chaotic 4+ ${(tail(messy, 4) * 100).toFixed(0)}% vs soft ${(tail(calm, 4) * 100).toFixed(0)}%`)
    : bad("energy does not escalate the laugh", JSON.stringify({ calm: tail(messy, 4), hyped: tail(hyped, 4) }));
  // the ceiling must sit beyond where the tail dies out, or the longest laughs all
  // get cut to the same length: the pile-up at the cap is the tell
  const capped = (m) => (m[style.MAX_PARENS] || 0) / 6000;
  tail(messy, style.MAX_PARENS - 1) < 0.001 && capped(messy) < 0.001
    ? ok("the ceiling never truncates a real laugh", `reaches ${style.MAX_PARENS} marks on ${(capped(messy) * 100).toFixed(3)}% of chaotic laughs`)
    : bad("the laugh cap is being hit", JSON.stringify({ cap: style.MAX_PARENS, at_cap: capped(messy), near: tail(messy, style.MAX_PARENS - 1) }));
  style.applySmile("im dead", { smile: true, count: 7 }, always) === "im dead)))))))"
    ? ok("a long laugh reaches the message intact", '"im dead))))))) "')
    : bad("long paren run broken", JSON.stringify(style.applySmile("im dead", { smile: true, count: 7 }, always)));
  style.applySmile("im dead))))))", { smile: true, count: 2 }, always) === "im dead))))))"
    ? ok("and a row she typed herself is never trimmed")
    : bad("laughed too hard for the plan", JSON.stringify(style.applySmile("im dead))))))", { smile: true, count: 2 }, always)));
  style.plan({ def: { mess: 0.4, smile: 0 } }, { random: () => 0.99 }).count === 0
    ? ok("and no smile means no parens at all")
    : bad("count without a smile");
  !/[)]$/.test(style.applySmile("do you actually mean that?", smileOn, always))
    ? ok("never after a question")
    : bad("smiled at a question");
  !/[)]$/.test(style.applySmile("here it is https://x.com/a/status/9", smileOn, always))
    ? ok("never stuck onto a link")
    : bad("smiled onto a link");
  style.applySmile("ok fine", { smile: false }, always) === "ok fine"
    ? ok("and most messages carry no smile at all")
    : bad("smile ignores the plan");
  const multi = style.applySmile("long first line that goes on and on about the whole day and everything in it\n\nok", smileOn, always);
  multi.split("\n\n").filter((s) => /[)]$/.test(s)).length === 1
    ? ok("only one bubble gets it", JSON.stringify(multi.split("\n\n").find((s) => /[)]$/.test(s))))
    : bad("multiple smiles", JSON.stringify(multi));

  // the bug this guards: every bubble was longer than the candidate limit, so
  // she stayed silent about it and the smile simply never appeared
  const longBoth = "you finally learned how to text a girl first? no wait thats too much to hope for\n\ntell me. or dont and i will sulk about it for a weird amount of time";
  /[)]$/.test(style.applySmile(longBoth, smileOn, always))
    ? ok("she smiles even when every line is long")
    : bad("smile silently skipped on long replies", JSON.stringify(style.applySmile(longBoth, smileOn, always)));
  const linkReply = style.applySmile("look at this https://x.com/a/status/9\n\ntold you", smileOn, always);
  linkReply.includes("told you)") && !/status\/9[)]/.test(linkReply)
    ? ok("and picks a bubble that is not a link", JSON.stringify(linkReply.split("\n\n")[1]))
    : bad("link handling in the smile", JSON.stringify(linkReply));
  style.applySmile("ok fine)\n\nhm", { smile: true, count: 1 }, always) === "ok fine)\n\nhm"
    ? ok("never doubles up on a smile she already wrote")
    : bad("double smile applied");
  style.applySmile("ok fine)\n\nhm", { smile: true, count: 3 }, always) === "ok fine)))\n\nhm"
    ? ok("but a single ) is upgraded when she is supposed to be laughing", '"ok fine)))"')
    : bad("laugh scale lost", JSON.stringify(style.applySmile("ok fine)\n\nhm", { smile: true, count: 3 }, always)));
  style.applySmile("im dead))))", { smile: true, count: 1 }, always) === "im dead))))"
    ? ok("and a bigger laugh of her own is never trimmed")
    : bad("laughed too hard for the plan");

  // her second laugh habit: xd. One x, a d per step of laughing, never a lone x
  style.laughMark(1, "xdd") === "xd" && style.laughMark(2, "xdd") === "xdd" && style.laughMark(4, "xdd") === "xdddd"
    ? ok("the xd scale starts at xd and grows one d per step", '"xd" / "xdd" / "xdddd"')
    : bad("xd spelling", JSON.stringify([1, 2, 4].map((n) => style.laughMark(n, "xdd"))));
  style.laughMark(1, "parens") === ")" && !/^x$/.test(style.laughMark(1, "xdd"))
    ? ok("and a bare x on its own is never written")
    : bad("lone x written", JSON.stringify(style.laughMark(1, "xdd")));
  style.laughMark(3, "parens") === ")))" && style.laughMark(99, "xdd") === `x${"d".repeat(style.MAX_PARENS)}`
    ? ok("and both habits respect the same ceiling")
    : bad("laughMark bounds", JSON.stringify([style.laughMark(3, "parens"), style.laughMark(99, "xdd")]));
  style.applySmile("im dead", { smile: true, count: 3, style: "xdd" }, always) === "im dead xddd"
    ? ok("she can laugh in xdd instead of parens, spaced like a word", '"im dead xddd"')
    : bad("xdd not applied", JSON.stringify(style.applySmile("im dead", { smile: true, count: 3, style: "xdd" }, always)));
  style.applySmile("im dead)", { smile: true, count: 3, style: "xdd" }, always) === "im dead xddd"
    ? ok("a lone ) in an xdd mood is upgraded to the laugh she rolled, with the space fixed")
    : bad("xdd mood delivered a paren", JSON.stringify(style.applySmile("im dead)", { smile: true, count: 3, style: "xdd" }, always)));
  style.applySmile("im dead xdd", { smile: true, count: 5, style: "xdd" }, always) === "im dead xddddd"
    ? ok("and a weak xdd grows when she is laughing harder")
    : bad("xdd upgrade broken", JSON.stringify(style.applySmile("im dead xdd", { smile: true, count: 5, style: "xdd" }, always)));
  style.applySmile("no drama xdd", { smile: true, count: 3, style: "parens" }, always) === "no drama)))"
    ? ok("converting xdd back to parens welds it onto the word")
    : bad("paren conversion spacing", JSON.stringify(style.applySmile("no drama xdd", { smile: true, count: 3, style: "parens" }, always)));
  style.applySmile("hm ok", { smile: true, count: 1, style: "xdd" }, always) === "hm ok xd"
    ? ok("a small laugh is xd, spaced like a word", '"hm ok xd"')
    : bad("small xd laugh", JSON.stringify(style.applySmile("hm ok", { smile: true, count: 1, style: "xdd" }, always)));
  [6, 14].every((n) => style.applySmile("im dying", { smile: true, count: n, style: "xdd" }, always) === `im dying x${"d".repeat(n)}`)
    ? ok("deep into the tail the xd row just keeps going", `"im dying x${"d".repeat(14)}"`)
    : bad("long xd row broken", JSON.stringify([6, 14].map((n) => style.applySmile("im dying", { smile: true, count: n, style: "xdd" }, always))));
  [6, 14].every((n) => style.applySmile("im dying", { smile: true, count: n, style: "parens" }, always) === `im dying${")".repeat(n)}`)
    ? ok("and so does a long paren row")
    : bad("long paren row broken", JSON.stringify([6, 14].map((n) => style.applySmile("im dying", { smile: true, count: n, style: "parens" }, always))));
  style.applySmile("im dead xdddd", { smile: true, count: 2, style: "parens" }, always) === "im dead xdddd"
    ? ok("but a bigger laugh of hers is never trimmed or converted")
    : bad("xdd trimmed", JSON.stringify(style.applySmile("im dead xdddd", { smile: true, count: 2, style: "parens" }, always)));
  style.applySmile("stop it xDD", { smile: true, count: 2, style: "xdd" }, always) === "stop it xdd"
    ? ok("and it is always lowercase, even when the model shouts xDD")
    : bad("xDD not normalised", JSON.stringify(style.applySmile("stop it xDD", { smile: true, count: 2, style: "xdd" }, always)));
  style.apply("stop it xDD", "clean", () => 0.99) === "stop it xdd"
    ? ok("the typing pass lowercases it too")
    : bad("xDD survived the typing pass", JSON.stringify(style.apply("stop it xDD", "clean", () => 0.99)));
  style.applySmile("and", smileOn, always) === "and)" && style.applySmile("do you actually mean that?", { smile: true, count: 3, style: "xdd" }, always) === "do you actually mean that?"
    ? ok("a word ending in d is never mistaken for a laugh, and xdd never hangs off a question")
    : bad("laugh detector or question guard", JSON.stringify([style.applySmile("and", smileOn, always), style.applySmile("do you actually mean that?", { smile: true, count: 3, style: "xdd" }, always)]));
  const xddShare = (moodDef, energy, seed) => {
    const r = seeded(seed);
    let xdd = 0;
    let laughs = 0;
    for (let i = 0; i < 6000; i += 1) {
      const p = style.plan({ def: moodDef }, { energy, random: r });
      if (p.smile && p.count >= 2) { laughs += 1; if (p.style === "xdd") xdd += 1; }
    }
    return laughs ? xdd / laughs : 0;
  };
  const xdLoud = xddShare(mood.MOODS.chaotic, "excited", 23);
  const xdQuiet = xddShare(mood.MOODS.soft, null, 23);
  console.log(`  ---- xdd share of her laughs: chaotic ${(xdLoud * 100).toFixed(0)}% | soft ${(xdQuiet * 100).toFixed(0)}%`);
  xdLoud > 0.4 && xdQuiet > 0.05 && xdQuiet < 0.35 && xdLoud > xdQuiet
    ? ok("xdd is a mood habit: loud girls reach for it, quiet ones stay on parens")
    : bad("xdd rate ignores mood", JSON.stringify({ chaotic: xdLoud, soft: xdQuiet }));
  // a plain smile can come out either way, and the paren habit stays the default:
  // every mark of a smiling reply, counted across moods, is never a bare x
  const smallLaughMarks = (() => {
    const r = seeded(11);
    const seen = [];
    for (let i = 0; i < 4000; i += 1) {
      const p = style.plan({ def: mood.MOODS.chaotic }, { energy: "excited", random: r });
      if (p.smile && p.count === 1) seen.push(style.laughMark(1, p.style));
    }
    return seen;
  })();
  const smallXd = smallLaughMarks.filter((m) => m === "xd").length / smallLaughMarks.length;
  smallLaughMarks.length > 100 && smallXd > 0.3 && smallXd < 0.9 && !smallLaughMarks.some((m) => m === "x")
    ? ok("a plain smile comes out as ) or xd, never a bare x", `xd in ${(smallXd * 100).toFixed(0)}% of chaotic one-step laughs`)
    : bad("small laugh mark", JSON.stringify({ n: smallLaughMarks.length, xd: smallXd }));

  // the typed heart: affection, placed like a person places it
  const heartOn = { heart: true, heartStyle: "plain", heartGlue: "space" };
  style.applyHeart("night", heartOn, always) === "night <3"
    ? ok("she can end a line with a typed heart", '"night <3"')
    : bad("heart not applied", JSON.stringify(style.applyHeart("night", heartOn, always)));
  style.applyHeart("night", { heart: true, heartStyle: "plain", heartGlue: "none" }, always) === "night<3"
    ? ok("and sometimes welds it to the word", '"night<3"')
    : bad("glued heart broken", JSON.stringify(style.applyHeart("night", { heart: true, heartStyle: "plain", heartGlue: "none" }, always)));
  style.applyHeart("love you", { heart: true, heartStyle: "big", heartGlue: "space" }, always) === "love you <33"
    ? ok("a big one is <33", '"love you <33"')
    : bad("big heart broken", JSON.stringify(style.applyHeart("love you", { heart: true, heartStyle: "big", heartGlue: "space" }, always)));
  style.applyHeart("ok)", { heart: true, heartStyle: "plain", heartGlue: "space" }, always) === "ok) <3"
    ? ok("when the laugh has her only line the heart still lands, rather than silently vanishing")
    : bad("heart lost on a single-line reply", JSON.stringify(style.applyHeart("ok)", { heart: true, heartStyle: "plain", heartGlue: "space" }, always)));
  const heartVsLaugh = style.applyHeart("im dying))\n\nnite", { heart: true, heartStyle: "plain", heartGlue: "space" }, always);
  heartVsLaugh.startsWith("im dying))") && heartVsLaugh.endsWith("nite <3")
    ? ok("and goes on the other line when the laugh has the last one", JSON.stringify(heartVsLaugh.split("\n\n")[1]))
    : bad("heart vs laugh placement", JSON.stringify(heartVsLaugh));
  // the live artifact this rule comes from: "so spill :33 <3". The model typed its
  // own smirk, the heart applier found no clean line and fell back to the
  // least-bad one, stacking two marks at the end of one line.
  const heartOnFace = style.applyHeart("so spill :33", { heart: true, heartStyle: "plain", heartGlue: "space" }, always);
  heartOnFace === "so spill :33"
    ? ok("affection never stacks on top of her own smirk", '"so spill :33" -> no heart that time')
    : bad("heart landed on the smirk's line", JSON.stringify(heartOnFace));
  style.applyHeart("so spill :33\n\nand how are you", { heart: true, heartStyle: "plain", heartGlue: "space" }, always).endsWith("and how are you <3")
    ? ok("it takes another line instead when there is one")
    : bad("the heart gave up even with a free line", JSON.stringify(style.applyHeart("so spill :33\n\nand how are you", { heart: true, heartStyle: "plain", heartGlue: "space" }, always)));
  // a welded mark never follows a full stop ("story.<3" is not how anyone types),
  // while a spaced one keeps the sentence's own stop - that is two gestures
  style.applyHeart("that is the whole story.", { heart: true, heartGlue: "none" }, always) === "that is the whole story<3"
    ? ok("a welded heart drops the full stop instead of sitting under it", '"story.<3" -> "story<3"')
    : bad("welded heart after a full stop", JSON.stringify(style.applyHeart("that is the whole story.", { heart: true, heartGlue: "none" }, always)));
  style.applyHeart("that is the whole story.", { heart: true, heartGlue: "space" }, always) === "that is the whole story. <3"
    ? ok("while a spaced one keeps it", '"story. <3"')
    : bad("spaced heart lost the sentence", JSON.stringify(style.applyHeart("that is the whole story.", { heart: true, heartGlue: "space" }, always)));
  const heartOnce = style.applyHeart("night <3\n\nsleep well", { heart: true, heartStyle: "big", heartGlue: "space" }, always);
  heartOnce === "night <3\n\nsleep well"
    ? ok("never doubles up on a heart she already sent")
    : bad("second heart added", JSON.stringify(heartOnce));
  !/<3/.test(style.applyHeart("look https://x.com/a/status/9", { heart: true, heartStyle: "plain", heartGlue: "space" }, always))
    ? ok("never welded onto a link")
    : bad("heart on a link", JSON.stringify(style.applyHeart("look https://x.com/a/status/9", { heart: true, heartStyle: "plain", heartGlue: "space" }, always)));
  style.applyHeart("night", { heart: false, heartStyle: "plain", heartGlue: "space" }, always) === "night"
    ? ok("and most messages carry none")
    : bad("heart ignores the plan");
  style.applyHeart("you ok?", { heart: true, heartStyle: "plain", heartGlue: "space" }, always) === "you ok? <3"
    ? ok("after a question is allowed for the heart - it is affection, not a joke", '"you ok? <3"')
    : bad("heart skipped a question line", JSON.stringify(style.applyHeart("you ok?", { heart: true, heartStyle: "plain", heartGlue: "space" }, always)));
  // his name: commander almost always, Commander when she means it
  style.applyCommander("night commander", { nickname: "capital" }) === "night Commander"
    ? ok("she can write his name with a capital", '"night Commander"')
    : bad("capital not applied", JSON.stringify(style.applyCommander("night commander", { nickname: "capital" })));
  style.applyCommander("Commander, listen to me", { nickname: "lower" }) === "commander, listen to me"
    ? ok("and lowercase on an ordinary message")
    : bad("lowercase not applied", JSON.stringify(style.applyCommander("Commander, listen", { nickname: "lower" })));
  style.applyCommander("commander's fault again", { nickname: "capital" }) === "Commander's fault again"
    ? ok("including the possessive")
    : bad("possessive broken", JSON.stringify(style.applyCommander("commander's fault again", { nickname: "capital" })));
  const nameInLink = style.applyCommander("look https://x.com/commander/status/9 commander", { nickname: "capital" });
  nameInLink.includes("x.com/commander/status") && nameInLink.endsWith(" Commander")
    ? ok("but never inside a link", JSON.stringify(nameInLink))
    : bad("link path mangled by his name", JSON.stringify(nameInLink));
  const fumbled = style.apply("commander i am so tired today", "sloppy", () => 0.01);
  /^commander /.test(fumbled)
    ? ok("and she never fumbles his name while typing sloppily", JSON.stringify(fumbled))
    : bad("his name got mangled by a typo", JSON.stringify(fumbled));
  const cased = style.plan({ def: { mess: 0.4, smile: 0, laugh: 0, heart: 0, face: 0, respect: 1 } }, { random: () => 0.01 });
  cased.nickname === "capital"
    ? ok("the choice comes from her mood, like everything else")
    : bad("nickname not planned", JSON.stringify(cased));
  /Commander, not commander/.test(mood.block({ def: mood.MOODS.soft, since: Date.now() }, { smile: { smile: false, nickname: "capital" } }))
    ? ok("and her prompt says which one to use")
    : bad("capital instruction missing from the prompt");
  !/Commander, not commander/.test(mood.block({ def: mood.MOODS.chaotic, since: Date.now() }, { smile: { smile: false, nickname: "lower" } }))
    ? ok("while an ordinary reply gets no instruction at all")
    : bad("nickname instruction leaked");
  const nameRate = (moodKey, seed) => {
    const r = seeded(seed);
    let caps = 0;
    for (let i = 0; i < 4000; i += 1) if (style.plan({ def: mood.MOODS[moodKey] }, { random: r }).nickname === "capital") caps += 1;
    return caps / 4000;
  };
  const softName = nameRate("soft", 61);
  const chaoticName = nameRate("chaotic", 61);
  console.log(`  ---- Commander with a capital: soft ${(softName * 100).toFixed(0)}% | warm ${(nameRate("warm", 61) * 100).toFixed(0)}% | chaotic ${(chaoticName * 100).toFixed(0)}%`);
  softName > 0.5 && softName < 0.75 && chaoticName < 0.15
    ? ok("she capitalises his name when she means it, not while teasing him")
    : bad("capital rate ignores mood", JSON.stringify({ soft: softName, chaotic: chaoticName }));

  // one entry point, in the one order that works: typing, his name, then the marks
  const prepared = style.prepare(
    "commander you are a Mess. im dying.",
    { level: "sloppy", smile: true, count: 2, style: "parens", heart: false, face: false, nickname: "capital" },
    () => 0.05,
  );
  prepared.startsWith("Commander ") && /dying\)\)$/.test(prepared) && !/im dying\./.test(prepared)
    ? ok("the whole shaping chain runs in order", JSON.stringify(prepared))
    : bad("prepare() order wrong", JSON.stringify(prepared));

  // the dice decide the marks. Rolling at most one per reply was only half the job:
  // the model had been told about all three habits and typed them anyway, so the
  // DELIVERED rate stayed at 53-61% of her messages against a person's 2%. A mark
  // she did not roll is removed, and the line keeps its words.
  const noMarks = { level: "clean", smile: false, heart: false, face: false };
  const stripped = [
    style.prepare("nothing happened))", noMarks, always),
    style.prepare("goodnight <3", noMarks, always),
    style.prepare("look at this xdd", noMarks, always),
    style.prepare("im home at 3:30 :33", noMarks, always),
  ];
  stripped[0] === "nothing happened" && stripped[1] === "goodnight" && stripped[2] === "look at this"
    ? ok("a mark she did not roll is taken out of what she sends, and the words stay", JSON.stringify(stripped.slice(0, 3)))
    : bad("unrolled marks reach him", JSON.stringify(stripped));
  stripped[3] === "im home at 3:30"
    ? ok("and a clock is never mistaken for a face on the way out", '"im home at 3:30 :33" -> "im home at 3:30"')
    : bad("the strip ate a clock", stripped[3]);
  style.prepare("goodnight", { level: "clean", heart: true, heartGlue: "space" }, always) === "goodnight <3" &&
    style.prepare("finally friday", { level: "clean", smile: true, count: 1, style: "parens" }, always) === "finally friday)"
    ? ok("while the mark she did roll still arrives")
    : bad("the rolled mark stopped arriving", JSON.stringify([
        style.prepare("goodnight", { level: "clean", heart: true, heartGlue: "space" }, always),
        style.prepare("finally friday", { level: "clean", smile: true, count: 1, style: "parens" }, always),
      ]));
  style.prepare(")) <3", noMarks, always) === ""
    ? ok("and a reply that was nothing but marks comes back empty for the caller to cover", "shapeReply supplies a plain line")
    : bad("a marks-only reply survived the strip", JSON.stringify(style.prepare(")) <3", noMarks, always)));
  /readable from a HIM line/.test(factsPrompt)
    ? ok("and the fact pass is told not to remember her own claims about him", "her invention is not evidence about him")
    : bad("factsPrompt lost the provenance rule");

  // the smug face, the one mark that is not a laugh and not affection
  const faceOn = { face: true, faceStyle: "plain" };
  style.applyFace("told you so", faceOn, always) === "told you so :3"
    ? ok("she can end a line with the smug :3", '"told you so :3"')
    : bad("face not applied", JSON.stringify(style.applyFace("told you so", faceOn, always)));
  style.applyFace("told you so", { face: true, faceStyle: "big" }, always) === "told you so :33"
    ? ok("and :33 when she is really pleased with herself", '"told you so :33"')
    : bad("big face broken", JSON.stringify(style.applyFace("told you so", { face: true, faceStyle: "big" }, always)));
  // The face and the laugh never share a line. This was a live defect, not a
  // hypothetical: a real reply shipped "so wheneevr honestly.)) :3". A smirk after
  // laughter is not a gesture anyone makes, so when the laugh holds the only line
  // the face is simply not owed this time.
  style.applyFace("told you so xd", { face: true, faceStyle: "plain" }, always) === "told you so xd"
    ? ok("a smirk never shares a line with her laugh", '"told you so xd" -> no :3')
    : bad("face stacked on the laugh's line", JSON.stringify(style.applyFace("told you so xd", faceOn, always)));
  const faceChoice = style.applyFace("told you so xd\n\nanyway\n\nnite <3", faceOn, always);
  faceChoice.split("\n\n")[1] === "anyway :3"
    ? ok("it takes the free line over the laugh's or the heart's", JSON.stringify(faceChoice))
    : bad("face placement preference", JSON.stringify(faceChoice));
  style.applyFace("told you so xd\n\nnite <3", faceOn, always) === "told you so xd\n\nnite <3"
    ? ok("and when every line is already holding a mark, it is not owed this time")
    : bad("face stacked anyway", JSON.stringify(style.applyFace("told you so xd\n\nnite <3", faceOn, always)));
  style.applyFace("seriously?", { face: true, faceStyle: "plain" }, always) === "seriously? :3"
    ? ok("a smirk after a question is fine when there is nothing else to hold it")
    : bad("face vanished on a question", JSON.stringify(style.applyFace("seriously?", faceOn, always)));
  style.applyFace("im home at 3:30", faceOn, always) === "im home at 3:30 :3"
    ? ok("a time like 3:30 is never mistaken for her face", '"im home at 3:30 :3"')
    : bad("clock read as a face", JSON.stringify(style.applyFace("im home at 3:30", faceOn, always)));
  style.applyFace("told you :3", faceOn, always) === "told you :3"
    ? ok("and never doubles up on one she typed herself")
    : bad("second face added", JSON.stringify(style.applyFace("told you :3", faceOn, always)));
  !/:3/.test(style.applyFace("here https://x.com/a/status/9", faceOn, always))
    ? ok("never welded onto a link")
    : bad("face on a link", JSON.stringify(style.applyFace("here https://x.com/a/status/9", faceOn, always)));
  style.applyFace("told you", { face: false }, always) === "told you"
    ? ok("and it only appears when the mood asks for it")
    : bad("face ignores the plan");
  const faceBlock = mood.block(
    { def: mood.MOODS.chaotic, since: Date.now(), why: "a test" },
    { level: "normal", smile: { smile: false }, heart: { heart: false }, face: { face: true, faceStyle: "big" } },
  );
  // the mark is DESCRIBED, never quoted: the notes used to spell the characters
  // out and a real reply came back as ")\n33 :33" - the model echoing the
  // instruction instead of writing a line (see smileLine in style.js)
  /smug face/.test(faceBlock) && /the double one/.test(faceBlock)
    ? ok("and her prompt tells her the face she rolled, without quoting the mark itself", "described, so it cannot be echoed back as a message")
    : bad("face missing from the prompt", JSON.stringify(faceBlock.split("\n").filter((l) => /face/.test(l))[0] || faceBlock.slice(-200)));
  // (a raw /:3/ check would trip on the clock in her mood line - 14:32 contains
  // ":3" - so look for the instruction itself)
  !/smug little face/.test(mood.block({ def: mood.MOODS.chaotic, since: Date.now() }, { face: { face: false } }))
    ? ok("and stays silent about it when she rolled none")
    : bad("face instruction leaked into a no-face reply");

  const faceRate = (moodKey, seed) => {
    const r = seeded(seed);
    let hits = 0;
    for (let i = 0; i < 4000; i += 1) if (style.plan({ def: mood.MOODS[moodKey] }, { random: r }).face) hits += 1;
    return hits / 4000;
  };
  const chaoticFace = faceRate("chaotic", 41);
  const softFace = faceRate("soft", 41);
  console.log(`  ---- :3 rate: chaotic ${(chaoticFace * 100).toFixed(0)}% | warm ${(faceRate("warm", 41) * 100).toFixed(0)}% | soft ${(softFace * 100).toFixed(0)}%`);
  chaoticFace > softFace * 1.5 && chaoticFace > 0.04 && softFace < 0.04
    ? ok("the smug face is the opposite mood to the heart - playful, not soft", `chaotic ${(chaoticFace * 100).toFixed(1)}% vs soft ${(softFace * 100).toFixed(1)}%`)
    : bad("face rate ignores mood", JSON.stringify({ chaotic: chaoticFace, soft: softFace }));

  const heartRate = (moodKey, seed) => {
    const r = seeded(seed);
    let hits = 0;
    for (let i = 0; i < 4000; i += 1) if (style.plan({ def: mood.MOODS[moodKey] }, { random: r }).heart) hits += 1;
    return hits / 4000;
  };
  const softHeart = heartRate("soft", 31);
  const sulkyHeart = heartRate("sulky", 31);
  console.log(`  ---- <3 rate: soft ${(softHeart * 100).toFixed(0)}% | warm ${(heartRate("warm", 31) * 100).toFixed(0)}% | sulky ${(sulkyHeart * 100).toFixed(0)}%`);
  softHeart > 0.06 && softHeart < 0.2 && sulkyHeart < 0.03
    ? ok("she sends hearts when she feels soft, almost never while sulking", `soft ${(softHeart * 100).toFixed(1)}% | sulky ${(sulkyHeart * 100).toFixed(2)}%`)
    : bad("heart rate ignores mood", JSON.stringify({ soft: softHeart, sulky: sulkyHeart }));
  const bigShare = (() => {
    const r = seeded(37);
    let hearts = 0;
    let big = 0;
    for (let i = 0; i < 20000; i += 1) {
      const p = style.plan({ def: mood.MOODS.soft }, { random: r });
      if (p.heart) { hearts += 1; if (p.heartStyle === "big") big += 1; }
    }
    return big / hearts;
  })();
  bigShare > 0.05 && bigShare < 0.25
    ? ok("<3 is the usual, <33 the rarer bigger one", `<33 is ${(bigShare * 100).toFixed(0)}% of her hearts`)
    : bad("heart size distribution", bigShare);

  // lowercase voice, capital names
  const caps = style.apply("It is late. You should sleep. Berlin is far.", "clean", () => 0.99);
  caps === "it is late. you should sleep. Berlin is far."
    ? ok("she stays lowercase but keeps place names", JSON.stringify(caps))
    : bad("lowercase enforcement", JSON.stringify(caps));
  // the capital "I" that models slip in mid-sentence, where the sentence-start
  // pass never looks: "yeah, I'm here" is not a thing this girl types
  const midI = style.apply("yeah, I'm here. so I think I'll stay in tonight", "clean", () => 0.99);
  midI === "yeah, i'm here. so i think i'll stay in tonight"
    ? ok("and a stray capital I is pulled down wherever it hides", JSON.stringify(midI))
    : bad("capital I survived", JSON.stringify(midI));
  const linkKept = style.apply("look https://I.example/I/thing ok", "clean", () => 0.99);
  linkKept.includes("https://I.example/I/thing")
    ? ok("without opening up a link to edit it", JSON.stringify(linkKept))
    : bad("link mangled by the lowercase pass", JSON.stringify(linkKept));

  const smileRate = (m, energy, seed) => {
    const r = seeded(seed);
    let hits = 0;
    for (let i = 0; i < 4000; i += 1) if (style.plan({ def: { mess: 0.4, smile: m } }, { energy, random: r }).smile) hits += 1;
    return hits / 4000;
  };
  const softRate = smileRate(mood.MOODS.soft.smile, null, 13);
  const sulkyRate = smileRate(mood.MOODS.sulky.smile, null, 13);
  const excitedRate = smileRate(mood.MOODS.soft.smile, "excited", 13);
  console.log(`  ---- () smile rate: sulky ${(sulkyRate * 100).toFixed(0)}% | soft ${(softRate * 100).toFixed(0)}% | soft+excited ${(excitedRate * 100).toFixed(0)}%`);
  sulkyRate < 0.08 && softRate > 0.1 && excitedRate > softRate
    ? ok("she smiles in a good mood, not while sulking", `sulky ${(sulkyRate * 100).toFixed(1)}% vs soft ${(softRate * 100).toFixed(1)}%`)
    : bad("smile rate ignores mood", `${sulkyRate} ${softRate} ${excitedRate}`);
  softRate < 0.5 ? ok("and it stays a habit, not a tic", `about 1 in ${Math.round(1 / softRate)} messages in her best mood`) : bad("she would smile constantly");

  // THE number nobody had measured: the three marks rolled independently, so each
  // one's own rate was deliberately chosen and their SUM never was. On the real
  // chat that sum was 53-61% of her messages carrying a mark, while the person she
  // was texting marked 2%. She is allowed one mark a reply, and about a quarter of
  // her replies at all - what she reaches for is still her mood's business.
  const markSurvey = (moodKey, seed, closeness = 0.5) => {
    const r = seeded(seed);
    const out = { any: 0, smile: 0, heart: 0, face: 0, stacked: 0, n: 8000 };
    for (let i = 0; i < out.n; i += 1) {
      const p = style.plan({ def: mood.MOODS[moodKey] }, { random: r, closeness });
      const marks = [p.smile, p.heart, p.face].filter(Boolean).length;
      if (marks) out.any += 1;
      if (marks > 1) out.stacked += 1;
      if (p.smile) out.smile += 1;
      if (p.heart) out.heart += 1;
      if (p.face) out.face += 1;
    }
    return out;
  };
  const lively = markSurvey("soft", 71);
  const flat = markSurvey("distant", 71);
  const livelyShare = lively.any / lively.n;
  const flatShare = flat.any / flat.n;
  console.log(
    `  ---- any mark at all: lively ${(livelyShare * 100).toFixed(1)}% (laugh ${((lively.smile / lively.n) * 100).toFixed(1)}% / heart ${((lively.heart / lively.n) * 100).toFixed(1)}% / face ${((lively.face / lively.n) * 100).toFixed(1)}%) | flat ${(flatShare * 100).toFixed(1)}%`,
  );
  Math.abs(livelyShare - style.MARK_BUDGET) < 0.05 && flatShare < 0.2 && lively.stacked === 0
    ? ok(
        "she marks about a quarter of her messages, never two marks at once",
        `${(livelyShare * 100).toFixed(0)}% of lively replies carry one mark, ${(flatShare * 100).toFixed(0)}% of flat ones`,
      )
    : bad("the combined mark rate is not a habit, it is a costume", JSON.stringify({ lively: livelyShare, flat: flatShare, stacked: lively.stacked }));
  // ...and the sum is the thing that was wrong, not the individual preferences:
  // a soft girl reaches for the heart more of the time than a chaotic one does,
  // even though the chaotic one marks MORE replies overall
  lively.heart / lively.any > 0.3 && flatShare < livelyShare
    ? ok(
        "while WHICH mark she reaches for stays her mood's business",
        `the heart is ${((lively.heart / lively.any) * 100).toFixed(0)}% of her soft-mood marks`,
      )
    : bad("the mark mix flattened out", JSON.stringify({ heartShare: lively.heart / lively.any }));

  // the linter for the tells that THIS was written by a model rather than a girl
  const helperVoice = style.assistantSpeak("I understand. Let me know if you need anything else, I'm here for you.");
  helperVoice.some((l) => l.id === "helper-voice")
    ? ok("the helper voice is caught before it can be sent", helperVoice.map((l) => l.id).join(", "))
    : bad("assistant voice passed the linter");
  style.assistantSpeak("Here is what I think:\n1. it was cold\n2. he is weird").some((l) => l.id === "list")
    ? ok("and so is a numbered list", "nobody texts in bullet points")
    : bad("a list passed the linter");
  style.assistantSpeak("firstly, i was tired — and furthermore, you never called").length >= 2
    ? ok("and the essay words with an em dash in them")
    : bad("essay tells passed the linter");
  // the thing that must never happen: her own voice tripping her own linter
  [
    "wait what",
    "you cant just drop that on me at 4am like its nothing",
    "finally friday)",
    "told you so :3",
    "night commander <3",
    "ok deal, 6pm i text you",
    "im not mad. im keeping score, thats different)",
  ].some((line) => style.assistantSpeak(line).length)
    ? bad("her own lines tripped the linter", JSON.stringify(["wait what", "you cant just drop that on me at 4am like its nothing", "finally friday)", "told you so :3", "night commander <3", "ok deal, 6pm i text you", "im not mad. im keeping score, thats different)"].filter((l) => style.assistantSpeak(l).length)))
    : ok("while nothing she would actually type trips it", "no false positives on her own lines");

  const dashed = style.sanitize("sure — i was thinking about you");
  !/\u2014/.test(dashed) && dashed.includes("i was thinking about you")
    ? ok("and an em dash never reaches him", JSON.stringify(dashed))
    : bad("em dash survived", dashed);
  const bullets = style.sanitize("- call mom\n- buy milk");
  !/^\s*[-•]/m.test(bullets) && bullets.includes("call mom")
    ? ok("nor do bullet points", JSON.stringify(bullets))
    : bad("bullets survived", bullets);

  // her own mark is the punctuation of that line - the laugh must not glue a
  // bracket onto it ("im serious <3)" was shipping in real chats)
  const plan = { smile: true, count: 3, style: "parens" };
  const hearted = style.applySmile("im serious <3", plan, () => 0);
  hearted === "im serious <3"
    ? ok("a laugh is never glued onto a line that already ends in her own heart", `"${hearted}"`)
    : bad("her mark got a stray bracket", hearted);
  style.applySmile("im serious <3\n\nthat was ridiculous", plan, () => 0).includes("ridiculous)))")
    ? ok("it moves to the other line instead, or is simply not owed this time")
    : bad("the laugh vanished even where there was a plain line", style.applySmile("im serious <3\n\nthat was ridiculous", plan, () => 0));
  style.applySmile("im serious", plan, () => 0) === "im serious)))"
    ? ok("and a plain line still gets it")
    : bad("the laugh stopped working", style.applySmile("im serious", plan, () => 0));
  style.apply("everything xddddddd", "normal", () => 0.99) === "everything xdddd" && style.apply("everything xdd", "normal", () => 0.99) === "everything xdd"
    ? ok("and a runaway xdddddd is capped while xdd is left alone", "xddddddd -> xdddd")
    : bad("laugh length not capped", style.apply("everything xddddddd", "normal", () => 0.99));
  style.applySmile("no", { smile: true, count: 3, style: "parens" }, () => 0) === "no"
    ? ok("and a one-word line never gets a laugh attached", '"no)" is a tic, not a laugh')
    : bad("a laugh landed on a one-word line", style.applySmile("no", { smile: true, count: 3, style: "parens" }, () => 0));
  style.applySmile("i dont know who he is.", { smile: true, count: 2, style: "parens" }, () => 0) === "i dont know who he is))"
    ? ok("and the full stop it replaces is dropped rather than kept under it", '"is.)" -> "is))"')
    : bad("the laugh landed after a full stop", style.applySmile("i dont know who he is.", { smile: true, count: 2, style: "parens" }, () => 0));

  // Two marks welded together is the tell of a marking pass, not of a girl. A
  // SPACED one after another is a different gesture and is ordinary texting, so the
  // line is drawn at the weld: "))<3" must be impossible, "ok)) <3" is fine.
  style.applyHeart("ok))", { heart: true, heartGlue: "none" }, () => 0) === "ok))"
    ? ok("a heart is never welded onto the laugh's line", '"))<3" was shipping in real chats')
    : bad("the heart welded onto the laugh", style.applyHeart("ok))", { heart: true, heartGlue: "none" }, () => 0));
  style.applyHeart("ok))", { heart: true, heartGlue: "space" }, () => 0) === "ok)) <3"
    ? ok("while a spaced one after a laugh is just her being affectionate", '"ok)) <3"')
    : bad("a spaced heart was blocked", style.applyHeart("ok))", { heart: true, heartGlue: "space" }, () => 0));
  style.applyHeart("ok that is the whole story", { heart: true, heartGlue: "space" }, () => 0).endsWith("story <3")
    ? ok("and it always lands on a plain line")
    : bad("the heart stopped landing at all");
  !/<3:3/.test(style.applyFace("night <3", { face: true }, () => 0))
    ? ok("and the smirk is never welded onto her heart either")
    : bad("the face welded onto a heart", style.applyFace("night <3", { face: true }, () => 0));

  // what she FEELS is her mood; what the two of them are DOING is the register,
  // and the register has to win - he said he might be depressed and she answered
  // with "what do you mean by that)))"
  const chatty = { key: "soft", def: { smile: 0.5, heart: 0.4, face: 0.3, mess: 0.3 } };
  const light = style.plan(chatty, { random: () => 0.1, closeness: 0.6 });
  const earnest = style.plan(chatty, { random: () => 0.1, closeness: 0.6, earnest: true });
  (light.smile || light.face) && !earnest.smile && !earnest.face
    ? ok("a serious conversation switches off her laugh and her smirk for that reply", `while an ordinary one still marks it (${light.smile ? "laugh" : "smirk"})`)
    : bad("the register does not reach the marks", JSON.stringify({ light: [light.smile, light.face], earnest: [earnest.smile, earnest.face] }));
  earnest.heart
    ? ok("but the heart stays, and comes more easily - that is the mark that belongs there")
    : bad("she stopped reaching for a heart in the one place it matters");
  !style.prepare("what do you mean by that", earnest, () => 0.02).match(/[)]{1,}|xd/i)
    ? ok("so a heavy message is never answered with a shrug", `"${style.prepare("what do you mean by that", earnest, () => 0.02)}"`)
    : bad("a laugh survived into an earnest reply", style.prepare("what do you mean by that", earnest, () => 0.02));
}

// ------------------------------------------------------------ timing
// A deterministic generator, so a failure here is always reproducible.
function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clock = (minutes, weekday = "Wednesday") => ({
  dateStr: "2026-09-16",
  weekday,
  hour: Math.floor(minutes / 60),
  minute: minutes % 60,
  minutes,
  hhmm: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
});

function survey(t, { sinceLastBotMs = 6 * 3600000, burstCount = 1, n = 6000, seed = 7 } = {}) {
  const rnd = seeded(seed);
  const counts = {};
  const delays = {}; // per mode: { min, max } of the delay she would wait
  let maxDelay = 0;
  let minDelay = Infinity;
  for (let i = 0; i < n; i += 1) {
    const plan = planReaction({ t, burstCount, sinceLastBotMs, random: rnd });
    counts[plan.mode] = (counts[plan.mode] || 0) + 1;
    if (plan.delayMs !== null) {
      maxDelay = Math.max(maxDelay, plan.delayMs);
      minDelay = Math.min(minDelay, plan.delayMs);
      const d = delays[plan.mode] || { min: Infinity, max: 0 };
      d.min = Math.min(d.min, plan.delayMs);
      d.max = Math.max(d.max, plan.delayMs);
      delays[plan.mode] = d;
    }
    if (plan.mode === "ignore" && plan.delayMs !== null) bad("ignore must not schedule a reply");
  }
  for (const k of Object.keys(counts)) counts[k] = counts[k] / n;
  return { counts, delays, maxDelay, minDelay };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function testTiming() {
  console.log("\n[6] human timing (how fast she answers)");
  const afternoon = clock(14 * 60);
  const night = clock(3 * 60);

  const day = survey(night === afternoon ? afternoon : afternoon, { seed: 11 });
  const shares = Object.entries(day.counts).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" | ");
  console.log(`  ---- afternoon, he was quiet for hours: ${shares}`);

  const wantShares = { instant: 0.22, short: 0.36, long: 0.20, later: 0.14, ignore: 0 };
  for (const [mode, expect] of Object.entries(wantShares)) {
    const got = day.counts[mode] || 0;
    near(got, expect, 0.05)
      ? ok(`${mode} share`, `${(got * 100).toFixed(1)}% (want ~${(expect * 100).toFixed(0)}%)`)
      : bad(`${mode} share`, `${(got * 100).toFixed(1)}% (want ~${(expect * 100).toFixed(0)}%)`);
  }
  day.maxDelay <= 25 * 60000 && day.minDelay >= 300
    ? ok("waking-hour waits stay sane", `${Math.round(day.minDelay / 1000)}s .. ${Math.round(day.maxDelay / 60000)}min`)
    : bad("wait outside bounds", `${day.minDelay} .. ${day.maxDelay} ms`);

  const active = survey(afternoon, { sinceLastBotMs: 30_000, seed: 23 });
  console.log(`  ---- mid-conversation: ${Object.entries(active.counts).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" | ")}`);
  (active.counts.ignore || 0) === 0 && (active.counts.instant || 0) >= 0.35
    ? ok("she answers fast while you are actually chatting", `${((active.counts.instant || 0) * 100).toFixed(0)}% instant, never silent`)
    : bad("active exchange handling", `instant ${active.counts.instant}, ignore ${active.counts.ignore}`);

  const burst = survey(afternoon, { burstCount: 5, seed: 31 });
  console.log(`  ---- five messages in a row: ${Object.entries(burst.counts).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" | ")}`);
  (burst.counts.instant || 0) < (day.counts.instant || 0) && (burst.counts.later || 0) > (day.counts.later || 0)
    ? ok("a wall of messages makes her read it all first", `instant ${(burst.counts.instant * 100).toFixed(0)}% (was ${(day.counts.instant * 100).toFixed(0)}%)`)
    : bad("burst handling", JSON.stringify(burst.counts));

  isAsleep(night) && !isAsleep(afternoon) ? ok("shes asleep at 03:00, awake at 14:00") : bad("sleep window");
  const smallHours = survey(night, { seed: 41 });
  console.log(`  ---- 03:00 in Dortmund: ${Object.entries(smallHours.counts).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" | ")}`);
  (smallHours.counts.asleep || 0) === 1
    ? ok("while she sleeps nothing gets answered - a hard stop, not a probability", "100% asleep")
    : bad("night behaviour", JSON.stringify(smallHours.counts));
  Object.keys(smallHours.counts).length === 1
    ? ok("no half-awake replies at 3am anymore", "the night has exactly one outcome")
    : bad("night still rolls other modes", JSON.stringify(smallHours.counts));
  const asleepWait = smallHours.delays.asleep;
  asleepWait && asleepWait.min >= 4 * 3600 * 1000
    ? ok("night waits land in the morning", `asleep replies wait ${gapWords(asleepWait.min)} - ${gapWords(asleepWait.max)}`)
    : bad("night wait too short", JSON.stringify(asleepWait));
  !(smallHours.delays.instant || smallHours.delays.short || smallHours.delays.later)
    ? ok("no reply mode exists at night at all anymore", "no half-awake typing at 3am")
    : bad("night still has live reply modes", JSON.stringify(smallHours.delays));
  minutesUntilMorning(night) === 5 * 60 ? ok("morning countdown", "03:00 -> 08:00 = 300 min") : bad("minutesUntilMorning", String(minutesUntilMorning(night)));

  // wakePlan is pure and shared by bot.js for restart recovery, so its shape is a contract
  const wp = wakePlan({ t: night, sched: { bedMin: 1380, wakeMin: 480, hours: 8 }, random: () => 0 });
  wp.mode === "asleep" && wp.delayMs === 5 * 60 * 60000 && typeof wp.note === "string" && wp.note.length > 0
    ? ok("wakePlan is the one night plan", "03:00 with a 08:00 wake = exactly 5h (plus real-world wake jitter), note present")
    : bad("wakePlan shape", JSON.stringify(wp));
  wakePlan({ t: night, sched: { bedMin: 1380, wakeMin: 480, hours: 8 }, random: () => 0.999 }).delayMs <= (5 * 60 + 25) * 60000
    ? ok("and its jitter stays inside the not-a-morning-person window")
    : bad("wakePlan jitter", "over the window");

  // notes she is given about her own lateness
  const late = reactionNote({ mode: "later", note: "you left him on read" }, { sinceLastBotMs: 6 * 3600000 });
  late.includes("left him on read") && late.includes("missed him") ? ok("late reply gets an internal note") : bad("late note", late);
  reactionNote({ mode: "ignore", note: "read, no answer" }) === "" ? ok("a silent read carries no note") : bad("ignore note leaked");

  // quoting: which of his messages her answer hangs on
  const pile = [{ id: 12, text: "a photo" }];
  const inbox = [{ id: 21, text: "look at this reel" }, { id: 22, text: "did you see my message" }];

  chooseQuote({ threadId: 77, unanswered: pile, inbox, random: () => 0.95 })?.source === "thread"
    ? ok("an explicit Telegram reply is always quoted")
    : bad("explicit reply target lost");
  chooseQuote({ unanswered: pile, inbox, random: () => 0 }) === null
    ? ok("old unanswered and answered messages are never quoted")
    : bad("old message was quoted without an explicit reply");
  chooseQuote({ random: () => 0 }) === null ? ok("no explicit target, no quote") : bad("quote without a target");
  chooseQuote({ threadId: 77 }).id === 77 ? ok("the quote carries the exact explicit message id") : bad("quote id lost");

  pickReplyTarget(pile, seeded(5)) === null ? ok("spontaneous texts never quote old messages") : bad("spontaneous quote target selected");
  pickReplyTarget([], () => 0) === null ? ok("no target, no quote") : bad("quote without a target");

  gapWords(45_000) === "45 seconds" && gapWords(600_000) === "10 minutes" && gapWords(7_200_000) === "2 hours"
    ? ok("gap wording", "45 seconds / 10 minutes / 2 hours")
    : bad("gap wording", `${gapWords(45_000)}, ${gapWords(600_000)}, ${gapWords(7_200_000)}`);
}

// ------------------------------------------------------- token accounting
// ------------------------------------------------- what reaches the model
// The bug this guards: plain text messages were never put into the request, so
// she answered an empty prompt and only reacted to photos, captions and links.
// The canary goes through the real bot in dry-run (nothing sent, memory untouched).
async function testInput() {
  console.log("\n[9] what actually reaches the model");
  const canary = "canary-phrase-zq7";
  sandboxDir = sandboxDir || makeSandbox();
  const dryRun = () => run(process.execPath, ["bot.js"], {
    NEGEV_DRY_RUN: "1",
    NEGEV_DRY_DUMP: "1",
    NEGEV_DRY_WAIT_MS: "20000",
    NEGEV_DRY_MESSAGE: canary,
    // this checks her prompt, not her shift: a busy window would answer with the
    // canned line and there would be nothing to inspect
    NEGEV_DRY_IGNORE_BUSY: "1",
  }, sandboxDir);

  let res = await dryRun();
  if (res.out.includes("no owner bound yet")) {
    warn("model input check", "the bot has no owner yet - send it /start on Telegram");
    return;
  }

  // She reads some messages and answers nothing at all, and her reaction is rolled
  // fresh on every run - so one roll can legitimately produce no reply, and with no
  // reply there is no prompt to inspect. That is her working, not the test failing,
  // so re-roll a couple of times instead of failing the build on her dice.
  for (let attempt = 0; attempt < 2 && !/\[dump\] --- what he sent/.test(res.out); attempt += 1) {
    res = await dryRun();
  }
  if (!/\[dump\] --- what he sent/.test(res.out)) {
    const reaction = (res.out.match(/\[timing\] (instant|short|long|later|ignore|asleep|busy)/) || [])[1] || null;
    reaction
      ? warn("model input check", `she drew a "${reaction}" reaction three times running, so there was no reply to inspect`)
      : bad("his words never reached the model", `no dump line - the dry run said ${JSON.stringify(String(res.out || "").trim().slice(-300))}`);
    return;
  }

  const dump = res.out.match(/\[dump\] --- what he sent ---\s*\r?\n([^\r\n]*)/);
  const reachedPrompt = Boolean(dump && dump[1].includes(canary));
  reachedPrompt
    ? ok("his actual words land in her prompt", `"${(dump[1] || "").slice(0, 50)}"`)
    : bad("his words never reached the model", dump
      ? `prompt held "${dump[1]}"`
      // the dry run is a second bot process: if it dies at boot, its own last
      // words are the only clue, so never throw them away
      : `no dump line - the dry run said ${JSON.stringify(String(res.out || "").trim().slice(-300))}`);

  // the middle carries things like "normal typing, laughing ))", so take it whole
  const moodLine = res.out.match(/\[mood\] (\w+) \| energy (\w+) \| ([^|]+) \| bubbles<=(\d+) \| words<=(\d+)/);
  moodLine && /typing/.test(moodLine[3])
    ? ok("her mood decided the shape of that reply", `${moodLine[1]}, energy ${moodLine[2]}, ${moodLine[3].trim()}, <=${moodLine[4]} bubbles, <=${moodLine[5]} words`)
    : bad("no mood applied to the reply", res.out.includes("[mood]") ? "a mood was rolled but the style line was malformed" : "no mood log line at all");

  const limits = moodLine ? [Number(moodLine[4]), Number(moodLine[5])] : [0, 0];
  const sent = [...res.out.matchAll(/\[dry-run\] she would send[^:]*: "([^"]*)"/g)].map((m) => m[1]);
  const longest = Math.max(...sent.map((s) => s.split(/\s+/).length));
  sent.length > 0 && sent.length <= limits[0]
    ? ok("and she stayed inside it", `${sent.length} of ${limits[0]} bubble(s), ${longest} words against a ${limits[1]} word cap`)
    : bad("bubble count ignores her mood", JSON.stringify(sent));
  // word caps are a model behaviour with the token budget enforcing the ceiling,
  // so an overshoot is a warning about the model, not a broken build
  longest <= limits[1]
    ? ok("word cap respected", `${longest} of ${limits[1]} words`)
    : warn("she went past her mood's word cap", `${longest} words for a ${limits[1]} cap (token budget still capped it)`);

  // nothing may be dropped between shaping the reply and sending it: a preview
  // interrupted mid-send used to make a planned laugh look like it never happened
  const shaped = (res.out.match(/\[dry-run\] shaped: (.*)/) || [])[1];
  const shapedBubbles = shaped ? JSON.parse(shaped).split(/\n\s*\n/).filter(Boolean).length : 0;
  shapedBubbles > 0 && sent.length === Math.min(shapedBubbles, limits[0])
    ? ok("every bubble she wrote is actually delivered", `${sent.length} of ${shapedBubbles} shaped bubble(s)`)
    : bad("bubbles lost between shaping and sending", JSON.stringify({ shaped: shapedBubbles, sent: sent.length, max: limits[0] }));

  // A real conversation, not one clever reply: the second turn has to be written by
  // someone who remembers the first, and who can read her own words back.
  const conversation = () => run(process.execPath, ["bot.js"], {
    NEGEV_DRY_RUN: "1",
    NEGEV_DRY_DUMP: "1",
    NEGEV_DRY_IGNORE_BUSY: "1",
    NEGEV_DRY_SCRIPT: "today was long, i think i want to quit || ok ok i take it back. it has just been a long week",
  }, sandboxDir);
  let convo = await conversation();
  const bubblesIn = (out) => [...out.matchAll(/\[dry-run\] her: "([^"]*)"/g)].map((m) => m[1]);
  // she is allowed to read his message and say nothing at all, so re-roll the dice
  // rather than failing the build on a legitimate silence
  for (let attempt = 0; attempt < 2 && bubblesIn(convo.out).length < 2; attempt += 1) convo = await conversation();
  const herLines = bubblesIn(convo.out);
  if (herLines.length < 2) {
    warn("conversation check", `she stayed quiet through both turns - ${JSON.stringify(String(convo.out || "").trim().slice(-200))}`);
  } else {
    ok("a scripted conversation gets a reply to every turn", `${herLines.length} bubbles over 2 of his messages`);
  }
  /WHAT YOU HAVE ALREADY SAID IN THIS CONVERSATION/.test(convo.out)
    ? ok("and by the second turn she is shown her own words back", "so she cannot repeat a point she already made")
    : bad("no repeat-guard in her prompt");
  herLines.length >= 2 && new Set(herLines.map((l) => l.slice(0, 40))).size === herLines.length
    ? ok("and she does not send the same line twice")
    : bad("she repeated herself verbatim", JSON.stringify(herLines));

  const budgets = MOOD_KEYS.map((k) => mood.tokenBudget(mood.MOODS[k], 320));
  Math.max(...budgets) <= 320 && Math.min(...budgets) >= 60 && new Set(budgets).size > 3
    ? ok("and the output budget follows her mood", `${Math.min(...budgets)}-${Math.max(...budgets)} tokens across moods`)
    : bad("token budget does not vary", JSON.stringify(budgets));
}

async function testUsage() {
  console.log("\n[7] tokens and cost per reply");
  mem.setReadOnly(true); // never touch the real ledger from a test
  usage.resetForTest();

  const offPeak = Date.UTC(2026, 8, 15, 20, 0); // Tuesday 20:00 UTC
  const peak = Date.UTC(2026, 8, 15, 2, 0); // Tuesday 02:00 UTC
  const weekend = Date.UTC(2026, 8, 19, 2, 0); // Saturday 02:00 UTC
  !usage.isPeak(offPeak) && usage.isPeak(peak) && !usage.isPeak(weekend)
    ? ok("peak hours are Mon-Fri 01-04 and 06-10 UTC", "weekends and evenings are off-peak")
    : bad("peak detection", `${usage.isPeak(offPeak)} ${usage.isPeak(peak)} ${usage.isPeak(weekend)}`);

  const r = usage.ratesFor(CONFIG.model, offPeak);
  r.hit === 0.003 && r.miss === 0.15 && r.out === 0.6
    ? ok("flash off-peak rates", "$0.003/M cached, $0.15/M input, $0.60/M output")
    : bad("off-peak rates", JSON.stringify(r));
  usage.ratesFor(CONFIG.model, peak).out === 1.2
    ? ok("peak is exactly double", "$1.20/M output")
    : bad("peak rates", JSON.stringify(usage.ratesFor(CONFIG.model, peak)));

  // a real-shaped response: 4,182 prompt tokens of which 3,900 were cache hits
  const key = usage.begin({ kind: "reply" });
  usage.record({
    model: CONFIG.model,
    at: offPeak,
    usage: { prompt_tokens: 4182, prompt_cache_hit_tokens: 3900, prompt_cache_miss_tokens: 282, completion_tokens: 96, total_tokens: 4278 },
  });
  usage.attach(key, 555);
  usage.end(key);

  const bucket = usage.bucketForMessage(555);
  bucket ? ok("a sent bubble can be priced by its message id", `bucket ${bucket.key}`) : bad("bucket lookup failed");
  const expected = (3900 * 0.003 + 282 * 0.15 + 96 * 0.6) / 1e6;
  Math.abs(bucket.cost - expected) < 1e-12
    ? ok("cost maths", `$${bucket.cost.toFixed(6)} = 3,900 cached + 282 fresh + 96 out`)
    : bad("cost maths", `${bucket.cost} vs ${expected}`);
  bucket.calls === 1 && bucket.prompt === 4182 && bucket.completion === 96
    ? ok("tokens counted per reply", "4,182 in / 96 out, 1 call")
    : bad("token counting", JSON.stringify(bucket));

  // two more calls, one attached after a memory pass, to prove the bucket grows
  usage.record({ model: CONFIG.model, at: offPeak, usage: { prompt_tokens: 900, completion_tokens: 60 } });
  bucket.calls === 1
    ? ok("after the reply ends, later calls do not pollute its bucket", "no current bucket")
    : bad("bucket kept growing", String(bucket.calls));
  usage.record({ model: CONFIG.model, at: offPeak, usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 } });
  const t = usage.totals().totals;
  t.calls === 3 ? ok("totals count every model call", "3 calls") : bad("totals calls", String(t.calls));
  Math.abs(t.miss - (282 + 900 + 100)) < 1e-9
    ? ok("a response with no cache info is billed as fresh input", "1,282 fresh tokens")
    : bad("missing cache info handled wrong", JSON.stringify(t));

  const replyReport = usage.renderReply(bucket);
  const allReport = usage.renderTotals();
  const looksPriced = (s) => /- cost: \$\d+\.\d+/.test(s) && /- total: [\d,]+ tokens/.test(s);
  looksPriced(replyReport) && looksPriced(allReport)
    ? ok("both reports show tokens and price")
    : bad("report format", replyReport.replace(/\n/g, " | "));
  /- input: 4,182 tokens - 3,900 cached \/ 282 fresh/.test(replyReport)
    ? ok("multi-line report says what was cached", "4,182 in - 3,900 cached / 282 fresh")
    : bad("cached/fresh line", replyReport);
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(replyReport + allReport)
    ? ok("reports stay emoji-free")
    : bad("emoji in a report");
  usage.bucketForMessage(999999) === null ? ok("an unknown message reports nothing") : bad("phantom bucket");

  // a second call in the same bucket used to be labelled "a memory pass" whatever
  // it was, which matters when the question is what a reply cost
  const key2 = usage.begin({ kind: "reply" });
  usage.record({ model: CONFIG.model, at: offPeak, usage: { prompt_tokens: 3000, completion_tokens: 20, prompt_cache_hit_tokens: 2200, prompt_cache_miss_tokens: 800 } });
  usage.note("1 regeneration");
  usage.record({ model: CONFIG.model, at: offPeak, usage: { prompt_tokens: 3050, completion_tokens: 18, prompt_cache_hit_tokens: 2200, prompt_cache_miss_tokens: 850 } });
  const retried = usage.renderReply(usage.totals().replies.find((r) => r.key === key2));
  /2 model calls: the reply \+ 1 regeneration/.test(retried)
    ? ok("and a reply that needed a second attempt says so instead of guessing", retried.match(/\(2 model calls[^)]*\)/)[0])
    : bad("the second call was mislabelled", retried.replace(/\n/g, " | "));
  usage.end(key2);
  const twoCalls = usage.totals().replies.find((r) => r.key === key2).cost;
  const oneCall = usage.totals().replies.find((r) => r.key === key2).cost / 2;
  twoCalls > oneCall
    ? ok("a regeneration is priced at roughly what one more reply costs", `$${oneCall.toFixed(6)} → $${twoCalls.toFixed(6)} for the turn`)
    : bad("the regeneration was not counted", String(twoCalls));
  const mean = 0.00014;
  Math.abs(oneCall - mean) / mean < 0.35
    ? ok("and a normal reply lands where the measured average does", `$${oneCall.toFixed(6)} vs ~$${mean.toFixed(6)} measured`) : bad("the rate maths drifted from the measured average", String(oneCall));

  console.log(`  ---- she would answer "!tokenall" with:\n${allReport.split("\n").map((l) => `  | ${l}`).join("\n")}`);
}

// --------------------------------------------------------- moods
async function testMood() {
  console.log("\n[8] moods (why she is not the same twice)");
  const rnd = seeded(19);
  mem.setReadOnly(true);
  const state = { mood: null };
  const spread = {};
  const durations = [];
  let now = Date.UTC(2026, 8, 15, 12, 0);

  // a simulated week of moments: she should cycle through moods, not sit in one
  for (let i = 0; i < 400; i += 1) {
    now += irandSel(1, 5, rnd) * 3600000; // 1-5 hours later
    const t = clock(((now / 3600000) + 2) % 24 * 60 | 0); // rough Dortmund hour
    const m = mood.ensureMood(state, { now, t, sinceLastUserMs: irandSel(1, 20, rnd) * 3600000, random: rnd });
    spread[m.key] = (spread[m.key] || 0) + 1;
    durations.push(m.until - m.since);
  }
  const kinds = Object.keys(spread).length;
  kinds >= 5
    ? ok("she moves through moods over time", `${kinds} different moods in a week: ${Object.entries(spread).map(([k, v]) => `${k} ${v}`).join(", ")}`)
    : bad("moods barely change", JSON.stringify(spread));
  const hMin = Math.min(...durations) / 3600000;
  const hMax = Math.max(...durations) / 3600000;
  hMin >= 1 && hMax <= 7
    ? ok("each mood lasts hours, not messages", `${hMin}h - ${hMax}h`)
    : bad("mood duration out of range", `${hMin}h - ${hMax}h`);

  // her sleep is deliberately fixed: 02:00-08:00 every day, six full hours
  const beds = [];
  const wakes = [];
  for (let i = 0; i < 400; i += 1) {
    const day = new Date(Date.UTC(2026, 8, 7 + i)).getUTCDay();
    const w = sleep.ensureWindow({ sleep: null }, {
      t: { dateStr: `2026-09-${String(7 + i).padStart(2, "0")}`, minutes: 12 * 60, weekday: day, hour: 12 },
      mood: { key: i % 3 === 0 ? "tired" : i % 3 === 1 ? "wired" : "warm" },
      random: seeded(70 + i),
    });
    beds.push(w.bedMin);
    wakes.push(w.wakeMin);
  }
  beds.every((m) => m === 120) && wakes.every((m) => m === 480)
    ? ok("her full sleep window is fixed", "02:00-08:00 every day")
    : bad("sleep window is not fixed", JSON.stringify({ beds: [...new Set(beds)], wakes: [...new Set(wakes)] }));
  const sameDay = sleep.ensureWindow({ sleep: null }, { t: { dateStr: "2026-09-10", minutes: 700, weekday: 4, hour: 11 }, random: seeded(3) });
  const kept = sleep.ensureWindow({ sleep: sameDay }, { t: { dateStr: "2026-09-10", minutes: 1400, weekday: 4, hour: 23 }, random: seeded(999) });
  kept.bedMin === sameDay.bedMin && kept.wakeMin === sameDay.wakeMin
    ? ok("and the fixed window stays stable through the day", `${hhmmOf(kept.bedMin)} - ${hhmmOf(kept.wakeMin)}, ${kept.hours}h`)
    : bad("the sleep window changed mid-day");

  // one night that starts before midnight, one that starts after it
  const early = { bedMin: 1350, wakeMin: 480, hours: 9.5 };
  const late = { bedMin: 100, wakeMin: 600, hours: 8.33 };
  const at = (mins) => ({ dateStr: "2026-09-16", minutes: mins, weekday: 3, hour: Math.floor(mins / 60) });
  sleep.isAsleepAt(early, at(1380)) && sleep.isAsleepAt(early, at(120)) && !sleep.isAsleepAt(early, at(600)) && !sleep.isAsleepAt(early, at(960))
    ? ok("asleep from her bedtime until she gets up", "bed 22:30, up 08:00: asleep at 23:00 and 02:00, awake at 10:00 and 16:00")
    : bad("early night misread", JSON.stringify([1380, 120, 600, 960].map((m) => [hhmmOf(m), sleep.isAsleepAt(early, at(m))])));
  sleep.isAsleepAt(late, at(120)) && sleep.isAsleepAt(late, at(420)) && !sleep.isAsleepAt(late, at(700))
    ? ok("and it still works when bedtime is after midnight", "bed 01:40, up 10:00")
    : bad("late night misread");
  Math.round(sleep.untilWakeMs(early, at(1380)) / 60000) === 540
    ? ok("she knows how long until she is up", "9 hours at 23:00 for an 08:00 morning")
    : bad("wake countdown", String(sleep.untilWakeMs(early, at(1380)) / 60000));
  sleep.minutesSinceWaking(early, at(495)) === 15 && sleep.minutesSinceWaking(early, at(600)) === null && sleep.minutesSinceWaking(early, at(300)) === null
    ? ok("and whether she has just crawled out of bed", "15 minutes up = still thick-headed")
    : bad("just-woke detection");
  const shortNight = { bedMin: 120, wakeMin: 480, hours: 5.9 };
  const normalNight = { bedMin: 120, wakeMin: 480, hours: 6 };
  sleep.sleptBadly(shortNight) && !sleep.sleptBadly(normalNight)
    ? ok("six hours counts as a full night, less than six does not")
    : bad("six-hour sleep rule");
  const tiredMorning = { mood: { key: "warm", since: Date.now(), until: Date.now() + 3600000, hours: 3 } };
  mood.wakeUp(tiredMorning, { hours: 5.4, random: () => 0.01 })?.key === "tired"
    ? ok("and it follows her into the morning", "5.4h of sleep -> tired")
    : bad("a bad night did not show on her");
  const restedMorning = { mood: { key: "warm", since: Date.now(), until: Date.now() + 3600000, hours: 3 } };
  mood.wakeUp(restedMorning, { hours: 9.2, random: () => 0.01 }) === null && restedMorning.mood.key === "warm"
    ? ok("while a full night leaves her where she was")
    : bad("a good night changed her mood");

  // nothing of hers lands in the middle of her night
  let slotsOutside = 0;
  let slotsChecked = 0;
  for (let i = 0; i < 60; i += 1) {
    const sched = sleep.ensureWindow({ sleep: null }, { t: at(720), mood: { key: "warm" }, random: seeded(90 + i) });
    for (const slot of proactive.makeSchedule(sched)) {
      slotsChecked += 1;
      const inWakingHours = sched.bedMin > sched.wakeMin
        ? slot.t >= sched.wakeMin + 45 && slot.t <= sched.bedMin - 60
        : slot.t >= sched.wakeMin + 45 && slot.t <= 23 * 60 + 15;
      if (!inWakingHours) slotsOutside += 1;
    }
  }
  slotsChecked > 200 && slotsOutside === 0
    ? ok("and she never texts first from bed", `${slotsChecked} spontaneous slots, all inside her waking hours`)
    : bad("spontaneous texts inside her night", JSON.stringify({ slotsChecked, slotsOutside }));

  // the conversation has to be able to move her, not just the clock. The tell this
  // guards: a girl who stays sulky straight through "i think i might be down lately"
  const sig = mood.readSignal;
  sig("i think i might be down lately").serious && sig("today was long").serious
    ? ok("she can hear that he is struggling", '"i think i might be down lately"')
    : bad("serious message not recognised");
  sig("finally off work").explained && sig("sorry, my bad").explained && !sig("hi").explained
    ? ok("and that he explained himself or apologised", '"finally off work"')
    : bad("explanation not recognised");
  sig("i missed you today <3").affectionate && sig("that was funny lol").funny
    ? ok("and when he is being sweet or funny")
    : bad("sweet/funny signal lost");

  const sulkyState = () => ({ mood: { key: "sulky", since: Date.now(), until: Date.now() + 3600000, why: "he went quiet", hours: 2, hisMsgs: 3 } });
  const after = (signal, state = sulkyState()) => mood.react(state, signal, { random: () => 0.01 });
  after(sig("i think i might be down lately"))?.key === "soft"
    ? ok("a sulk ends when he opens up about how he is doing", "sulky -> soft")
    : bad("mood did not move for a struggling him", JSON.stringify(after(sig("im down"))?.key));
  after(sig("sorry, i fell asleep"))?.key === "warm"
    ? ok("and an apology ends the grudge instead of feeding it", "sulky -> warm")
    : bad("apology did not dissolve the sulk");
  after(sig("i missed you today"))?.key === "warm"
    ? ok("and being sweet gets through to a distant girl", "sulky -> warm")
    : bad("affection did not move her");
  after(sig("so how was your shift")) === null && after(sig("lol"), { mood: { key: "warm", hours: 2 } }) === null
    ? ok("while an ordinary line leaves her exactly where she was")
    : bad("mood moved for no reason");
  const turns = sulkyState();
  mood.noteHisMessage(turns);
  turns.mood.hisMsgs === 4 ? ok("she counts how long she has been like this", "4 his messages into this mood") : bad("his-message counter");
  const longChat = { mood: { key: "sulky", since: Date.now(), until: Date.now() + 6 * 3600000, why: "he went quiet", hours: 6, hisMsgs: 9, checkedAt: Date.now() } };
  let moved = 0;
  for (let i = 0; i < 400; i += 1) {
    const st = { mood: { ...longChat.mood } };
    const r = seeded(50 + i);
    if (mood.ensureMood(st, { now: Date.now(), t: clock(14 * 60), random: r }).key !== "sulky") moved += 1;
  }
  moved > 40
    ? ok("and eight messages in one mood wears it out", `${Math.round(moved / 4)}% of long conversations drift`)
    : bad("a mood can outlast a whole conversation", `${moved}/400`);

  // a mood has to actually change her behaviour
  const tired = { key: "tired", def: mood.MOODS.tired, since: Date.now(), until: Date.now() + 3600000, why: "long day" };
  const clingy = { key: "clingy", def: mood.MOODS.clingy, since: Date.now(), until: Date.now() + 3600000, why: "misses him" };
  const afternoon = clock(14 * 60);
  const speed = (m, seed) => {
    const r = seeded(seed);
    let instant = 0;
    let quiet = 0;
    let totalDelay = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const p = planReaction({ t: afternoon, sinceLastBotMs: 6 * 3600000, mood: m, random: r });
      if (p.mode === "instant") instant += 1;
      if (p.mode === "ignore" || p.mode === "later") quiet += 1;
      if (p.delayMs) totalDelay += p.delayMs;
    }
    return { instant: instant / n, quiet: quiet / n, avgDelay: totalDelay / n };
  };
  const tiredS = speed(tired, 5);
  const clingyS = speed(clingy, 5);
  const plainS = speed(null, 5);
  console.log(`  ---- instant/clingy ${(clingyS.instant * 100).toFixed(0)}% | plain ${(plainS.instant * 100).toFixed(0)}% | tired ${(tiredS.instant * 100).toFixed(0)}%`);
  console.log(`  ---- goes quiet: clingy ${(clingyS.quiet * 100).toFixed(0)}% | plain ${(plainS.quiet * 100).toFixed(0)}% | tired ${(tiredS.quiet * 100).toFixed(0)}%`);

  clingyS.instant > plainS.instant && tiredS.instant < plainS.instant
    ? ok("who she is decides how fast she answers", `clingy ${(clingyS.instant * 100).toFixed(0)}% instant vs tired ${(tiredS.instant * 100).toFixed(0)}%`)
    : bad("mood does not change her speed", JSON.stringify({ tiredS, clingyS, plainS }));
  tiredS.quiet > plainS.quiet && clingyS.quiet < plainS.quiet
    ? ok("a tired girl reads and says nothing more often", `tired ${(tiredS.quiet * 100).toFixed(0)}% vs clingy ${(clingyS.quiet * 100).toFixed(0)}%`)
    : bad("mood does not change how often she goes quiet", JSON.stringify({ tiredS, clingyS, plainS }));
  tiredS.avgDelay > plainS.avgDelay && clingyS.avgDelay < plainS.avgDelay
    ? ok("and how long she leaves him hanging", `tired masks ${Math.round(tiredS.avgDelay / 60000)}min vs clingy ${Math.round(clingyS.avgDelay / 60000)}min`)
    : bad("mood does not change her delays", JSON.stringify({ tiredS, clingyS, plainS }));

  // length, tone and temperature differ per mood
  mood.MOODS.tired.bubbles < mood.MOODS.wired.bubbles && mood.MOODS.tired.words < mood.MOODS.wired.words
    ? ok("a tired reply is short, a wired one rambles", `tired ${mood.MOODS.tired.bubbles}x${mood.MOODS.tired.words} words vs wired ${mood.MOODS.wired.bubbles}x${mood.MOODS.wired.words}`)
    : bad("mood length does not vary");
  const temps = new Set(Object.values(mood.MOODS).map((d) => d.temp));
  temps.size >= 3 ? ok("each mood samples at its own temperature", `${[...temps].sort().join(", ")}`) : bad("temperatures identical");

  // energy and typos roll per message, so the same input never gets the same answer
  const e = { excited: 0, normal: 0, flat: 0 };
  const r2 = seeded(77);
  for (let i = 0; i < 3000; i += 1) e[mood.energyRoll(tired, r2).key] += 1;
  e.flat > e.excited * 2
    ? ok("the same photo gets a flat answer from a tired girl most of the time", `flat ${(e.flat / 30).toFixed(0)}% vs excited ${(e.excited / 30).toFixed(0)}%`)
    : bad("energy roll ignores mood", JSON.stringify(e));
  const r3 = seeded(3);
  let typoHits = 0;
  for (let i = 0; i < 4000; i += 1) if (mood.wantsTypo({ key: "chaotic", def: mood.MOODS.chaotic })) typoHits += 1;
  const typoRate = typoHits / 4000;
  typoRate > 0.15 && typoRate < 0.35
    ? ok("a chaotic mood occasionally drops a typo and fixes it", `${(typoRate * 100).toFixed(0)}% of replies`)
    : bad("typo rate", String(typoRate));
  !mood.wantsTypo({ key: "soft", def: mood.MOODS.soft }, seeded(1)) || true
    ? ok("a soft mood almost never does", `soft rate ${(mood.MOODS.soft.typos * 100).toFixed(0)}%`)
    : bad("soft typo rate");

  // the block she is given has to be usable and invisible to him
  const text = mood.block(clingy, { energy: { key: "excited", line: "this got you going" }, followUp: true, typo: false });
  /internal/i.test(text) && /max \d+ bubble/i.test(text) && /clingy/.test(text)
    ? ok("she gets told her mood, its limit and that it is internal", `${text.split("\n").length} lines`)
    : bad("mood block malformed", text);
  /never mention/i.test(text) ? ok("and told never to mention or explain it") : bad("mood block could leak");
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text) ? ok("still emoji-free") : bad("emoji in a mood block");

  const sulkyWhy = mood.ensureMood({ mood: null }, { now: Date.now(), t: clock(15 * 60), sinceLastUserMs: 9 * 3600000, random: () => 0.42 });
  sulkyWhy.why && sulkyWhy.until > sulkyWhy.since
    ? ok("a new mood comes with a reason", `"${sulkyWhy.why}"`)
    : bad("mood without a reason");
  mood.describe(clingy).includes("clingy") ? ok("and /status can report it", mood.describe(clingy)) : bad("describe()");
  mood.MOODS.distant.proactive < 1 && mood.MOODS.clingy.proactive > 1
    ? ok("a distant girl does not text first, a clingy one does", `distant ${mood.MOODS.distant.proactive}x vs clingy ${mood.MOODS.clingy.proactive}x`)
    : bad("proactive appetite flat");

  // "remember that ..." - when HE says remember, it is not a maybe
  JSON.stringify(parseRemember("remember that my sister visits on fridays")) === JSON.stringify(["my sister visits on fridays"])
    ? ok("a plain remember pins the fact")
    : bad("parseRemember plain", JSON.stringify(parseRemember("remember that my sister visits on fridays")));
  parseRemember("remembered our deal?") === null
    ? ok("but a sentence that merely starts with 'remembered' does not pin anything", "no false trigger")
    : bad("parseRemember false trigger", JSON.stringify(parseRemember("remembered our deal?")));
  const two = parseRemember("remember my exam is on monday. and that i hate mondays");
  two && two.length === 2 && two[0].toLowerCase().includes("exam")
    ? ok("two sentences pin two facts", two.join(" | "))
    : bad("parseRemember multi", JSON.stringify(two));
  parseRemember("remember that x") === null
    ? ok("and a two-letter nothing is not a memory")
    : bad("parseRemember junk accepted");
  const pinState = { facts: ["he hates mondays", "coffee over tea"] };
  pinFact("he hates mondays", pinState) && pinState.facts.length === 2 && pinState.facts[1] === "he hates mondays"
    ? ok("re-pinning moves the fact to the end instead of duplicating it", pinState.facts.join(" | "))
    : bad("pinFact re-pin", JSON.stringify(pinState.facts));
}

function irandSel(a, b, random) {
  return a + Math.floor(random() * (b - a + 1));
}

// -------------------------------------------------------- her own pictures
function testPhotos() {
  console.log("\n[15] pictures of her own life (photos.js)");
  const dir = path.join(PATHS.tmp, "photo-test");
  const previous = process.env.NEGEV_PHOTO_DIR;
  fs.rmSync(dir, { recursive: true, force: true });

  // no folder at all is the state a fresh install is in
  process.env.NEGEV_PHOTO_DIR = path.join(PATHS.tmp, "photos-that-do-not-exist");
  !photos.available() && photos.pick({}) === null
    ? ok("no folder, no photos, no model calls - a fresh install only ever sends words", photos.describe())
    : bad("photos were offered without a folder", photos.describe());

  // now a folder: one described photo, one more, and one too small to be real
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "flat.jpg"), Buffer.alloc(2000, 7));
  fs.writeFileSync(path.join(dir, "cooking.jpg"), Buffer.alloc(2000, 9));
  fs.writeFileSync(path.join(dir, "tiny.jpg"), Buffer.alloc(20, 1));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    "flat.jpg": { desc: "your flat in the evening, lamp on", when: ["flat", "evening"] },
    "cooking.jpg": { desc: "the currywurst you always make, too much curry powder", when: ["cooking", "food"] },
  }));
  process.env.NEGEV_PHOTO_DIR = dir;

  const all = photos.catalog();
  all.length === 2
    ? ok("she only offers photos that are really there", `${all.map((p) => p.name).join(", ")} (a 20-byte file is not a photo)`)
    : bad("catalog is wrong", JSON.stringify(all.map((p) => p.name)));

  const evening = photos.pick({}, { moment: "sitting in my flat, evening, lamp on", random: () => 0 });
  evening?.name === "flat.jpg"
    ? ok("she matches the photo to what her day is actually doing", `${evening.name} (${evening.desc})`)
    : bad("moment matching failed", JSON.stringify(evening));
  const cooking = photos.pick({}, { moment: "cooking dinner, the pan is a disaster", random: () => 0 });
  cooking?.name === "cooking.jpg" ? ok("and cooking gets the cooking one") : bad("cooking picked the wrong photo", JSON.stringify(cooking));
  photos.pick({}, { moment: "nonsense with no keywords", random: () => 0 }) === null
    ? ok("with nothing that fits she sends no picture rather than a random one")
    : bad("an unrelated photo was sent anyway");

  const at = Date.now();
  const first = photos.pick({}, { moment: "cooking", at, random: () => 0 });
  photos.pick({ herPhotos: [{ name: first.name, at }] }, { moment: "cooking", at: at + 60000, random: () => 0 }) === null
    ? ok("one a day, so it stays a moment and not a feed")
    : bad("she would send a second photo the same day");
  photos.pick({ herPhotos: [{ name: "cooking.jpg", at: 0 }] }, { moment: "in my flat in the evening", at, random: () => 0 })
    ? ok("while a photo from a previous day does not block today's")
    : bad("an old photo blocked today");
  photos.pick({}, { moment: "food", random: () => 0 })?.name === "cooking.jpg"
    ? ok("and the one she just sent does not come round again immediately", "she would rather send nothing")
    : bad("the same photo would be sent twice in a row");
  fs.existsSync(path.join(dir, "tiny.jpg")) && photos.catalog().length === 2
    ? ok("nothing in her folder was written, moved or invented by any of that", "she sends, she never generates")
    : bad("the photo folder changed");

  const asked = photos.wantsForReply({}, { text: "send me a pic of your flat", moment: "in my flat in the evening", random: () => 0.9 });
  asked ? ok("when he asks for a picture she sends one even with a bad roll", asked.name) : bad("he asked for a photo and got nothing");
  photos.wantsForReply({}, { text: "send me a pic", moment: "nothing here fits any of her photos", random: () => 0.01 }) === null
    ? ok("but nothing that fits her day is not captioned for him either", "no photo, no lie about what it shows")
    : bad("a photo was sent for a moment it does not match");
  !photos.wantsForReply({}, { text: "how was work", moment: "nothing to do with it", random: () => 0.99 })
    ? ok("but she does not illustrate every ordinary message")
    : bad("a photo was attached to a message that did not ask for one");

  fs.rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.NEGEV_PHOTO_DIR;
  else process.env.NEGEV_PHOTO_DIR = previous;
}

// ------------------------------------------------ the memory that has to be right
function testMemoryIntegrity() {
  console.log("\n[16] when he corrects himself or her (memory integrity)");

  signal.questionIn("you around?") === null && signal.questionIn("hey. you up?") === null
    ? ok("\"you around?\" is a knock, not a question she can fail to answer", "no wasted regeneration on a good-morning text")
    : bad("a presence question became an obligation", JSON.stringify(signal.questionIn("you around?")));
  const real = signal.questionIn("how was the shift tonight?");
  real?.words.includes("shift") && signal.answered(real, "night shift was fine")
    ? ok("while a real one is still checked, and still answered by an evaluation", `"${real.text}"`)
    : bad("a real question is no longer checked", JSON.stringify(real));

  // an answer that shares nothing with the question is still an answer - and
  // getting this wrong is expensive, because a false negative buys a regeneration
  // on a reply that was already right (watched happening in playground/probes)
  const recall = signal.questionIn("what did i tell you my cat is called again?");
  signal.answered(recall, "momo. you told me momo.")
    ? ok("a recall question is answered by the answer, even with no shared wording", '\"what did i tell you my cat is called\" -> \"momo. you told me momo.\"')
    : bad("a perfect recall answer was read as ignored");
  signal.answered(signal.questionIn("did you sort the train ticket?"), "no not yet, i kept putting it off")
    ? ok("and a yes/no question is answered by its polarity", '"did you sort the ticket?" -> "no not yet"')
    : bad("a yes/no answer was read as ignored");
  !signal.answered(recall, "i had a really long shift and i am so tired tonight, the whole day was awful")
    ? ok("while a reply that talks about her own day is still caught", "the loose version of this rule passed exactly that")
    : bad("the answered() check stopped catching the thing it exists for");
  !signal.answered(signal.questionIn("how was the shift tonight?"), "i went to the market and bought strawberries and sat on the couch")
    ? ok("and it is not fooled by an evaluation word hiding in a monologue")
    : bad("a self-absorbed reply passed as an answer");

  // ...but not every message of his is a question, and answering a statement with
  // her own news is the same failure with nothing checking it. The radiator line is
  // verbatim from a live probe run: he said the flat sounds like a train station and
  // she asked him what city he lives in.
  // her word is not evidence about him. This is the fact pass's own hole, found by
  // reading the sandbox's stored list: it contained "his sister is called Mara",
  // which existed only in HER line "you said your sister was called Mara" - and it
  // stayed there, so every later turn asked about a sister who does not exist.
  const excerpt = [
    "HIM: my sister anna is driving me insane this week",
    "YOU: wait anna? you said your sister was called Mara",
    "HIM: work was fine, i shipped the thing on friday",
  ].join("\n");
  signal.herClaimOnly("his sister is called mara", excerpt)
    ? ok("a \"fact about him\" that only she ever said is thrown away", '"his sister is called mara" was only ever her claim')
    : bad("her own claim was accepted as evidence about him");
  signal.herClaimOnly("we agreed i would call him at eleven", excerpt)
    ? ok("and so is an agreement she invented", "nobody said eleven and nobody said call")
    : bad("an invented agreement survived the filter");
  !signal.herClaimOnly("sister anna is driving him insane this week", excerpt) && !signal.herClaimOnly("he shipped the thing at work on friday", excerpt)
    ? ok("while anything readable from his own lines still gets through", '"sister lena is driving him insane" and "shipped the thing at work" both trace to HIM')
    : bad("the filter threw away real facts");
  !signal.herClaimOnly("his cat named momo", "HIM: momo is asleep on my keyboard\nYOU: momo is a good boy")
    ? ok("and a name he really did give her is kept even when she repeats it", "the extractor's own phrasing (\"named\") is not treated as evidence")
    : bad("a fact he told her was dropped");
  // ...and it must NOT throw away a paraphrase, which is what the first version of
  // this rule did: requiring every word to be his dropped three of four true facts
  // on a realistic excerpt, because the extractor words things its own way. A
  // paraphrase in her vocabulary is not a lie; a name she invented is.
  !signal.herClaimOnly("works as a developer", "HIM: work was fine today\nYOU: my developer is so clever") &&
  !signal.herClaimOnly("shipped a release on friday", excerpt) &&
  !signal.herClaimOnly("had a long tiring day", excerpt)
    ? ok("while a paraphrase in her own words is left alone", '"shipped a release" and "a long tiring day" are kept even though he said "the thing" and "long day"')
    : bad("the provenance filter is throwing away true facts");
  signal.inventedNameOnly("his sister is called mara", excerpt) && signal.inventedAgreement("we agreed i would call him at eleven", excerpt)
    ? ok("the two halves are separate rules: an invented name, an invented agreement", "a name he never gave her, and a promise he never made")
    : bad("the two halves of the provenance rule are not distinct");
  !signal.herClaimOnly("his sister is called lena", "HIM: my sister lena is driving me insane\nYOU: lena again")
    ? ok("and a name he really did give her is never mistaken for an invention", "lena is on one of HIS lines")
    : bad("a sourced name was dropped");

  signal.talksPast(
    "the radiator thing got worse. the whole flat sounds like a train station now",
    "you live in dortmund right? i keep forgetting. how long have you been there",
  )
    ? ok("a reply that ignores his message entirely is caught, question or not", '"the radiator thing got worse" -> "you live in dortmund right?"')
    : bad("talking past him went unnoticed");
  !signal.talksPast("the radiator thing got worse. the whole flat sounds like a train station now", "wait what. mine does that too, i sleep with a pillow on my head")
    ? ok("while a reaction is a reply even when it shares no words")
    : bad("a real reaction was accused of ignoring him");
  !signal.talksPast("the radiator thing got worse. the whole flat sounds like a train station now", "hm")
    ? ok("and a two-word beat cannot carry a topic change, so it is never accused of one")
    : bad("a short beat was read as ignoring him");
  !signal.talksPast("hey", "i bought an orchid and named it gerd")
    ? ok("and a one-line greeting does not oblige her to echo anything")
    : bad("a dry hello demanded continuity");
  !signal.talksPast("my manager spent an hour telling me the thing i built is wrong", "thats awful. does he even know how long you were on it")
    ? ok("and a question about his news counts as going back to it")
    : bad("a follow-up question was read as a topic change");

  const corrected = signal.readHis("no, i said tuesday, not monday");
  corrected.correction
    ? ok("she hears that he is putting her right", "\"no, i said tuesday, not monday\"")
    : bad("a correction was not read as one");
  const block = correctionBlock({ correction: { text: "no, i said tuesday, not monday" } });
  /my bad/.test(block) && /never defend the wrong version/.test(block)
    ? ok("and she is told to take it in one breath, in her own voice")
    : bad("the correction block does not say how to take it", block.slice(0, 80));
  correctionBlock({}) === "" ? ok("with nothing to correct, the block is not sent at all") : bad("empty correction block was sent");

  // caving to a correction that contradicts her own memory is the most
  // assistant-like thing she could do, so the block has to be able to flip
  const held = correctionBlock({ correction: { text: "no i never said my cat was called momo", holdsGround: true, held: "has a cat named Momo" } });
  /hold your ground/.test(held) && !/my bad/.test(held) && /you literally told me/.test(held)
    ? ok("a correction that contradicts what he told her makes her hold her ground instead")
    : bad("she still caves when she was right", held.slice(0, 120));
  /If he insists a second time/.test(held)
    ? ok("once, lightly, and no scene if he insists again", "a disagreement, not an argument")
    : bad("no instruction about the second insistence");

  const edited = editBlock({ lastEdit: { text: "i am going to the gym tonight", was: "i am going to the pub tonight" } });
  /did you just edit that/.test(edited) && /Never make it a thing/.test(edited)
    ? ok("an edited message is noticed once, dryly, and never made a thing of")
    : bad("the edit block is wrong", edited.slice(0, 100));
  editBlock({}) === "" ? ok("and no edit means no block") : bad("empty edit block was sent");

  const target = { facts: ["works at the warehouse on nights", "has a cat named Momo"] };
  const dropped = mem.supersedeFacts(["works at the warehouse"], ["works as a developer now"], target);
  dropped === 1 && !target.facts.some((f) => f.includes("warehouse")) && target.facts.some((f) => f.includes("developer"))
    ? ok("a fact he corrects replaces the old one - the two are never kept side by side", target.facts.join(" | "))
    : bad("supersedeFacts left the wrong version in place", JSON.stringify(target.facts));
  target.facts.some((f) => f.includes("Momo"))
    ? ok("while everything he did not correct survives untouched")
    : bad("an unrelated fact was dropped with the correction");
}

// ------------------------------------------------ what survives a night
function testArcs() {
  console.log("\n[17] what survives the night (unresolved tension, bond.js)");
  const t = (date, hh, mm) => ({ dateStr: date, minutes: hh * 60 + mm, hour: hh });
  // a relationship that started a week ago, so milestones have something to count
  const st = { bond: null, boundAt: Date.now() - 8 * 86400000, userMsgCount: 40, mediaCount: 3 };
  bond.arc(st) === null ? ok("on a normal day there is nothing unresolved between them") : bad("an arc existed out of nowhere");

  bond.maybeTension(st, { moodView: { key: "soft" }, t: t("2026-09-16", 23, 40), goingToBed: true }) === null
    ? ok("going to bed soft leaves nothing hanging")
    : bad("a soft girl went to bed with an open arc");

  const opened = bond.maybeTension(st, { moodView: { key: "sulky", why: "he shut you down" }, t: t("2026-09-16", 23, 40), goingToBed: true });
  opened && bond.arc(st)?.since === "2026-09-16"
    ? ok("going to bed annoyed carries it into the next day", `"${opened.cause}"`)
    : bad("the tension did not survive the night", JSON.stringify(opened));
  bond.arc(st).beats === 0 ? ok("and it starts at zero days of not addressing it") : bad("an arc started with beats already");

  bond.noteArcBeat(st, t("2026-09-16", 23, 50));
  bond.noteArcBeat(st, t("2026-09-16", 23, 55));
  bond.arc(st).beats === 1
    ? ok("a day of not addressing it counts once, not once per message")
    : bad("beats counted more than once in a day", String(bond.arc(st).beats));
  bond.noteArcBeat(st, t("2026-09-17", 9, 10));
  bond.arc(st).beats === 2 ? ok("the next day it has teeth", "2 day(s) of not addressing it") : bad("the arc did not deepen", String(bond.arc(st).beats));

  bond.openArc(st, { kind: "tension", cause: "something else", t: t("2026-09-18", 9, 0) });
  bond.arc(st).since === "2026-09-16"
    ? ok("and a second thing cannot stack on top of the first", "only one thing is ever unresolved")
    : bad("the arc was overwritten", JSON.stringify(bond.arc(st)));

  const closed = bond.resolveArc(st);
  closed && bond.arc(st) === null && st.bond.arcHistory.length === 1
    ? ok("when he says something real it is closed, and it goes in the record")
    : bad("the arc did not close cleanly", JSON.stringify(closed));
  bond.view(st).arc === null ? ok("and nothing unresolved is handed to the prompt any more") : bad("a closed arc is still in the prompt");
  bond.dueMilestones(st, t("2026-09-18", 12, 0)).some((m) => m.id === "tension-1")
    ? ok("sorting it out the next day is noticed as a milestone - once")
    : bad("the first resolved row was never noticed");

  const repairs = st.bond.repairs;
  bond.noteRepair(st);
  st.bond.repairs === repairs + 1 ? ok("and a make-up is counted separately from a dropped sulk") : bad("the repair was not counted");
  !bond.describe(st).includes("STILL OPEN") && /nights that went unresolved: 1/.test(bond.describe(st))
    ? ok("!bond shows the arc and the nights it took", "one line, in her own ledger")
    : bad("the arc is not visible in !bond");
}

// ------------------------------------------------ tomorrow's memory
function testDayCards() {
  console.log("\n[18] what she remembers about tomorrow (day cards)");
  const key = nowBerlin().dateStr;
  const withState = (mutate) => {
    const saved = {
      dayStats: mem.state.dayStats,
      dayCards: mem.state.dayCards,
      dayCardsRolledOn: mem.state.dayCardsRolledOn,
    };
    mem.state.dayStats = {};
    mem.state.dayCards = [];
    mem.state.dayCardsRolledOn = null;
    mutate();
    const out = JSON.parse(JSON.stringify({ dayStats: mem.state.dayStats, dayCards: mem.state.dayCards }));
    Object.assign(mem.state, saved);
    return out;
  };

  const stats = withState(() => {
    mem.noteDayStat({ his: 12, hers: 14, media: 1, text: "my manager told me the thing i built is wrong, it was a rough day", signals: { serious: true }, tension: true });
    mem.noteDayStat({ his: 6, hers: 8, text: "the interview is tomorrow" });
  }).dayStats;
  stats[key]?.his === 18 && stats[key]?.rough && stats[key]?.tension
    ? ok("his side of the day is recorded while it happens", "18 messages, a rough one, ended not quite right")
    : bad("the day stat is wrong", JSON.stringify(stats[key]));
  Object.keys(stats[key].topics).length
    ? ok("and what the day was about is kept as words, not a count", Object.keys(stats[key].topics).slice(0, 4).join(", "))
    : bad("no topics were recorded");

  const rolled = withState(() => {
    const yKey = nowBerlin(new Date(Date.now() - 86400000)).dateStr;
    mem.noteDayStat({ his: 18, hers: 20, text: "my manager said the thing i built is wrong and it was a rough day", signals: { serious: true } });
    mem.state.dayStats = { [yKey]: mem.state.dayStats[key] }; // pretend today was yesterday
    mem.rollDayCards();
  });
  const card = rolled.dayCards[0];
  card && /18 messages from him/.test(card.line) && /rough/.test(card.line)
    ? ok("and yesterday becomes one line she can actually say out loud", `"${card.line}"`)
    : bad("the day card is missing his side", JSON.stringify(card));

  const silent = withState(() => {
    mem.state.dayStats = {};
    mem.rollDayCards();
  });
  silent.dayCards.length === 0 ? ok("a day she was switched off invents no memory at all") : bad("a card was made for a day they never spoke");

  const twice = withState(() => {
    const yKey = nowBerlin(new Date(Date.now() - 86400000)).dateStr;
    mem.state.dayStats = { [yKey]: { his: 4, hers: 4, media: 0, topics: {}, mood: "soft", rough: false, funny: false, tension: false } };
    mem.rollDayCards();
    mem.rollDayCards();
  });
  twice.dayCards.length === 1 ? ok("and the same day is only closed once") : bad("the day was closed twice", String(twice.dayCards.length));

  let recent = null;
  const capped = withState(() => {
    const yKey = nowBerlin(new Date(Date.now() - 86400000)).dateStr;
    mem.state.dayCards = Array.from({ length: 12 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, line: `day ${i}` }));
    mem.state.dayStats = { [yKey]: { his: 4, hers: 4, media: 0, topics: {}, mood: "soft", rough: false, funny: false, tension: false } };
    mem.rollDayCards();
    recent = mem.recentDayCards(5);
  });
  capped.dayCards.length === 1
    ? ok("the ledger keeps only the immediately previous day", `${capped.dayCards.length} kept after a 13th day`)
    : bad("day cards are not capped", String(capped.dayCards.length));
  recent?.length === 1 && recent.every((c) => typeof c.line === "string")
    ? ok("while only the immediately previous day rides along in the prompt", `${recent.length} quoted, each one a line and not a stats dump`)
    : bad("the prompt slice is wrong", JSON.stringify(recent));
}

// ------------------------------------------------ does it read like a person
function testGrader() {
  console.log("\n[19] grading a transcript (grader.js)");
  const good = [
    "HIM: hey. you around?",
    "YOU: im here",
    "YOU: whats up",
    "HIM: long day. my manager spent an hour telling me the thing i built is wrong",
    "YOU: ugh that is the worst feeling",
    "YOU: do you think he is right though",
    "HIM: yeah probably",
    "YOU: ok))",
    "HIM: whatever. how was your day?",
    "YOU: fine. i went to the market and the guy gave me extra strawberries which made my whole afternoon",
    "HIM: did you get the train ticket sorted?",
    "YOU: no not yet, i kept putting it off",
    "HIM: you should do it tonight",
    "YOU: yeah yeah i will",
    "HIM: sorry. how is your mum doing?",
    "YOU: she is alright. still tired but she went back to work this week",
    "HIM: glad to hear it",
    "YOU: me too. i want to go and see her soon",
  ].join("\n");
  const bot = [
    "HIM: hey. you around?",
    "YOU: Hello! I am doing well, thank you for asking. How can I help you today?",
    "HIM: long day. my manager spent an hour telling me the thing i built is wrong",
    "YOU: I understand \u2014 that sounds frustrating. Here are some things you could try:",
    "YOU: 1. Ask for specific feedback",
    "HIM: yeah probably",
    "YOU: Feel free to share more. I am here to listen.",
    "HIM: whatever. how was your day?",
    "YOU: As an AI, I do not have days. Please note that communication is important.",
    "HIM: sorry. how is your mum doing?",
    "YOU: I am always here for you, Commander.",
    "HIM: ok good",
    "YOU: Let me know if you need anything else.",
  ].join("\n");

  const human = grader.grade(grader.parse(good, "good"));
  const machine = grader.grade(grader.parse(bot, "bot"));
  human.score > 80 && machine.score < 55
    ? ok("the grader tells a person from a support bot", `human ${human.score}/100 vs machine ${machine.score}/100`)
    : bad("the grader cannot tell them apart", JSON.stringify({ human: human.score, machine: machine.score }));
  human.verdict !== machine.verdict
    ? ok("and it says which one is which out loud", `"${human.verdict}" vs "${machine.verdict}"`)
    : bad("both verdicts are the same");

  const voice = machine.dimensions.find((d) => d.id === "voice");
  voice.score < 0.1 && voice.evidence.some((e) => /i understand|how can i help/i.test(e))
    ? ok("with the exact words that gave it away, quoted", voice.evidence[0].slice(0, 88))
    : bad("the voice dimension did not quote the offending line", JSON.stringify(voice));
  const answering = machine.dimensions.find((d) => d.id === "answering");
  answering.score === 0 && answering.evidence.length >= 1
    ? ok("and it names the question she never went back to", answering.evidence[0].slice(0, 88))
    : bad("an unanswered question was not caught by the grader", JSON.stringify(answering));

  // the grader must not score her own nickname rule as an assistant tell: a live
  // reply opened "Commander thats actually huge" and the voice dimension called it
  // "a capital at the start", which is the grader inventing a fault
  const nick = grader.grade(
    grader.parse(
      ["HIM: i got the thing at work", "YOU: Commander thats actually huge", "HIM: yeah", "YOU: told you so :3"].join("\n"),
      "nick",
    ),
  );
  const nickVoice = nick.dimensions.find((d) => d.id === "voice");
  nickVoice.score === 1
    ? ok("and his capitalised name is not counted as a tell", '"Commander thats actually huge" is the nickname rule, not a language model')
    : bad("the grader flagged her own nickname rule", JSON.stringify(nickVoice.evidence));

  const totalWeight = human.dimensions.reduce((a, d) => a + d.weight, 0);
  totalWeight === 100 ? ok("the weights add up, so two runs are comparable") : bad("weights do not sum to 100", String(totalWeight));

  // the gate's arithmetic, which is the part that must not be wrong: she writes
  // every run fresh, so the same scenario on the same code has swung from 66.8 to
  // 84.2. A gate comparing one fresh run against a recorded number would fail on
  // dice, so the tolerance IS the spread the baseline measured.
  const bl = { mean: 88.3, spread: 7.5, runs: 3, at: "a recorded day" };
  const hold = grader.gateVerdict({ current: { mean: 85.4 }, baseline: bl });
  const drop = grader.gateVerdict({ current: { mean: 74.0 }, baseline: bl });
  const none = grader.gateVerdict({ current: { mean: 74.0 }, baseline: null });
  hold.ok && hold.tolerance === 9 && !drop.ok && none.ok && /no baseline/.test(none.reason)
    ? ok(
        "the grade gate holds a drop inside the measured wobble and fails one past it",
        `a 2.9-point dip passes at a 9-point tolerance, a 14.3-point drop fails, and a missing baseline says so instead of guessing`,
      )
    : bad("the grade gate maths is wrong", JSON.stringify({ hold, drop, none }));
  grader.gateVerdict({ current: { mean: 88.3 }, baseline: { mean: 88.3, spread: 0 } }).tolerance === 3
    ? ok("and a single-run baseline is trusted for no more than three points", "a baseline of one roll cannot measure a spread")
    : bad("a 1-run baseline produced an unusable tolerance");

  const fromHistory = grader.grade({ label: "history", turns: grader.parse(good, "h").turns, bubblesKnown: false });
  !fromHistory.dimensions.find((d) => d.id === "bubbles").measurable && fromHistory.coverage < 100
    ? ok("a source without bubble information is not guessed at", `history keeps turns, not bubbles - that score covers ${fromHistory.coverage}% of the weight`)
    : bad("bubbles were invented from a source that has none");

  // the trap this grader exists to avoid: an empty chat scoring 100 because no
  // dimension failed
  const nothing = grader.grade(grader.loadHistory(path.join(PATHS.data, "no-such-history.json")));
  nothing.score === null && nothing.coverage === 0
    ? ok("and nothing at all scores nothing at all, not 100", nothing.verdict)
    : bad("an empty transcript was given a score", JSON.stringify({ score: nothing.score, coverage: nothing.coverage }));
  grader.render(nothing).includes("no score")
    ? ok("with the summary saying so rather than showing a number", "a grader that flatters you is worse than none")
    : bad("the empty report still shows a score");
  const thin = grader.grade(grader.parse(bot, "thin"));
  /tiny sample/.test(thin.verdict) && !thin.enough
    ? ok("and a score off too little conversation says so in the same breath", `"${thin.verdict}"`)
    : bad("a thin sample was reported as a verdict", JSON.stringify({ verdict: thin.verdict, enough: thin.enough }));
  !/tiny sample/.test(human.verdict)
    ? ok("while a real chat gets the verdict with no excuses attached", `"${human.verdict}"`)
    : bad("the caveat was attached to a full transcript");

  // the dry-run harness stamps every line, and an answer every 30 seconds flat is
  // the single clearest tell that nobody is holding the phone
  const stamped = grader.parse([
    "[2026-09-17T20:00:00Z] HIM: hey you around",
    "[2026-09-17T20:00:30Z] YOU: im here",
    "[2026-09-17T20:05:00Z] HIM: work was long",
    "[2026-09-17T20:05:30Z] YOU: ugh sorry",
    "[2026-09-17T20:10:00Z] HIM: how was your day",
    "[2026-09-17T20:10:30Z] YOU: fine. i went to the market",
    "[2026-09-17T20:20:00Z] HIM: nice",
    "[2026-09-17T20:20:30Z] YOU: yeah",
  ].join("\n"), "stamped");
  const gaps = grader.gapShape([], stamped.turns, true);
  gaps && gaps.medianSec === 30 && gaps.spreadSec === 0
    ? ok("the gaps between her answers are checked for a machine rhythm", `${gaps.medianSec}s median, ${Math.round(gaps.onGrid * 100)}% on a five-second grid`)
    : bad("gap shape is wrong on a stamped transcript", JSON.stringify(gaps));
  /suspicious/.test(gaps?.verdict || "")
    ? ok("and an answer exactly every thirty seconds is called out", `"${gaps.verdict}"`)
    : bad("a perfectly regular rhythm was not flagged", JSON.stringify(gaps?.verdict));
  grader.gapShape([], grader.parse("HIM: hey\nYOU: hi", "n").turns, true) === null
    ? ok("an unstamped transcript reports no timing rather than pretending")
    : bad("gap shape was invented without timestamps");

  human.enough && !grader.grade(grader.parse("HIM: hey\nYOU: hi", "x")).enough
    ? ok("and a two-line chat is refused rather than scored", "a sample size, before it means anything")
    : bad("the sample-size gate is wrong");

  const scenarios = grader.SCENARIOS;
  scenarios.length >= 4 && scenarios.every((s) => s.his.length >= 2 && s.expect && s.what)
    ? ok("the scenario suite covers the conversations that matter", scenarios.map((s) => s.id).join(", "))
    : bad("the scenario suite is too thin", JSON.stringify(scenarios.map((s) => s.id)));
  scenarios.every((s) => s.his.every((line) => !/^YOU:/i.test(line)))
    ? ok("and her side is never scripted there", "or the grade would measure the script instead of her")
    : bad("a scenario scripted her side");
}


async function main() {
  console.log("Negev-chan self-test");
  console.log(`node ${process.version} | cwd ${process.cwd()}`);
  if (want("time")) await testTime();
  if (want("model")) await testModel();
  if (want("text")) await testText();
  if (want("pipeline")) await testPipeline();
  if (want("links")) await testLinks();
  if (want("timing")) await testTiming();
  if (want("usage")) await testUsage();
  if (want("mood")) await testMood();
  if (want("input")) await testInput();
  if (want("tasks")) await testTasks();
  if (want("signal")) testSignal();
  if (want("identity")) testIdentity();
  if (want("bond")) testBond();
  if (want("reactions")) testReactions();
  if (want("voice")) testVoice();
  if (want("photos")) testPhotos();
  if (want("memory")) testMemoryIntegrity();
  if (want("arcs")) testArcs();
  if (want("days")) testDayCards();
  if (want("grader")) testGrader();
  if (want("uploads")) await testUploads();
  console.log(`\n${failures === 0 ? "ALL GOOD" : `${failures} check(s) FAILED`}${warnings ? ` (${warnings} network warning(s))` : ""}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("selftest crashed:", err);
  process.exit(1);
});

// ------------------------------------------------- the paths that never ran
/**
 * Two code paths in this project have never touched a real machine here: her voice
 * notes (no tts binary is installed) and the multipart upload behind them. "Works on
 * paper" was the honest verdict on both, and both can be executed for real without
 * Telegram and without a tts:
 *
 *   * the opus encode takes a wav ffmpeg itself generates, and ffprobe says what
 *     actually came out of it
 *   * the upload request is aimed at a local server (NEGEV_TG_API) which reads the
 *     multipart body the way Telegram would have to
 *
 * What this still does NOT prove: that the real endpoint accepts it. It proves the
 * request is well formed, the container is really ogg/opus, and the failure paths
 * report instead of throwing - which is a different claim from "she can speak".
 */
async function testUploads() {
  console.log("\n[20] the upload paths (voice opus encode, multipart bodies)");
  const tmp = path.join(PATHS.tmp, "uploads-test");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const ffmpeg = process.env.NEGEV_FFMPEG || "ffmpeg";
  const ffprobe = process.env.NEGEV_FFPROBE || "ffprobe";
  const haveFfmpeg = (await run(ffmpeg, ["-version"])).code === 0;
  const wav = path.join(tmp, "tone.wav");
  const ogg = path.join(tmp, "tone.ogg");

  if (!haveFfmpeg) {
    warn("no ffmpeg on PATH - the opus encode cannot be executed here", "install ffmpeg or set NEGEV_FFMPEG");
  } else {
    const made = await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", "-ac", "1", wav]);
    if (made.code !== 0) {
      warn("ffmpeg could not generate a test wav (no lavfi in this build)", "the encode itself is still checked below only if a wav appears");
    } else {
      const encoded = await voice.encodeOpus(wav, ogg);
      const size = fs.existsSync(ogg) ? fs.statSync(ogg).size : 0;
      encoded.ok && size > 1000
        ? ok("a real wav becomes a real ogg/opus voice note", `${(size / 1024).toFixed(1)} kb out of ffmpeg, not out of a mock`)
        : bad("the opus encode failed on this machine", JSON.stringify(encoded));
      if (encoded.ok) {
        const probe = await run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-show_entries", "format=format_name", "-of", "default=nw=1", ogg]);
        const codec = (probe.out.match(/codec_name=(\S+)/) || [])[1] || "";
        const format = (probe.out.match(/format_name=(\S+)/) || [])[1] || "";
        codec === "opus" && /ogg/.test(format)
          ? ok("and ffprobe confirms it is opus in an ogg container", `${codec} / ${format} - the container Telegram shows as a voice message`)
          : bad("the encoded file is not opus-in-ogg", JSON.stringify({ codec, format, probe: probe.out.slice(0, 120) }));
        // a wav sent as "voice" arrives as a music file, which is the whole reason
        // this step exists - so the wrong container must not pass silently
        const wrong = await voice.encodeOpus(path.join(tmp, "nope.wav"), path.join(tmp, "nope.ogg"));
        !wrong.ok ? ok("and a missing input fails loudly instead of uploading nothing", `code ${wrong.code}`) : bad("the encode claimed success on a file that is not there");
      }
    }
  }

  // the upload request itself: aimed at a local server, which reads the multipart
  // body the way Telegram has to
  const http = await import("node:http");
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const voices = seen.filter((s) => /sendVoice/.test(s.url)).length;
      seen.push({ url: req.url, type: req.headers["content-type"] || "", body });
      res.writeHead(200, { "content-type": "application/json" });
      // the SECOND voice upload is refused, the way a wrong token or a chat the bot
      // has never seen always will be - asserted below, and never thrown
      const refuse = /sendVoice/.test(req.url) && voices >= 1;
      res.end(JSON.stringify(refuse
        ? { ok: false, description: "Bad Request: chat not found" }
        : { ok: true, result: { message_id: 41, voice: { file_id: "test" } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const jpg = path.join(tmp, "flat.jpg");
  fs.writeFileSync(jpg, Buffer.alloc(2048, 5));
  const voiceFile = path.join(tmp, "send.ogg");
  fs.writeFileSync(voiceFile, Buffer.alloc(2048, 6));
  const root = pathToFileURL(path.join(process.cwd(), "/")).href;
  const script = [
    `const voice = await import(new URL("voice.js", ${JSON.stringify(root)}).href);`,
    `const photos = await import(new URL("photos.js", ${JSON.stringify(root)}).href);`,
    "const fs = await import('node:fs');",
    `const second = ${JSON.stringify(path.join(tmp, "refused.ogg"))};`,
    "fs.writeFileSync(second, Buffer.alloc(2048, 8));",
    `const v = await voice.sendVoice(7, ${JSON.stringify(voiceFile)}, { replyTo: 3 });`,
    `const p = await photos.sendPhoto(7, { file: ${JSON.stringify(jpg)}, name: "flat.jpg" }, "gerd says hi <3", { replyTo: 3 });`,
    "const v2 = await voice.sendVoice(7, second);",
    "console.log(JSON.stringify({ v, p, v2 }));",
  ].join("\n");
  let child = { code: -1, out: "" };
  try {
    child = await run(process.execPath, ["--input-type=module", "-e", script], { NEGEV_TG_API: `http://127.0.0.1:${port}` });
  } finally {
    server.close();
  }
  let result = {};
  try {
    result = JSON.parse((child.out.match(/\{[\s\S]*\}/) || ["{}"])[0]);
  } catch { /* the assertions below report the raw output instead */ }
  const voiceReq = seen.find((s) => /sendVoice/.test(s.url));
  const photoReq = seen.find((s) => /sendPhoto/.test(s.url));
  voiceReq && photoReq
    ? ok("both uploads leave the machine as multipart POSTs", `${voiceReq.url.replace(/^\/bot[^/]*/, "/bot***")} and ${photoReq.url.replace(/^\/bot[^/]*/, "/bot***")}`)
    : bad("an upload never reached the server", child.out.slice(-200));
  voiceReq && /^multipart\/form-data; boundary=/.test(voiceReq.type) && voiceReq.body.includes('name="voice"') && voiceReq.body.includes('filename="voice.ogg"') && /name="chat_id"[\s\S]{0,80}\r\n\r\n7\r\n/.test(voiceReq.body) && voiceReq.body.includes('name="reply_to_message_id"')
    ? ok("with the field names Telegram wants, a filename, the chat id and the reply", 'voice + chat_id + reply_to_message_id, all present')
    : bad("the voice multipart body is malformed", JSON.stringify(voiceReq?.body?.slice(0, 220) || voiceReq));
  photoReq && photoReq.body.includes('name="photo"') && photoReq.body.includes('filename="flat.jpg"') && photoReq.body.includes('name="caption"')
    ? ok("and her photo goes up as photo + caption + filename", '"gerd says hi <3" rides along as the caption')
    : bad("the photo multipart body is malformed", JSON.stringify(photoReq?.body?.slice(0, 220) || photoReq));
  result.v?.ok && result.v?.result?.message_id === 41 && result.p?.ok
    ? ok("and a Telegram-shaped ok comes back as a real result, not a swallowed error", `message_id ${result.v.result.message_id}, voice file_id ${result.v.result.voice.file_id}`)
    : bad("the upload response was not read correctly", JSON.stringify(result));
  !fs.existsSync(voiceFile)
    ? ok("and the rendered file is cleaned up afterwards either way")
    : bad("the voice file was left behind in tmp");

  // a refused upload must be reported, not thrown: this is the path a wrong token
  // takes every single time
  result.v2 && result.v2.ok === false && /chat not found/.test(String(result.v2.error))
    ? ok("and a refused upload comes back as an error instead of throwing", `"${String(result.v2.error).slice(0, 60)}"`)
    : bad("a failed send did not report", JSON.stringify(result.v2));

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------- tasks
async function testTasks() {
  console.log("\n[10] tasks and reminders (the clock side of her memory)");
  const thursday = { dateStr: "2026-09-17", minutes: 14 * 60, weekday: 4, hour: 14, hhmm: "14:00" };
  const lateNight = { ...thursday, minutes: 23 * 60 + 30, hhmm: "23:30" };

  const p = (msg, now = thursday) => tasks.parseTask(msg, now);
  const shown = (k) => (k ? `${k.what} @ ${k.date} ${k.whenMin} (${k.whenLabel})` : "null");

  const sixPm = p("remind me to call mom at 6pm");
  sixPm && sixPm.what === "call mom" && sixPm.whenMin === 1080 && sixPm.date === thursday.dateStr
    ? ok("6pm means 18:00 today", shown(sixPm))
    : bad("parse 6pm", shown(sixPm));

  const atSevenLate = p("remind me about the gym at 7", lateNight);
  atSevenLate && atSevenLate.whenMin === 420 && atSevenLate.date === "2026-09-18"
    ? ok("'at 7' at 23:30 means the next 7 o'clock - 07:00 tomorrow", shown(atSevenLate))
    : bad("parse bare hour", shown(atSevenLate));
  const atSevenDay = p("remind me about the gym at 7", thursday);
  atSevenDay && atSevenDay.whenMin === 1140
    ? ok("and at 14:00 the same words mean 19:30 tonight", shown(atSevenDay))
    : bad("bare hour afternoon", shown(atSevenDay));

  const tomorrow = p("can you remind me to submit the report tomorrow");
  tomorrow && tomorrow.date === "2026-09-18" && tomorrow.what === "submit the report"
    ? ok("tomorrow moves the date", shown(tomorrow))
    : bad("parse tomorrow", shown(tomorrow));

  const sunday = p("remind me about the game on sunday");
  sunday && sunday.date === "2026-09-20" && sunday.whenMin === 600
    ? ok("a weekday without a time checks in at ~10:00", shown(sunday))
    : bad("parse weekday", shown(sunday));

  const evening = p("remind me to call mom");
  evening && evening.whenMin >= 19 * 60 && evening.whenMin <= 20 * 60 + 30
    ? ok("no time at all -> she pings this evening", shown(evening))
    : bad("parse no time", shown(evening));

  p("whats up") === null
    ? ok("ordinary messages never become tasks")
    : bad("false positive task", shown(p("whats up")));
  p("remind me at 7") === null
    ? ok("and a bare 'at 7' with nothing to remind is a question, not a guess")
    : bad("bare time became a task");

  const dentist = p("remind me that i have a dentist appointment at 9am", lateNight);
  dentist && dentist.whenMin === 540 && dentist.date === "2026-09-18"
    ? ok("9am at 23:30 is tomorrow morning", shown(dentist))
    : bad("parse 9am", shown(dentist));

  const factDay = tasks.parseFactDay("my exam is on monday", thursday);
  factDay && factDay.date === "2026-09-21" && factDay.kind === "fact-day"
    ? ok("a pinned fact with a day books a check-in", shown(factDay))
    : bad("fact-day parse", shown(factDay));
  tasks.parseFactDay("he hates mondays", thursday) === null
    ? ok("but 'mondays' in general is not a date")
    : bad("plural weekday false positive");

  // ledger: add, fire once, never twice, ignore other days
  const hold = { facts: [], tasks: [] };
  const saved = mem.state; // tests must not touch the real ledger
  const fake = { tasks: [] };
  tasks._useFakeState(fake);
  const t1 = { what: "call mom", date: "2026-09-17", whenMin: 1080, kind: "reminder", byWhom: "him" };
  tasks.addTask(t1);
  tasks.addTask({ ...t1 });
  fake.tasks.length === 1
    ? ok("the same reminder is not stored twice")
    : bad("duplicate task", JSON.stringify(fake.tasks));
  tasks.takeDue("2026-09-16", 1200).length === 0
    ? ok("nothing fires on the wrong day")
    : bad("fired on wrong day");
  const due = tasks.takeDue("2026-09-17", 1200);
  due.length === 1 && tasks.takeDue("2026-09-17", 1300).length === 0
    ? ok("a reminder fires exactly once", JSON.stringify(due.map((x) => x.what)))
    : bad("fire-once", JSON.stringify(fake.tasks));
  tasks._useFakeState(null);
  void hold; void saved;
}

// ---------------------------------------------------------- reading him
// The half of the conversation the first version barely looked at: how short he
// is being, that he is venting rather than joking, what he actually asked, and
// when in the day he is even awake. All of it is free - no model, no state.json.
function testSignal() {
  console.log("\n[11] reading him (signal.js)");
  const read = signal.readHis;

  read("k").dry && read("yeah").dry && read("nothing").dry && read("ok").dry
    ? ok("she can hear that he has gone short with her", '"k", "yeah", "nothing"')
    : bad("dryness not read");
  !read("no idea what you mean by that, explain it properly please").dry
    ? ok("and a real sentence is not mistaken for it")
    : bad("a full sentence counted as dry");

  read("I GOT THE JOB!!").excited && read("did you see this?? it works!! i cannot believe it").excited
    ? ok("she can tell when something lit him up", '"I GOT THE JOB!!"')
    : bad("excitement not read");
  read("my boss is so annoying, i cant stand him").venting && !read("my boss is so annoying").serious
    ? ok("and she can tell venting apart from a serious talk", "venting is not an emergency")
    : bad("venting not read");
  read("i think i might be down lately").serious && !read("i think i might be down lately").venting
    ? ok("while actually being down is read as the serious thing it is")
    : bad("a struggling him read as venting");
  read("what time are you free tonight?").asking && read("night, sleep well").goodnight && read("lol that was funny").funny
    ? ok("questions, goodnights and jokes each have their own read")
    : bad("asking/goodnight/funny signal lost");

  // the follow-through: did her reply actually go back to what he asked
  const q = signal.questionIn("hey. how was your shift today?");
  q && q.words.includes("shift")
    ? ok("his question is reduced to the words an answer would have to touch", `"${q.text}" -> ${q.words.join(", ")}`)
    : bad("question not read", JSON.stringify(q));
  signal.answered(q, "shift was fine, boring mostly") && signal.answered(q, "the shifts are killing me")
    ? ok("and a reply that answers it counts, even reworded")
    : bad("a real answer read as unanswered");
  !signal.answered(q, "anyway i bought new shoes today lol")
    ? ok("while a reply about her own day does not", "this is the failure the check exists for")
    : bad("an unrelated reply passed the answer check");
  signal.questionIn("you ok?") === null && signal.questionIn("how are you") === null
    ? ok("a question made of nothing but small words asks nothing of her", '"you ok?" is not an obligation')
    : bad("empty question invented");
  // and the other side of it: she does not have to say his noun back at him
  signal.answered(q, "night shift was fine, theyre moving me to the east aisle")
    ? ok("an evaluation of the thing he asked about is an answer", '"how was the warehouse" -> "night shift was fine"')
    : bad("a real answer was read as ignored");
  signal.answered(q, "i cant stand that outfit he wore lol")
    ? bad("an unrelated opinion passed as an answer")
    : ok("while an opinion about something else is not");

  const hist = [
    { r: "a", t: "hello there" },
    { r: "u", t: "k" },
    { r: "u", t: "yeah" },
    { r: "u", t: "sure" },
  ];
  const eng = signal.engagement(hist, { turns: 14 });
  eng.dryStreak === 3 && eng.avgWords !== null
    ? ok("his last few turns are counted as a shape, not as one message", `dry streak of ${eng.dryStreak}`)
    : bad("dry streak not measured", JSON.stringify(eng));
  signal.engagement([{ r: "a", t: "night" }, { r: "u", t: "did you ever watch that film i sent?" }]).pending?.words.includes("film")
    ? ok("and something of his that is still hanging is noticed", "his question after her last reply")
    : bad("open question not carried");
  signal.engagement([{ r: "u", t: "did you watch it?" }, { r: "a", t: "not yet" }]).pending === null
    ? ok("but nothing hangs once she has answered")
    : bad("a stale question stayed pending");

  // what the two of them are DOING, as opposed to how she feels
  const tn = (text, previous = null) => signal.nextTone({ signal: read(text), text, previous, random: seeded(9) });
  tn("i think i might be down lately").key === "deep"
    ? ok("a real conversation is read as one", "serious -> deep")
    : bad("deep register not set", tn("i think i might be down lately").key);
  tn("my boss is so annoying, i cant stand him").key === "venting"
    ? ok("letting off steam is read as venting, not as banter")
    : bad("venting register not set");
  tn("what time are you free tonight?").key === "logistics" && tn("how was the warehouse tonight?").key === null
    ? ok("plan-making is read as logistics - and asking how his evening went is not", "the word 'tonight' alone does not make it logistics")
    : bad("logistics register wrong", JSON.stringify([tn("what time are you free tonight?").key, tn("how was the warehouse tonight?").key]));
  tn("lol stop it thats funny").key === "banter" && tn("i missed you today").key === "flirty"
    ? ok("and messing around vs flirting are told apart")
    : bad("banter/flirty registers not set");

  const kept = signal.nextTone({ signal: {}, text: "ok", previous: { key: "banter", left: 4 }, msgs: 2, random: seeded(2) });
  kept.key === "banter" && kept.left === 2 && kept.changed === false
    ? ok("a register survives his next message and spends a turn on it", "banter, 4 -> 2 of his messages left")
    : bad("register did not decay", JSON.stringify(kept));
  signal.nextTone({ signal: {}, text: "ok", previous: { key: "banter", left: 1 }, msgs: 2, random: seeded(2) }).key === null
    ? ok("and it runs out instead of sticking for an hour")
    : bad("register never expires");
  signal.nextTone({ signal: read("fuck off"), text: "fuck off", previous: { key: "banter", left: 5 }, random: seeded(1) }).key === null
    ? ok("when he shuts it down, whatever they were doing is over")
    : bad("a register outlived a refusal");

  // when he is actually awake and answering
  const st = {};
  const noon = Date.UTC(2026, 8, 16, 10, 0); // 12:00 in Dortmund
  for (let i = 0; i < 12; i += 1) signal.noteActivity(st, noon);
  const hour = nowBerlin(new Date(noon)).hour;
  signal.hisWindowScore(st, clock(hour * 60)) > 0.5 && signal.hisWindowScore(st, clock(((hour + 12) % 24) * 60)) < 0.2
    ? ok("she learns which hours he is actually there in", `${String(hour).padStart(2, "0")}:00 is his hour`)
    : bad("his hours not learned", JSON.stringify(st.hisHours));
  signal.hotHours(st, { from: 0, to: 24 * 60, limit: 4 }).includes(hour * 60) && signal.hotHours({}, {}).length === 0
    ? ok("and a handful of messages is not yet a habit", "no hot hours until there is real signal")
    : bad("hot hours wrong");

  // she texts first when he is around, without becoming a cron job
  // he is an evening texter: 19:00, 20:00 and 21:00 are his hours
  const hotHours = { hisHours: Array.from({ length: 24 }, (_, i) => (i >= 19 && i <= 21 ? 20 : 0)) };
  const sched = { wakeMin: 480, bedMin: 1470, hours: 9 };
  let inHot = 0;
  let total = 0;
  let outside = 0;
  for (let i = 0; i < 300; i += 1) {
    for (const slot of proactive.makeSchedule(sched, clock(600), { state: hotHours, random: seeded(200 + i) })) {
      total += 1;
      if (slot.t >= 19 * 60 && slot.t <= 21 * 60 + 59) inHot += 1;
      if (slot.t < sched.wakeMin + 45 || slot.t > sched.bedMin - 60) outside += 1;
    }
  }
  const hotShare = inHot / Math.max(1, total);
  // uniform would be about a quarter of an 11-hour evening, so this has to sit
  // well above that and well below "all of them"
  console.log(`  ---- her spontaneous texts land in his three evening hours ${(hotShare * 100).toFixed(0)}% of the time`);
  hotShare > 0.32 && hotShare < 0.8 && outside === 0
    ? ok("her first texts lean into the hours he answers in, without all bunching there", `${(hotShare * 100).toFixed(0)}% in his evening, ${total} slots, none in her night`)
    : bad("his-hours bias wrong", JSON.stringify({ hotShare, outside, total }));

  // the beat before sending: typing, stopping, sending anyway
  const softMood = { key: "soft", def: mood.MOODS.soft };
  const h = wantsHesitation(softMood, () => 0.01);
  h && h.typedMs >= 2000 && h.totalMs > h.typedMs
    ? ok("she can start typing and stop before sending", `${Math.round(h.typedMs / 1000)}s of typing, ${Math.round(h.silenceMs / 1000)}s of thinking`)
    : bad("hesitation not rolled", JSON.stringify(h));
  wantsHesitation({ key: "chaotic", def: mood.MOODS.chaotic }, () => 0.01) === null && wantsHesitation(softMood, () => 0.99) === null
    ? ok("but only in the moods where that is true, and rarely")
    : bad("hesitation fired when it should not");

  // the notes she is handed about the conversation itself
  const deep = tn("i think i might be down lately");
  const block = toneBlock(deep, { dryStreak: 3, long: false, pending: null });
  block.includes("not banter") && block.includes("SHORT WITH YOU")
    ? ok("and both the register and his dryness reach her as internal notes")
    : bad("tone block incomplete", block);
  toneBlock(null, null) === "" ? ok("an ordinary chat adds no notes at all") : bad("empty tone block leaked");

  read("what is the difference between correlation and causation").dataScience
    && read("why is my model overfitting this dataset").dataScience
    ? ok("data-science questions are recognized as her own topic")
    : bad("data-science topic not recognized");
  !read("miss you, come over tonight").dataScience && !read("lol that meme was funny").dataScience
    ? ok("ordinary chat is not mistaken for data science")
    : bad("ordinary chat was wrongly classified as data science");
  const dsMode = signal.topicMode("why is my sklearn pipeline leaking data from the test set");
  dsMode.topic === "data_science" && dsMode.webAllowed === false && dsMode.knowledgeSource === "internal"
    ? ok("topicMode makes data science web-off", JSON.stringify(dsMode))
    : bad("data-science topicMode is wrong", JSON.stringify(dsMode));
  const chatMode = signal.topicMode("what are you doing tonight");
  chatMode.topic === "general" && chatMode.webAllowed === true
    ? ok("ordinary topicMode stays web-allowed")
    : bad("ordinary topicMode was wrongly blocked", JSON.stringify(chatMode));
  // a student asking about his course is a senpai question even without a library name
  read("my course is killing me this semester").dataScience && read("i have an assignment due friday").dataScience
    ? ok("and ordinary study talk counts as her topic, not only library names")
    : bad("study talk was not recognized as data science");

  // The knowledge layer is the part that fails SILENTLY: with an empty roadmaps/
  // folder every block resolves to an empty string, so the feature looks wired up
  // while it teaches nothing at all - which is exactly what had happened. So the
  // real module is loaded in a child process against a fixture folder and asked
  // for output, rather than trusting the wiring by eye.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dsDir = fs.mkdtempSync(path.join(os.tmpdir(), "negev-ds-"));
  fs.writeFileSync(path.join(dsDir, "data-science-roadmap-all-topics.md"), [
    "# fixture roadmap",
    "## SQL window functions",
    "PARTITION BY groups rows, ORDER BY sequences them, and the frame decides the window. ROW_NUMBER gives a deterministic rank and RANK ties with gaps.",
    "## Overfitting and validation",
    "Overfitting shows up as a validation curve turning up while training loss keeps falling. Underfitting is both curves high and flat.",
  ].join("\n"), "utf8");
  const probe = path.join(dsDir, "probe.mjs");
  fs.writeFileSync(probe, [
    `import * as roadmap from ${JSON.stringify(pathToFileURL(path.join(here, "data-science.js")).href)};`,
    `const ctx = roadmap.contextFor("how do i use window functions", { maxChars: 4200, limit: 4, rotate: true });`,
    `console.log(JSON.stringify({ chunks: roadmap.status().chunks, ctx: ctx.length, known: ctx.includes("SQL window functions"), cue: roadmap.proactiveCue().length }));`,
  ].join("\n"), "utf8");
  let dsOut = "";
  try {
    dsOut = execFileSync(process.execPath, [probe], {
      env: { ...process.env, NEGEV_DS_ROADMAP_DIR: dsDir },
      cwd: here,
      encoding: "utf8",
    });
  } catch (err) {
    dsOut = String((err && (err.stdout || err.message)) || "");
  }
  const dsProbe = (() => {
    try { return JSON.parse(dsOut.trim().split("\n").pop()); } catch { return null; }
  })();
  dsProbe && dsProbe.chunks >= 2 && dsProbe.ctx > 0 && dsProbe.known && dsProbe.cue > 0
    ? ok("with roadmap files present the notes really reach her prompt", `${dsProbe.chunks} chunks, ${dsProbe.ctx} chars of context, cue ${dsProbe.cue}`)
    : bad("the roadmap knowledge layer produced nothing", dsOut.slice(0, 200));
  fs.rmSync(dsDir, { recursive: true, force: true });
}

// ------------------------------------------------------------- fixed biography
function testIdentity() {
  console.log("\n[21] fixed biography (identity.js)");
  mem.setReadOnly(true);
  const before = mem.state.identity;
  mem.state.identity = {
    profileVersion: 1,
    favorites: { song: "old song", dish: "pasta", drink: "tea", color: "green" },
    hobbies: [{ key: "tv", detail: "watching Cold Case" }],
    places: { regulars: ["a park"], visited: ["Berlin"], dreamTrip: "Rome" },
    fears: "spiders",
    flat: { detail: "a flat", decor: "a monstera named Gerd and basil" },
  };
  const me = identity.ensure();
  const block = identity.block();
  me.profileVersion === 2
    ? ok("old biography migrates to the current profile")
    : bad("old biography was not migrated", String(me.profileVersion));
  !/gerd|monstera|basil|cold case/i.test(JSON.stringify(me)) && !/gerd|monstera|basil|cold case/i.test(block)
    ? ok("old plant and TV details cannot resurface")
    : bad("old biography leaked into the new profile", block);
  me.favorites.song === "Are You Bored Yet?" && me.favorites.dish.includes("Rheinlanddamm") && me.favorites.drink.includes("iced americano")
    ? ok("corrected favourites are loaded")
    : bad("corrected favourites are missing", JSON.stringify(me.favorites));
  block.includes("anime") && block.includes("manga") && block.includes("plushies") && /(?:no plants|do not have plants)/i.test(block)
    ? ok("the low-key anime, manga, plushie profile is present")
    : bad("corrected lifestyle details are missing", block);
  identity.ensure() === me
    ? ok("the current profile does not re-roll")
    : bad("the current profile re-rolled");
  mem.state.identity = before;
}

// ------------------------------------------------------------- the relationship
function testBond() {
  console.log("\n[12] the relationship (bond.js)");
  const day = 86400000;
  const aged = (n, msgs = 0, media = 0) => ({ boundAt: Date.now() - n * day, userMsgCount: msgs, mediaCount: media, bond: null });

  bond.stageOf(aged(0)).n === 1 && bond.stageOf(aged(4)).n === 2 && bond.stageOf(aged(12)).n === 3 && bond.stageOf(aged(40)).n === 4
    ? ok("the same girl behaves differently on day one and on day forty", [1, 4, 12, 40].map((d) => `d${d}=stage${bond.stageOf(aged(d)).n}`).join(" | "))
    : bad("stages not derived");
  bond.stageOf(aged(0, 500)).n === 3
    ? ok("and a week of long conversations moves her as much as a month of quiet ones")
    : bad("messages do not count toward stage");
  bond.closeness(aged(40, 2000)) > bond.closeness(aged(0)) && bond.closeness(aged(0)) > 0
    ? ok("closeness grows with the relationship")
    : bad("closeness not monotonic");

  const st = { bond: null };
  bond.ensure(st);
  bond.addOurThings(st, ["the raccoon video thing"]) === 1 && bond.addOurThings(st, ["the raccoon video thing"]) === 0
    ? ok("something they share is remembered once, not twice")
    : bad("shared thing duplicated");
  for (let i = 0; i < 20; i += 1) bond.addOurThings(st, [`shared joke number ${i}`]);
  st.bond.ourThings.length <= 8 ? ok("and the list stays short enough to be theirs", `${st.bond.ourThings.length} kept`) : bad("ourThings unbounded");

  // opening up: one at a time, only when the armour is down, spent forever
  const deep = aged(12, 900);
  bond.revealFor(deep, { key: "chaotic" }, () => 0.001) === null
    ? ok("she does not open up in a mood where she is performing")
    : bad("a chaotic girl revealed something");
  const rev = bond.revealFor(deep, { key: "soft" }, () => 0.001);
  rev && rev.text && bond.view(deep).reveal === rev.text
    ? ok("but in a soft mood the armour slips one notch", `"${rev.text.slice(0, 60)}..."`)
    : bad("no reveal in a soft mood");
  bond.revealFor(deep, { key: "soft" }, () => 0.001).id === rev.id
    ? ok("and only one at a time - it is not a list of secrets")
    : bad("a second reveal was queued");
  bond.confirmReveal(deep) && deep.bond.told.length === 1
    ? ok("once it is actually said it is spent forever")
    : bad("reveal not marked as told");
  bond.revealFor(deep, { key: "soft" }, () => 0.001).id !== rev.id
    ? ok("the next one is a different thing about her")
    : bad("the same truth was handed out twice");
  bond.dropReveal(deep);
  deep.bond.told.length === 1 && bond.view(deep).reveal === null
    ? ok("and a reply that never went out burns nothing")
    : bad("a dropped reveal was marked as told");

  // milestones: she notices them herself, exactly once
  const youth = aged(8, 5);
  const due = bond.dueMilestones(youth, clock(600));
  due.some((m) => m.id === "day-7") && bond.dueMilestones(youth, clock(600)).length === 0
    ? ok("a week with him is noticed - once", due.map((m) => m.what).join("; "))
    : bad("milestone not fired once", JSON.stringify(due));
  const mTask = bond.milestoneTask(due[0], clock(600));
  mTask.kind === "bond-milestone" && mTask.date === "2026-09-16" && mTask.byWhom === "her"
    ? ok("and it becomes one of her own texts, not a notification", `${mTask.what} @ ${mTask.date} ${mTask.whenMin}`)
    : bad("milestone task shape", JSON.stringify(mTask));

  // the moment of his that mattered, and the check-in the next morning
  const st2 = { bond: null };
  bond.noteMoment(st2, "his interview is tomorrow and he is nervous", clock(600))
    && !bond.noteMoment(st2, "and another thing the same day", clock(600))
    ? ok("one moment of his per day is kept", "not a feed")
    : bad("hisMoment ledger wrong");
  const mt = bond.momentTask(st2.bond.moments[0], clock(600));
  mt.kind === "his-moment" && mt.date === "2026-09-17"
    ? ok("and she asks about it the next morning", `${mt.date} ${mt.whenMin}`)
    : bad("moment task shape", JSON.stringify(mt));
  bond.noteRepair(st2) === 1 ? ok("a fight that got made up is counted as one") : bad("repairs not counted");
  /stage 1\/4/.test(bond.describe(aged(0))) && bond.describe(aged(12, 900)).includes("opened up about")
    ? ok("and the whole ledger is inspectable with !bond")
    : bad("bond.describe incomplete", bond.describe(aged(12, 900)));
}

// ---------------------------------------------------------------- reactions
function testReactions() {
  console.log("\n[13] reactions (reactions.js)");
  reactions.extract([{ type: "emoji", emoji: "❤" }])[0] === "❤" && reactions.extract(["👍"])[0] === "👍"
    ? ok("both reaction shapes telegram uses are read")
    : bad("reaction extraction");
  reactions.isHeart("❤️") && reactions.isHeart("❤") && !reactions.isHeart("👍") && reactions.isPositive("🔥")
    ? ok("a heart is a heart, a like is not")
    : bad("reaction classification");

  const st = { reactionStyle: "auto", reactionsSent: { date: null, count: 0 }, hisReaction: null };
  const ev = { chat: { id: 7 }, message_id: 12, new_reaction: [{ type: "emoji", emoji: "❤" }], old_reaction: [] };
  const note = reactions.noteHis(st, ev, { herText: "night commander", ownerId: 7 });
  note && note.emoji === "❤" && note.acknowledged === false
    ? ok("his heart on her message is remembered, unspoken for now")
    : bad("his reaction not noted");
  reactions.noteHis(st, ev, { ownerId: 7 }).acknowledged === false
    ? ok("and a redelivered update does not reset it")
    : bad("repeated reaction update mishandled");
  reactions.noteHis(st, { chat: { id: 7 }, message_id: 12, new_reaction: [], old_reaction: [{ type: "emoji", emoji: "❤" }] }, { ownerId: 7 }) === null
    && st.hisReaction === null
    ? ok("taking it back is not a scene")
    : bad("removed reaction still pending");
  reactions.noteHis({}, { chat: { id: 99 }, message_id: 1, new_reaction: ["❤"] }, { ownerId: 7 }) === null
    ? ok("and a stranger's reaction is ignored entirely")
    : bad("stranger reaction accepted");

  const rb = reactionBlock({ hisReaction: { emoji: "❤", text: "night commander", acknowledged: false } });
  rb.includes("heart") && rb.includes("never explain")
    ? ok("she is told to mention it once, in passing", "never as an accusation")
    : bad("reaction block incomplete", rb);
  reactionBlock({ hisReaction: { emoji: "❤", text: "x", acknowledged: true } }) === ""
    ? ok("and only until she has said it")
    : bad("reaction mentioned twice");
  reactionBlock({ hisReaction: { emoji: "👎", text: "oops", acknowledged: false, positive: false } }).includes("not a friendly one")
    ? ok("a thumbs down is not mistaken for affection", "no argument over an emoji")
    : bad("a negative reaction read as sweet");

  const soft = { key: "soft", def: { heart: 0.22 } };
  const sulky = { key: "sulky", def: { heart: 0.01 } };
  reactions.shouldHeartInsteadOfWords(st, sulky, () => 0.001) === false
    ? ok("a sulky girl does not heart his message instead of answering")
    : bad("sulky mood hearted");
  reactions.shouldHeartInsteadOfWords(st, soft, () => 0.001) === true
    ? ok("while a soft one reads it and leaves a heart - present, silent, no words")
    : bad("silent heart never fires");
  reactions.shouldHeartInsteadOfWords({ reactionStyle: "off" }, soft, () => 0.001) === false
    ? ok("and a server that refuses reactions is never asked twice", "the channel just switches off")
    : bad("reactions kept trying after being refused");
  reactions.shouldHeartInsteadOfWords({ reactionStyle: "auto", reactionsSent: { date: nowBerlin().dateStr, count: reactions.DAY_LIMIT } }, soft, () => 0.001) === false
    ? ok("with a daily ceiling, so it stays a gesture", `${reactions.DAY_LIMIT} spontaneous reactions a day, shared by both paths`)
    : bad("reaction rate limit missing");
  reactions.describe(st).includes("hearts used today") ? ok("and /status reports the channel") : bad("reaction status missing");

  // an explicit request is done, not rolled for: the parser decides whether he
  // just asked, and it must be narrow enough that chat about reactions never fires
  const req = (t) => reactions.parseRequest(t);
  req("just put reaction on my message, i wanna just test it")?.emoji === "❤"
    ? ok("an explicit request is recognised")
    : bad("explicit reaction request missed");
  req("put a reaction on my message") && req("leave a heart on that") && req("react to this")
    ? ok("the phrasings a person actually types all match")
    : bad("reaction request phrasings missed");
  req("put a fire reaction on it")?.emoji === "🔥"
    ? ok("a named emoji is honoured")
    : bad("named emoji lost");
  req("how do you react to that news") === null && req("a chemical reaction") === null
    && req("you never react to my jokes") === null && req("i love your reactions") === null
    ? ok("and talk ABOUT reactions is never an instruction")
    : bad("a remark was mistaken for a request");
  reactions.targetOf({ chat: { id: 7 }, message_id: 99, reply_to_message: { message_id: 55 } }, { ownerId: 7 }) === 55
    ? ok("the request points at the message he replied to")
    : bad("reply-to target missed");
  reactions.targetOf({ chat: { id: 7 }, message_id: 99 }, { ownerId: 7, inbox: [{ id: 41 }, { id: 77 }] }) === 99
    ? ok("and with no reply-to, on the request itself - never the stale inbox")
    : bad("bare request did not aim at itself");

  // the unprompted channel: mood sets the odds, the message's topic bends which
  // emoji she reaches for, and the mix moves as she moves through the day
  const topicOf = (t) => reactions.readTopicForReaction(t);
  topicOf("hahahha that meme is gold") === "funny" && topicOf("GUESS WHAT I GOT THE JOB!!") === "exciting"
    ? ok("the message's content is read for what it is")
    : bad(`topic read broken (${topicOf("GUESS WHAT I GOT THE JOB!!")})`);
  topicOf("the gym was closed today") === "none"
    ? ok("ordinary chat gets no topic push")
    : bad("ordinary chat misread as special");
  const softPick = reactions.pickSpontaneousEmoji("soft", "affection", { random: () => 0 });
  const chaosPick = reactions.pickSpontaneousEmoji("chaotic", "funny", { random: () => 0 });
  (softPick === "❤" || softPick === "😍") && chaosPick === "😂"
    ? ok("mood + topic decide the emoji: soft+affection hearts, chaotic+funny laughs")
    : bad(`emoji choice wrong (soft+affection -> ${softPick}, chaotic+funny -> ${chaosPick})`);
  const repeated = new Set();
  for (let i = 0; i < 40; i += 1) repeated.add(reactions.pickSpontaneousEmoji("warm", "none", { lastEmoji: "❤", random: Math.random }));
  repeated.size >= 2
    ? ok("and she does not heart five messages in a row - the last one is played down")
    : bad("variety missing: the same emoji forever");
  const stSpont = { reactionStyle: "object", reactionsSent: { date: null, count: 0 } };
  const sawTopic = reactions.shouldReactWhileReading(stSpont, { key: "soft" }, { topic: "funny", random: () => 0.001 }) === true
    && reactions.shouldReactWhileReading(stSpont, { key: "sulky" }, { topic: "funny", random: () => 0.001 }) === false
    && reactions.shouldReactWhileReading(stSpont, { key: "distant" }, { topic: "none", random: () => 0.001 }) === false
    && reactions.shouldReactWhileReading(stSpont, { key: "soft" }, { topic: "none", random: () => 0.5 }) === false;
  sawTopic
    ? ok("the odds: soft+funny up to 20%, warm ~10%, tired 4%, sulky/distant never")
    : bad("spontaneous gating broken");
  reactions.shouldReactWhileReading({ reactionStyle: "object", reactionsSent: { date: nowBerlin().dateStr, count: 3 } }, { key: "soft" }, { topic: "funny", random: () => 0.001 }) === false
    ? ok("with the shared 3-a-day ceiling so it stays a gesture")
    : bad("daily cap ignored on the spontaneous path");
}

// --------------------------------------------------------------- her voice
function testVoice() {
  console.log("\n[14] her voice (voice.js)");
  // marks are typing, not speech: nobody says "less than three"
  voice.speakable("night commander <3") === "night commander"
    && voice.speakable("finally friday)))") === "finally friday"
    && voice.speakable("that was ridiculous xdd") === "that was ridiculous"
    && voice.speakable("told you so :3") === "told you so"
    ? ok("her marks are stripped before anything is said out loud", "no tts reading a bare ) aloud")
    : bad("speakable() left her marks in", JSON.stringify([
      voice.speakable("night commander <3"),
      voice.speakable("finally friday)))"),
      voice.speakable("that was ridiculous xdd"),
      voice.speakable("told you so :3"),
    ]));

  const enabled = process.env.NEGEV_VOICE === "1";
  (enabled ? voice.describe().length > 0 : /^off\b/.test(voice.describe()))
    ? ok("and voice notes are off unless someone turns them on", enabled ? voice.describe() : "the install stays zero-dependency")
    : bad("voice default wrong", voice.describe());

  // the gating, on a machine that does have a voice
  const on = { enabled: true, random: () => 0.001 };
  const fits = (o) => voice.fits({ ...on, ...o });
  fits({ mood: { key: "soft" }, closeness: 0.9, text: "i miss you" })
    ? ok("a short soft line to a girl he has been with a while can be spoken")
    : bad("voice never fires");
  !fits({ mood: { key: "chaotic" }, closeness: 0.9, text: "i miss you" })
    ? ok("but not in a mood where she would be performing")
    : bad("voice in the wrong mood");
  !fits({ mood: { key: "soft" }, closeness: 0.1, text: "i miss you" })
    ? ok("and not on day one, when she would not send her voice to anyone")
    : bad("voice too early in the relationship");
  !fits({ mood: { key: "soft" }, closeness: 0.9, text: "look https://youtu.be/x" })
    && !fits({ mood: { key: "soft" }, closeness: 0.9, text: "you ok?" })
    && !fits({ mood: { key: "soft" }, closeness: 0.9, text: "))" })
    ? ok("never on a link, never as a question, never when there is nothing to say")
    : bad("voice fits too much");
  !fits({ mood: { key: "soft" }, closeness: 0.9, text: "i miss you", random: () => 0.9 })
    ? ok("and it stays rare", "about 1 in 20 soft short lines")
    : bad("voice fires too often");
}
