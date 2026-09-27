// Her voice, for the rare line that needs it.
//
// Text is the whole conversation and that is deliberate - but a person who is
// actually into you sends a voice note now and then, usually when the words are
// softer than their typing. This is that, and it is the only feature in the whole
// project that needs something installed.
//
// It runs entirely locally, the same way the whisper pipeline does: the text goes
// into a TTS binary on your disk, and the audio goes out through Telegram. No API
// key, no credits, no cost per use.
//
// Off by default and gated three ways (config/env flag, binary found, mood fits),
// so the default install is exactly the zero-dependency text bot it always was.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG, PATHS } from "./config.js";
import { log, logErr } from "./util.js";
// the video pipeline already resolved ffmpeg for this machine - reuse it rather
// than asking the user a second time where ffmpeg lives
import { resolveTools } from "./media.js";

const ENABLED = process.env.NEGEV_VOICE === "1" || CONFIG.voice?.enabled === true;
const BIN = process.env.NEGEV_TTS_BIN || CONFIG.voice?.bin || "";
const MODEL = process.env.NEGEV_TTS_MODEL || CONFIG.voice?.model || "";
const MAX_CHARS = Number(process.env.NEGEV_VOICE_MAX_CHARS || CONFIG.voice?.maxChars || 160);

/** piper / espeak-ng in the places they actually end up on Windows and Linux. */
function candidates() {
  const local = process.env.LOCALAPPDATA || "";
  return [
    BIN,
    local && path.join(local, "Programs", "piper", "piper.exe"),
    local && path.join(local, "Programs", "piper", "piper"),
    "/usr/local/bin/piper",
    "/usr/bin/piper",
    "piper",
    "espeak-ng",
  ].filter(Boolean);
}

function ffmpegPath() {
  try {
    return resolveTools().ffmpeg || "ffmpeg";
  } catch {
    return process.env.NEGEV_FFMPEG || "ffmpeg";
  }
}

/** Which binary, if any, is going to say this out loud. Resolved once. */
let resolved = null;
export function available() {
  if (!ENABLED) return null;
  if (resolved) return resolved;
  for (const bin of candidates()) {
    try {
      if (bin.includes("/") || bin.includes("\\")) {
        if (fs.existsSync(bin)) { resolved = bin; return resolved; }
      } else {
        resolved = bin; // on PATH: let spawn fail loudly if it is not there
        return resolved;
      }
    } catch { /* keep looking */ }
  }
  return null;
}

function run(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(cmd, args, { windowsHide: true });
    const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(killer); resolve({ code: -1, stderr: err.message }); });
    child.on("close", (code) => { clearTimeout(killer); resolve({ code: code ?? -1, stderr }); });
  });
}

/**
 * Her marks are typing, not speech: nobody says "less than three", and a tts
 * engine reading "))) " out loud is the one thing that would give her away faster
 * than text ever could. The voice note is what she SAYS, so the marks come out
 * before it is rendered.
 */
export function speakable(text) {
  return String(text || "")
    .replace(/\s*\)+\s*$/gm, "") // the bare-paren laugh, welded to the last word
    .replace(/(^|\s)xd+\b/gi, "$1") // the xd laugh, a word of its own
    .replace(/\s*<3+\s*/g, " ") // the typed heart
    .replace(/\s*:3+\s*/g, " ") // the smug face
    .replace(/\s*\u2026\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function tmpFile(ext) {
  fs.mkdirSync(PATHS.tmp, { recursive: true });
  return path.join(PATHS.tmp, `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}${ext}`);
}

/**
 * Render text to an ogg/opus voice note. Returns the file path or null.
 * Two steps: the TTS binary writes a wav, ffmpeg turns it into the format
 * Telegram shows as an actual voice message (a wav arrives as a music file, which
 * is not the thing a person sends).
 */
export async function render(text) {
  const bin = available();
  if (!bin) return null;
  const say = speakable(text).slice(0, MAX_CHARS);
  if (say.length < 2) return null;
  const wav = tmpFile(".wav");
  const ogg = tmpFile(".ogg");
  try {
    const args = bin.toLowerCase().includes("piper")
      ? ["--model", MODEL, "--output_file", wav]
      : ["-w", wav, "-s", "165"];
    if (bin.toLowerCase().includes("piper") && !MODEL) {
      log("[voice] no piper voice model configured (NEGEV_TTS_MODEL) - voice notes stay off");
      return null;
    }
    const said = await new Promise((resolve) => {
      let stderr = "";
      const child = spawn(bin, args, { windowsHide: true });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => resolve({ code: -1, stderr: err.message }));
      child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      child.stdin.write(say.length > 640 ? say.slice(0, 640) : say);
      child.stdin.end();
    });
    if (said.code !== 0 || !fs.existsSync(wav) || fs.statSync(wav).size < 2000) {
      logErr("[voice] tts failed:", said.stderr?.slice(0, 200) || `exit ${said.code}`);
      return null;
    }
    const encoded = await encodeOpus(wav, ogg);
    if (!encoded.ok) {
      logErr("[voice] opus encode failed:", encoded.stderr?.slice(0, 200) || `exit ${encoded.code}`);
      return null;
    }
    return ogg;
  } finally {
    try { fs.rmSync(wav, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * wav -> the ogg/opus container Telegram shows as an actual voice message. Split
 * out of render() so the one step that has never touched a real machine in this
 * workspace (no tts binary is installed) can be executed and inspected on its own
 * - the self-test encodes a real sine wave and asks ffprobe what came out.
 */
export async function encodeOpus(wav, ogg) {
  const ff = await run(ffmpegPath(), ["-y", "-i", wav, "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", ogg]);
  if (ff.code !== 0 || !fs.existsSync(ogg) || fs.statSync(ogg).size < 1000) {
    return { ok: false, code: ff.code, stderr: ff.stderr };
  }
  return { ok: true, code: 0, bytes: fs.statSync(ogg).size };
}

// The API root is overridable so the upload request can be aimed at a local server
// and inspected: this is the code path that has never been exercised against the
// real endpoint, and "works on paper" was the honest verdict on it.
const TG_API = process.env.NEGEV_TG_API || `https://api.telegram.org/bot${CONFIG.botToken}`;

/**
 * Send the rendered note. Telegram wants multipart for uploads, and Node's own
 * FormData/Blob are enough - no dependency, in keeping with the rest of this.
 */
export async function sendVoice(chatId, file, { replyTo = null } = {}) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("voice", new Blob([fs.readFileSync(file)], { type: "audio/ogg" }), "voice.ogg");
    if (replyTo) form.append("reply_to_message_id", String(replyTo));
    const res = await fetch(`${TG_API}/sendVoice`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({ ok: false, description: `bad json (${res.status})` }));
    if (!data.ok) return { ok: false, error: data.description || `http ${res.status}` };
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Does this particular bubble fit a voice note? Rare, only when she is feeling
 * soft with him, only when they have been together long enough that it is not a
 * performance, and never for anything long, linky or asking something - a spoken
 * question is a whole different pressure on him.
 * `enabled` is injectable so the decision can be tested on a machine with no tts.
 */
export function fits({ mood = null, closeness = 0, text = "", random = Math.random, enabled = null } = {}) {
  const on = enabled === null ? Boolean(available()) : Boolean(enabled);
  if (!on) return false;
  if (mood?.key !== "soft" && mood?.key !== "clingy" && mood?.key !== "warm") return false;
  if (closeness < 0.45) return false; // still performing: she would not send her voice yet
  const body = String(text || "").trim();
  if (!body || body.length > MAX_CHARS || /https?:\/\//.test(body) || /\?/.test(body)) return false;
  if (speakable(body).length < 2) return false; // nothing but marks: there is nothing to say
  return random() < 0.05;
}

/** The live check: fits(), with the machine's own state of affairs. */
export function wantsVoice(opts = {}) {
  return fits(opts);
}

/** One line for /status. */
export function describe() {
  if (!ENABLED) return "off (set NEGEV_VOICE=1 and install a local tts to hear her occasionally)";
  const bin = available();
  if (!bin) return "enabled but no tts binary found (set NEGEV_TTS_BIN)";
  if (bin.toLowerCase().includes("piper") && !MODEL) return `enabled (${bin}) but no voice model set (NEGEV_TTS_MODEL)`;
  return `on (${path.basename(bin)}${MODEL ? `, ${path.basename(MODEL)}` : ""}), max ${MAX_CHARS} chars`;
}
