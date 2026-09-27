// Media understanding.
//
//  pictures              -> NEVER local processing: DeepSeek V4 Flash sees images directly
//  video / voice / audio -> local whisper.cpp + Tesseract pipeline (no video API exists)
//
// The pipeline output is re-labelled before it reaches the model so it can tell
// SPEECH (the content) from ON-SCREEN TEXT (also content) from NON-SPEECH / MUSIC
// (decoration, usually irrelevant).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CONFIG, PATHS } from "./config.js";
import { logErr, truncate, mmss } from "./util.js";

// ------------------------------------------------------------------ tools

let toolsCache;
export function resolveTools() {
  if (toolsCache !== undefined) return toolsCache;

  const candidates = [
    CONFIG.pipeline.dir,
    process.env.NEGEV_PIPELINE_DIR,
    CONFIG.pipeline.defaultDir,
    CONFIG.pipeline.bundleDir,
    path.join(process.cwd(), "whisper-pipeline"),
  ].filter(Boolean);

  let pipeline = null;
  let ffmpeg = null;
  let ffprobe = null;

  for (const dir of candidates) {
    const script = path.join(dir, "scripts", "transcribe.py");
    const hasScript = fs.existsSync(script);

    const pyCandidates = [
      process.env.NEGEV_PIPELINE_PY,
      path.join(dir, "venv", "Scripts", "python.exe"),
      path.join(dir, "venv", "bin", "python"),
      path.join(dir, "venv", "bin", "python3"),
    ].filter(Boolean);

    let python = null;
    for (const py of pyCandidates) {
      if (!fs.existsSync(py)) continue;
      const probe = spawnSync(py, ["-c", "print('ok')"], { timeout: 15000, windowsHide: true, encoding: "utf8" });
      if (probe.status === 0) { python = py; break; }
    }

    const ffmpegCandidates = [
      path.join(dir, "bin", "ffmpeg.exe"),
      path.join(dir, "bin", "ffmpeg"),
    ];
    const ffprobeCandidates = [
      path.join(dir, "bin", "ffprobe.exe"),
      path.join(dir, "bin", "ffprobe"),
    ];
    if (!ffmpeg) ffmpeg = ffmpegCandidates.find((p) => fs.existsSync(p)) || null;
    if (!ffprobe) ffprobe = ffprobeCandidates.find((p) => fs.existsSync(p)) || null;

    if (!pipeline && hasScript && python && CONFIG.pipeline.enabled) {
      pipeline = { dir, script, python };
    }
  }

  toolsCache = { pipeline, ffmpeg: ffmpeg || "ffmpeg", ffprobe: ffprobe || "ffprobe" };
  return toolsCache;
}

export function pipelineAvailable() {
  return Boolean(resolveTools().pipeline);
}

function run(cmd, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err.message), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

// ------------------------------------------------------------- telegram

const TG_API = `https://api.telegram.org/bot${CONFIG.botToken}`;
const TG_FILE_API = `https://api.telegram.org/file/bot${CONFIG.botToken}`;

const NATIVE_VISION_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function mimeForExt(ext) {
  const value = String(ext || "").toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jpe": "image/jpeg",
    ".jfif": "image/jpeg",
    ".jif": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".jp2": "image/jp2",
    ".jxl": "image/jxl",
    ".dds": "image/vnd-ms.dds",
    ".psd": "image/vnd.adobe.photoshop",
    ".dng": "image/x-adobe-dng",
    ".cr2": "image/x-canon-cr2",
    ".nef": "image/x-nikon-nef",
    ".arw": "image/x-sony-arw",
    ".orf": "image/x-olympus-orf",
    ".raf": "image/x-fuji-raf",
    ".rw2": "image/x-panasonic-rw2",
    ".tga": "image/x-tga",
    ".ppm": "image/x-portable-pixmap",
    ".pgm": "image/x-portable-graymap",
    ".pbm": "image/x-portable-bitmap",
    ".pnm": "image/x-portable-anymap",
  }[value] || "";
}

/** Detect the real image type, even when Telegram or a remote server lied about it. */
export function detectImageMime(file, hint = "") {
  let head = Buffer.alloc(0);
  try { head = fs.readFileSync(file).subarray(0, 32); } catch { /* use hint/extension */ }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head.length >= 6 && (head.subarray(0, 6).toString() === "GIF87a" || head.subarray(0, 6).toString() === "GIF89a")) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return "image/bmp";
  if (head.length >= 4 && (head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return "image/tiff";
  if (head.length >= 12 && head.subarray(4, 8).toString() === "ftyp") {
    const brand = head.subarray(8, 12).toString();
    if (/^(heic|heix|hevc|hevx|mif1)$/i.test(brand)) return "image/heic";
    if (/^avif$/i.test(brand)) return "image/avif";
  }
  const hinted = String(hint || "").split(";")[0].trim().toLowerCase();
  return hinted.startsWith("image/") ? hinted : (mimeForExt(path.extname(file)) || "application/octet-stream");
}

/**
 * Make any image Telegram accepts safe for the vision endpoint locally. This is
 * deliberately a conversion, not another model request: one user image still
 * means one vision input and one credit-bearing reply.
 */
export async function prepareVisionImage(file, hint = "") {
  const mime = detectImageMime(file, hint);
  if (NATIVE_VISION_MIMES.has(mime)) return { file, mime, temporary: false };

  const { ffmpeg } = resolveTools();
  const dest = path.join(PATHS.tmp, `vision_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.jpg`);
  const result = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", file,
    "-frames:v", "1", "-vf", "scale=1600:-2", "-q:v", "6", dest,
  ], { timeoutMs: 60000 });
  if (result.code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 900) {
    return { file: dest, mime: "image/jpeg", temporary: true };
  }
  try { fs.unlinkSync(dest); } catch { /* ignore */ }
  return { file, mime, temporary: false };
}

export async function tg(method, params = {}) {
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({ ok: false, description: `bad json (${res.status})` }));
    if (!data.ok) return { ok: false, error: data.description || `http ${res.status}`, raw: data };
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

fs.mkdirSync(PATHS.tmp, { recursive: true });

export async function downloadTgFile(fileId, extHint = "") {
  const info = await tg("getFile", { file_id: fileId });
  if (!info.ok) throw new Error(`getFile: ${info.error}`);
  const filePath = info.result.file_path || "";
  const ext = path.extname(filePath) || extHint || ".bin";
  const dest = path.join(PATHS.tmp, `tg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  // The Bot API method URL and the file-download URL are different. TG_API
  // already contains /bot<TOKEN>; adding /file/bot<TOKEN> to it produced a 404.
  const res = await fetch(`${TG_FILE_API}/${filePath}`);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  const mime = detectImageMime(dest, mimeForExt(ext));
  return { file: dest, size: buf.length, filePath, mime };
}

// ---------------------------------------------------------- probe / frames

export async function probeDuration(file) {
  const { ffprobe } = resolveTools();
  const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeoutMs: 30000 });
  const value = parseFloat(String(r.stdout).trim());
  return Number.isFinite(value) ? value : 0;
}

export async function extractFrames(file, count = 2, durationSec = 0) {
  const { ffmpeg } = resolveTools();
  const dur = durationSec || (await probeDuration(file));
  if (!dur) return [];
  const out = [];
  const picks = count === 1 ? [0.5] : Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
  for (let i = 0; i < picks.length; i += 1) {
    const t = Math.max(0, dur * picks[i] - 0.15);
    const dest = path.join(PATHS.tmp, `fr_${Date.now().toString(36)}_${i}.jpg`);
    const r = await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", t.toFixed(2), "-i", file,
      "-frames:v", "1", "-vf", "scale=896:-2", "-q:v", "5",
      dest,
    ], { timeoutMs: 60000 });
    if (r.code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 900) out.push(dest);
    else try { fs.unlinkSync(dest); } catch { /* ignore */ }
  }
  return out;
}

export async function hasAudio(file) {
  const { ffprobe } = resolveTools();
  const r = await run(ffprobe, [
    "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file,
  ], { timeoutMs: 30000 });
  return Boolean(String(r.stdout).trim());
}

async function silenceSpans(file) {
  const { ffmpeg } = resolveTools();
  const r = await run(ffmpeg, [
    "-hide_banner", "-nostats", "-i", file,
    "-af", "silencedetect=noise=-35dB:d=0.7",
    "-f", "null", "-",
  ], { timeoutMs: 120000 });

  const spans = [];
  let start = null;
  for (const line of `${r.stderr}`.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) start = Math.max(0, parseFloat(s[1]));
    if (e) {
      const end = parseFloat(e[1]);
      if (start !== null && end > start) spans.push([start, end]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, Number.MAX_SAFE_INTEGER]);
  return spans;
}

// ------------------------------------------------------------- pipeline

function readIfExists(file) {
  try {
    if (!fs.existsSync(file)) return "";
    if (!fs.statSync(file).size) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parseWhisper(base) {
  const raw = readIfExists(`${base}.json`);
  if (raw) {
    try {
      const data = JSON.parse(raw);
      const segments = (data?.transcription || []).map((seg) => {
        const o = seg.offsets || {};
        return {
          start: (o.from ?? 0) / 1000,
          end: (o.to ?? 0) / 1000,
          text: String(seg.text || "").trim(),
        };
      }).filter((s) => s.text);
      return { segments, language: data?.result?.language || null };
    } catch (err) {
      logErr("[media] whisper json parse failed:", err.message);
    }
  }
  const txt = readIfExists(`${base}.txt`);
  if (!txt) return { segments: [], language: null };
  const segments = txt.split(/\r?\n/).map((line) => {
    const m = line.match(/^\[([\d:.]+)\s*-->\s*([\d:.]+)\]\s*(.*)$/);
    if (m) return { start: timeToSec(m[1]), end: timeToSec(m[2]), text: m[3].trim() };
    return { start: 0, end: 0, text: line.trim() };
  }).filter((s) => s.text);
  return { segments, language: null };
}

function timeToSec(ts) {
  const parts = String(ts).replace(",", ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

function parseOcr(base) {
  const raw = readIfExists(`${base}.ocr.txt`);
  if (!raw) return [];
  const blocks = [];
  const chunks = raw.split(/^---\s*(.+?)\s*---\s*$/m);
  for (let i = 1; i < chunks.length; i += 2) {
    const stamp = chunks[i].trim();
    const text = String(chunks[i + 1] || "").replace(/\s*\n\s*/g, " / ").trim();
    if (text) blocks.push({ stamp, text });
  }
  return blocks;
}

const NON_SPEECH_TAG = /^[[(♪*\s]*(music|applause|applauding|laughter|laughs|laughing|cheering|silence|sound|noise|inaudible|sighs|coughs|clears throat|blows|birds|beep)/i;

/**
 * Run the local pipeline over a video/audio file and return a labelled brief.
 * Returns { brief, frames, meta } - or null when the pipeline is unavailable.
 */
export async function transcribeMedia(file, { ocr = true, frames = CONFIG.pipeline.videoFrames, caption = "" } = {}) {
  const tools = resolveTools();
  if (!tools.pipeline) return null;

  // the pipeline runs with its own cwd, so always hand it an absolute path
  const absFile = path.resolve(file);
  const stem = path.basename(absFile).replace(/\.[^.]+$/, "");
  const outDir = path.join(PATHS.tmp, `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, stem);

  const args = [
    tools.pipeline.script, absFile,
    "--outdir", outDir,
    "--model", CONFIG.pipeline.model,
    "--lang", CONFIG.pipeline.lang,
  ];
  if (ocr && CONFIG.pipeline.ocr) {
    args.push("--ocr", "--ocr-langs", CONFIG.pipeline.ocrLangs, "--ocr-max", String(CONFIG.pipeline.ocrMax), "--ocr-fps", "0.5");
  }

  const started = Date.now();
  const r = await run(tools.pipeline.python, args, {
    cwd: tools.pipeline.dir,
    timeoutMs: CONFIG.pipeline.timeoutMs,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (r.code !== 0) {
    logErr(`[media] pipeline exit ${r.code}${r.timedOut ? " (timeout)" : ""}: ${String(r.stderr).split(/\r?\n/).slice(-3).join(" | ").slice(0, 400)}`);
  }

  const { segments, language } = parseWhisper(base);
  const ocrBlocks = ocr ? parseOcr(base) : [];
  const duration = await probeDuration(absFile);

  const framePaths = frames > 0 ? await extractFrames(absFile, frames, duration) : [];
  const nonSpeech = await analyseNonSpeech(absFile, segments, duration).catch(() => ({ spans: [], silenceTotal: 0, noAudio: false }));
  const brief = buildBrief({ duration, segments, language, ocrBlocks, caption, elapsed, nonSpeech, frames: framePaths.length, file: absFile });

  if (!CONFIG.pipeline.keepOutputs) {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { brief, frames: framePaths, meta: { duration, language, segmentCount: segments.length, ocrCount: ocrBlocks.length, elapsed } };
}

/** Voice notes / music files: transcription only. */
export async function transcribeAudio(file, { caption = "" } = {}) {
  return transcribeMedia(file, { ocr: false, frames: 0, caption });
}

// ------------------------------------------------------------------ brief

function mergeSpans(spans, maxGap = 1.2) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= maxGap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

async function analyseNonSpeech(file, segments, duration) {
  if (!duration) return { spans: [], silenceTotal: 0, noAudio: false };
  if (!(await hasAudio(file))) return { spans: [], silenceTotal: 0, noAudio: true };
  const speech = mergeSpans(segments.map((s) => [s.start, s.end]));
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of speech) {
    if (s - cursor > 0.4) gaps.push([cursor, Math.min(s, duration)]);
    cursor = Math.max(cursor, e);
  }
  if (duration - cursor > 0.4) gaps.push([cursor, duration]);
  if (!gaps.length) return { spans: [], silenceTotal: 0, noAudio: false };

  const silence = await silenceSpans(file);
  const spans = [];
  let silenceTotal = 0;
  for (const [gs, ge] of gaps) {
    const len = ge - gs;
    if (len <= 0) continue;
    let quiet = 0;
    for (const [ss, se] of silence) quiet += Math.max(0, Math.min(ge, se) - Math.max(gs, ss));
    const quietRatio = len ? quiet / len : 0;
    if (quietRatio > 0.6) silenceTotal += len;
    else spans.push([gs, ge]);
  }
  const merged = mergeSpans(spans, 1.5).filter(([s, e]) => e - s >= 2);
  return {
    spans: merged.slice(0, 8),
    silenceTotal,
    noAudio: false,
    speechTotal: speech.reduce((acc, [s, e]) => acc + (e - s), 0),
  };
}

function buildBrief({ duration, segments, language, ocrBlocks, caption, elapsed, nonSpeech = { spans: [], silenceTotal: 0 }, frames = 0, file }) {
  const hadSpeech = segments.length > 0;
  const lines = [];
  const kind = /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|wma)$/i.test(file) ? "audio" : "video";
  lines.push(`[local pipeline read this ${kind} for you · ${duration ? mmss(duration) : "unknown length"}${elapsed ? ` · processed in ${elapsed}s` : ""}]`);
  if (caption) lines.push(`His caption: "${truncate(caption, 300)}"`);

  // split whisper output: real speech vs [Music]/[Applause] style tags
  const musicTagged = segments.filter((s) => NON_SPEECH_TAG.test(s.text) || /♪/.test(s.text));
  const speech = segments.filter((s) => !musicTagged.includes(s));

  if (speech.length) {
    lines.push("");
    lines.push(`SPEECH TRANSCRIPT (whisper ASR${language ? `, language: ${language}` : ""} — machine transcription, may mishear words; this is the CONTENT):`);
    let budget = 4200;
    for (const s of speech) {
      const line = `  [${mmss(s.start)}-${mmss(s.end)}] ${s.text}`;
      if (budget - line.length < 0) { lines.push("  ... (transcript truncated)"); break; }
      budget -= line.length;
      lines.push(line);
    }
  } else if (kind === "video" || kind === "audio") {
    lines.push("");
    if (nonSpeech?.noAudio) {
      lines.push(kind === "video"
        ? "SPEECH TRANSCRIPT: this clip has no audio track at all (silent video) — only the visuals matter here."
        : "SPEECH TRANSCRIPT: this file has no audio stream that could be decoded.");
    } else {
      lines.push(kind === "audio"
        ? "SPEECH TRANSCRIPT: no recognised speech — this sounds like music, noise or an empty recording. Do not pretend you heard words; say you could not make anything out and ask him about it."
        : "SPEECH TRANSCRIPT: none detected — no clear speech in the audio.");
    }
  }

  if (ocrBlocks.length) {
    lines.push("");
    lines.push("ON-SCREEN TEXT (Tesseract OCR from frames — also content):");
    let budget = 2200;
    for (const b of ocrBlocks) {
      const line = `  [${b.stamp}] ${truncate(b.text, 220)}`;
      if (budget - line.length < 0) { lines.push("  ... (on-screen text truncated)"); break; }
      budget -= line.length;
      lines.push(line);
    }
  }

  if (musicTagged.length) {
    lines.push("");
    lines.push("NON-SPEECH / MUSIC (ASR tagged these as non-speech — soundtrack or noise, DECORATION, usually irrelevant):");
    for (const s of musicTagged.slice(0, 6)) {
      lines.push(`  [${mmss(s.start)}-${mmss(s.end)}] ${truncate(s.text, 120)}`);
    }
  }

  if (nonSpeech.spans?.length) {
    lines.push("");
    lines.push("MUSIC / NON-SPEECH AUDIO (audio energy with no recognised speech — soundtrack, beat, ambience; DECORATION, usually irrelevant):");
    for (const [s, e] of nonSpeech.spans) {
      lines.push(`  [${mmss(s)}-${mmss(e)}] non-speech audio, ${Math.round(e - s)}s`);
    }
    if (nonSpeech.silenceTotal > 3) lines.push(`  (plus ~${Math.round(nonSpeech.silenceTotal)}s of near-silence, ignored)`);
  }

  if (frames > 0) {
    lines.push("");
    lines.push(`${frames} frame(s) from the ${kind} are attached as images — those are real, react to what you see in them too.`);
  }

  lines.push("");
  lines.push("HOW TO READ THIS: speech transcript and on-screen text are what the video is actually about; react to those and to the attached frames. Music / non-speech parts are just the vibe — never invent meaning from them and never treat lyrics as a message for you. The ASR is machine-made, so do not quote it mechanically; talk like a person who watched it.");

  if (!hadSpeech && !ocrBlocks.length && !nonSpeech?.spans?.length) {
    lines.push("");
    lines.push("NOTE: the pipeline found neither clear speech nor on-screen text here — if the attached frames do not make it obvious what it is, ask him what it was or what happens in it.");
  }

  return lines.join("\n");
}

export function cleanup(paths = []) {
  for (const p of paths) {
    try { if (p) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

/** Remove stale temp files (crashes, killed processes) so data/tmp never grows forever. */
export function sweepTmp(maxAgeMs = 12 * 3600 * 1000) {
  let removed = 0;
  try {
    const now = Date.now();
    for (const entry of fs.readdirSync(PATHS.tmp)) {
      const full = path.join(PATHS.tmp, entry);
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}
