// Local data-science roadmap memory.
//
// The two roadmap files are deliberately read from disk instead of copied into
// every prompt. All of their material is indexed locally, then only a few
// relevant chunks are attached to a technical reply. This keeps the teaching
// broad without wasting model input tokens or using the web reader.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

// Drop your own roadmap files into ./roadmaps/ (or point NEGEV_DS_ROADMAP_DIR
// anywhere) and she teaches from them; with the folder empty the whole feature
// quietly stays off.
const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "roadmaps");
const ROADMAP_DIR = process.env.NEGEV_DS_ROADMAP_DIR || CONFIG.dataScience?.roadmapDir || DEFAULT_DIR;
const FILES = [
  { name: "complete topic index", file: path.join(ROADMAP_DIR, "data-science-roadmap-all-topics.md") },
  { name: "improved roadmap", file: path.join(ROADMAP_DIR, "data-science-roadmap-improved.html") },
];

const STOP = new Set(
  "the a an and or but of to in on at is are was were be am i you he she it my your me we they us for with about that this these those from into over under what how why when where which who can could should would do does did have has had will just very more most some any all this its their there here then than not no only one two three own your his her our roadmap module topic source material guide course free data science".split(" "),
);

let cached = null;
// Skip the generic cover/introduction chunks when unsolicited messages rotate
// through the roadmap; the first cue should contain an actual subject.
let cursor = 5;

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x2F;|&#47;/g, "/");
}

function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, "\n## $2\n")
    .replace(/<br\s*\/?>(?=.)/gi, "\n")
    .replace(/<\/p>|<\/li>|<\/div>|<\/section>|<\/article>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "");
}

function plainLine(line) {
  return decodeEntities(String(line || ""))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(line, fallback) {
  const md = line.match(/^#{1,6}\s+(.+)$/);
  return md ? plainLine(md[1]) : fallback;
}

function terms(text) {
  return [...new Set((String(text || "").toLowerCase().match(/[a-z0-9+#.-]{2,}/g) || [])
    .filter((w) => !STOP.has(w)))];
}

function makeChunks(raw, source) {
  const chunks = [];
  let title = source;
  let lines = [];
  let chars = 0;

  const flush = () => {
    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= 40) chunks.push({ source, title, text });
    lines = [];
    chars = 0;
  };

  for (const rawLine of String(raw || "").split("\n")) {
    const h = titleOf(rawLine.trim(), null);
    if (h && /^#{1,6}\s+/.test(rawLine.trim())) {
      flush();
      title = h;
      continue;
    }
    const line = plainLine(rawLine);
    if (!line) {
      if (chars > 850) flush();
      continue;
    }
    if (chars + line.length + 1 > 1150) flush();
    lines.push(line);
    chars += line.length + 1;
  }
  flush();
  return chunks;
}

function load() {
  if (cached) return cached;
  const chunks = [];
  const sources = [];
  for (const item of FILES) {
    try {
      const raw = fs.readFileSync(item.file, "utf8");
      const text = item.file.toLowerCase().endsWith(".html") ? htmlToText(raw) : raw;
      const made = makeChunks(text, item.name);
      chunks.push(...made);
      sources.push({ name: item.name, file: item.file, chunks: made.length, bytes: raw.length });
    } catch {
      sources.push({ name: item.name, file: item.file, chunks: 0, bytes: 0, missing: true });
    }
  }
  // The HTML intentionally repeats some of the Markdown. Exact duplicate
  // chunks do not teach her anything new and would only spend input tokens.
  const seen = new Set();
  const unique = chunks.filter((chunk) => {
    const key = chunk.text.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 500);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  cached = { chunks: unique, sources };
  return cached;
}

function search(query, limit = 4) {
  const db = load();
  const want = terms(query);
  if (!want.length) return [];
  const scored = db.chunks.map((chunk, index) => {
    const hay = `${chunk.title} ${chunk.text}`.toLowerCase();
    const title = chunk.title.toLowerCase();
    let score = 0;
    for (const term of want) {
      if (title.includes(term)) score += 16;
      if (hay.includes(term)) score += 4;
    }
    return { chunk, score: score + index / 100000 };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.chunk);
}

function rotating(limit = 3) {
  const db = load();
  if (!db.chunks.length) return [];
  const out = [];
  for (let i = 0; i < Math.min(limit, db.chunks.length); i += 1) {
    out.push(db.chunks[(cursor + i) % db.chunks.length]);
  }
  cursor = (cursor + limit) % db.chunks.length;
  return out;
}

function clip(text, max) {
  const value = String(text || "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** Relevant local roadmap notes for a data-science prompt. */
export function contextFor(query, { maxChars = 4200, limit = 4, rotate = false } = {}) {
  const hits = search(query, limit);
  const selected = hits.length ? hits : (rotate ? rotating(Math.min(limit, 3)) : []);
  if (!selected.length) return "";
  let used = 0;
  const lines = ["LOCAL DATA-SCIENCE ROADMAP NOTES (internal files, no web lookup):"];
  const perChunk = Math.max(500, Math.floor((maxChars - lines[0].length) / selected.length) - 40);
  for (const item of selected) {
    const piece = `- ${item.title} [${item.source}]: ${clip(item.text, perChunk)}`;
    if (used + piece.length > maxChars) break;
    lines.push(piece);
    used += piece.length;
  }
  return lines.join("\n");
}

/** A small subject for an unsolicited message; it rotates through all indexed material. */
export function proactiveCue() {
  const item = rotating(1)[0];
  if (!item) return "";
  return `(Internal: you have been thinking about ${item.title}. Bring up one small, concrete data-science thought from this local roadmap note, naturally and low-key — no lecture unless he engages: ${clip(item.text, 700)})`;
}

export function status() {
  const db = load();
  return { directory: ROADMAP_DIR, sources: db.sources, chunks: db.chunks.length };
}
