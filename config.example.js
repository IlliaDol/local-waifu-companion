// Negev-chan configuration.
//
// Setup:  copy this file to config.js  (it is gitignored - your real settings
// and secrets never leave the machine) and fill in the two secrets, either
// here or through .env / the environment:
//   DEEPSEEK_API_KEY   - platform.deepseek.com
//   NEGEV_BOT_TOKEN    - @BotFather
// Every key below is optional-safe: the ones the bot really needs are the
// secrets; everything else ships with a sane default.

const USE_ENV = (name, fallback = "") => process.env[name] || fallback;

export const CONFIG = {
  // ---- secrets (env wins over nothing: put them in .env, not here) ----------
  deepseekKey: USE_ENV("DEEPSEEK_API_KEY"),
  botToken: USE_ENV("NEGEV_BOT_TOKEN"),

  // ---- model ----------------------------------------------------------------
  // One fixed non-reasoning model for every call. There is no fallback and no
  // per-message override on purpose - see deepseek.js.
  model: "deepseek-v4-flash",
  thinking: { type: "disabled" },
  botName: "Negev",
  timezone: "Europe/Berlin", // her whole life runs on this clock

  // ---- reply shape ----------------------------------------------------------
  replyMaxTokens: 280, // keeps replies short and cheap
  maxOutputTokens: 320, // hard ceiling for any call
  proactiveMaxTokens: 100, // her own spontaneous texts are one-liners
  imageDetail: "low", // vision: cheap, enough for "what is in this photo"
  visionMaxImages: 2, // max photos/frames sent to the model per message
  contextMessages: 16, // recent chat turns sent per reply
  historyKeep: 400, // turns stored in history.json

  // ---- her day (schedule) ---------------------------------------------------
  schedule: {
    slotsMin: 6, // spontaneous texts per day (min)
    slotsMax: 9, // ...and max
    minGapMin: 35, // smallest gap between her own texts
    wakeHour: 8, // earliest she ever texts first
    activeConversationMin: 15, // after a reply, this many minutes cannot be ignored
    forceAwakeMin: 10, // /force keeps her awake at least this long
    forceAwakeMax: 15, // ...and at most
    maxUnansweredInitiations: 4,
    userActiveWindowMin: 20, // "he is clearly at the keyboard" window
    doubleTextAfterH: 2, // left-on-read double text after this many hours
  },

  // ---- memory ---------------------------------------------------------------
  memory: {
    keepSummary: true, // compress old chat into a rolling summary
    conversationHours: 36, // ordinary chat is forgotten after this
    dayCardsKeep: 1, // day cards kept in her prompt (today + yesterday)
  },

  // ---- local media pipeline (video/voice) ------------------------------------
  // Optional. Without it, videos degrade to still frames and voice notes are
  // transcribed only if whisper exists; photos always work (DeepSeek vision).
  pipeline: {
    enabled: true,
    dir: USE_ENV("NEGEV_PIPELINE_DIR"), // your whisper-pipeline folder
    defaultDir: USE_ENV("NEGEV_PIPELINE_DIR"), // first existing wins
    bundleDir: "",
    model: USE_ENV("NEGEV_WHISPER_MODEL", "turbo"),
    lang: USE_ENV("NEGEV_WHISPER_LANG", "auto"),
    ocr: true,
    ocrLangs: USE_ENV("NEGEV_OCR_LANGS", "deu+eng"),
    ocrMax: 12,
    videoFrames: 2,
    timeoutMs: 300000,
    keepOutputs: false,
  },

  // ---- links / social posts ---------------------------------------------------
  social: {
    enabled: true,
    maxLinks: 3,
    maxReadsPerDay: 8, // web-reader budget per Dortmund day
    maxReadsPerHour: 3,
    minReadIntervalMs: 30000,
    timeoutMs: 15000,
    textLimit: 6000,
    maxMediaBytes: 30 * 1024 * 1024,
  },

  // ---- her data-science senpai mode -------------------------------------------
  dataScience: {
    enabled: true, // needs roadmaps/ (or NEGEV_DS_ROADMAP_DIR) to have files
    roadmapDir: USE_ENV("NEGEV_DS_ROADMAP_DIR"), // default: ./roadmaps
    proactiveShare: 0.45, // share of her own texts that may touch the topic
  },

  // ---- her own photos (data/her-photos/) ---------------------------------------
  photos: {
    dir: USE_ENV("NEGEV_PHOTO_DIR"), // default: data/her-photos
  },

  // ---- optional local voice notes (piper / espeak-ng + opus) -------------------
  voice: {
    enabled: false, // opt-in
    bin: USE_ENV("NEGEV_TTS_BIN"),
    model: USE_ENV("NEGEV_TTS_MODEL"),
    maxChars: 160,
  },

  // ---- tuning overrides ---------------------------------------------------------
  // Any key here overrides TIMING_DEFAULTS in timing.js (reaction odds, wait
  // windows). Leave empty to use the measured defaults.
  human: {},
};

// Where her memory lives, relative to the project folder.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, "data"),
  state: path.join(ROOT, "data", "state.json"),
  history: path.join(ROOT, "data", "history.json"),
  tmp: path.join(ROOT, "data", "tmp"),
};
