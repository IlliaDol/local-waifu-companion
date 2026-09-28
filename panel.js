// The operator's control panel - localhost, by the bot process, zero deps.
//
// What the Telegram chat could never give: the whole machine in real time.
// Status, mood, spend, her day plan, her memory - read live; her character
// (bio, hobbies, extra persona), the affection dial, proactive hours, quiet
// mode, and the model caps - changeable on the fly; her raw log tail; and a
// plain chat that drops words straight into her queue like they came from the
// real chat.
//
// Bound to 127.0.0.1 only: never exposed beyond this machine. No auth because
// there is no remote surface; set NEGEV_PANEL_PORT=0 to disable entirely.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, PATHS } from "./config.js";
import * as mem from "./memory.js";
import * as mood from "./mood.js";
import * as signal from "./signal.js";
import * as bond from "./bond.js";
import * as usage from "./usage.js";
import * as tasks from "./tasks.js";
import * as identity from "./identity.js";
import * as weather from "./weather.js";
import * as settings from "./settings.js";
import { currentModel } from "./deepseek.js";
import { nowBerlin, log, logErr, truncate } from "./util.js";
import { describe as sleepDescribe, isAsleepAt, minutesSinceWaking } from "./sleep.js";
import { busySummary, currentWindow } from "./proactive.js";
import { herNight, herMood, handlePanelText, activeConversation } from "./bot-internals.js";

const PORT = Number(process.env.NEGEV_PANEL_PORT ?? 8765);
const LOG_LINES = 200;
let server = null;

// ------------------------------------------------------------------ helpers

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function tail(file, lines = LOG_LINES) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}

function readStats(state) {
  const total = usage.totals();
  const day = state.dayStats?.[nowBerlin().dateStr] || {};
  return {
    calls: total.totals?.calls || 0,
    todayCalls: total.today?.calls || 0,
    todayCost: total.today?.cost || 0,
    totalCost: total.totals?.cost || 0,
    balance: total.balance ?? null,
    lastReply: total.replies?.length ? total.replies[total.replies.length - 1] : null,
  };
}

// ------------------------------------------------------------------ API

export async function apiStatus() {
  const st = mem.state;
  const t = nowBerlin();
  const m = mood.currentMood(st) || herMood({ t });
  const sched = herNight();
  const bd = bond.view(st);
  const stage = bond.stageOf(st);
  const dayStats = st.dayStats?.[t.dateStr] || {};
  return {
    now: `${t.weekdayName} ${t.hhmm}`,
    model: currentModel(),
    owner: st.ownerId ? `bound (${st.ownerName || "commander"})` : "not bound yet",
    mood: {
      key: m.key,
      label: m.def?.label || m.key,
      why: m.why || "",
      since: t.hhmm,
      hoursLeft: Math.max(0, Math.round(((m.until || 0) - Date.now()) / 60000)),
    },
    conversation: st.tone?.key ? st.tone.key : "ordinary chat",
    reading: signal.describe(st),
    sleep: {
      awake: !isAsleepAt(sched, t),
      window: sleepDescribe(sched),
      wokeMinsAgo: minutesSinceWaking(sched, t, 600),
    },
    busy: busySummary(),
    busyWindowNow: currentWindow(t) ? currentWindow(t).activity : null,
    schedule: {
      pending: tasks.pendingCount(),
      items: tasks.listTasks().slice(0, 10).map((x) => ({ what: x.what, date: x.date, whenMin: x.whenMin, kind: x.kind })),
    },
    bond: {
      days: bd.days,
      stage: stage.label,
      closeness: Number(bond.closeness(st).toFixed(2)),
      ourThings: bd.ourThings,
      truthsTold: (st.bond?.told || []).length,
      repairs: bd.repairs,
      openTension: bd.arc ? `${bd.arc.kind} since ${bd.arc.since}` : null,
    },
    memory: {
      turns: mem.history.length,
      facts: (st.facts || []).length,
      hasSummary: Boolean(st.summary),
      mediaRemembered: (st.mediaLog || []).length,
      unanswered: mem.unansweredCount(),
    },
    weather: weather.current() ? `${weather.current().desc}, ${weather.current().temp}C` : null,
    herLife: {
      favorites: identity.ensure().favorites,
      places: identity.ensure().places,
      hobbies: identity.ensure().hobbies,
    },
    activity: { hisMsgsToday: dayStats.his || 0, herMsgsToday: dayStats.hers || 0 },
  };
}

export async function apiSpend() {
  const t = usage.totals();
  const balance = await usage.accountBalance().catch(() => null);
  return {
    today: t.today,
    total: t.totals || { calls: 0, prompt: 0, completion: 0, cost: 0 },
    days: Object.entries(t.days || {}).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 7)
      .map(([date, d]) => ({ date, calls: d.calls, cost: d.cost })),
    lastReplies: (t.replies || []).slice(-12).reverse().map((r) => ({
      at: r.at, kind: r.kind, calls: r.calls, prompt: r.prompt, completion: r.completion, cost: r.cost,
    })),
    balance: balance ? (balance.currency === "USD" ? `$${Number(balance.total).toFixed(2)}` : `${Number(balance.total).toFixed(2)} ${balance.currency || ""}`.trim()) : null,
  };
}

export async function apiMemory() {
  const st = mem.state;
  return {
    facts: st.facts || [],
    canon: st.herCanon || [],
    summary: st.summary || "",
    promises: (st.promises || []).map((p) => ({ by: p.by, text: p.text, done: p.done })),
    threads: {
      openQuestions: (st.openQuestions || []).slice(-6).map((q) => q.text),
      dropped: (st.dropped || []).slice(-6).map((d) => d.text),
    },
  };
}

/**
 * Edit her head directly from the panel: add facts (the same ledger the fact
 * pass fills), pin one from plain words ("remember that my exam is on monday"
 - same parser as chat), or delete one by text. The summary is editable too.
 * No model call anywhere: these are memory operations, applied at once.
 */
export async function apiMemoryEdit(body = {}) {
  const st = mem.state;
  const added = [];
  const removed = [];
  const pinned = [];
  if (typeof body.summary === "string") {
    st.summary = body.summary.trim().slice(0, 1200);
  }
  for (const raw of [].concat(body.add || [])) {
    const fact = String(raw || "").replace(/\s+/g, " ").trim();
    if (fact.length < 3) continue;
    mem.addFacts([fact]);
    added.push(fact);
  }
  for (const raw of [].concat(body.remove || [])) {
    const needle = String(raw || "").trim();
    if (!needle) continue;
    if (mem.forgetFact(needle)) removed.push(needle);
  }
  if (typeof body.pin === "string" && body.pin.trim()) {
    const facts = mem.parseRemember(body.pin);
    if (facts?.length) {
      mem.addFacts(facts);
      pinned.push(...facts);
    }
  }
  if (added.length || removed.length || pinned.length || typeof body.summary === "string") mem.save();
  return { ok: true, added, removed, pinned };
}

export async function apiSettings() {
  return { settings: settings.get(), file: settings.file() };
}

export async function apiSaveSettings(body) {
  const before = JSON.stringify(settings.get());
  settings.update(body || {});
  const after = settings.get();
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { ok: true, changed, settings: after };
}

export async function apiLog() {
  return { tail: tail(path.join(PATHS.data, "negev.log")) };
}

export async function apiChat(body) {
  const text = String(body?.text || "").trim();
  if (!text) return { ok: false, error: "empty" };
  const result = await handlePanelText(text);
  return { ok: true, queued: result };
}

// ------------------------------------------------------------------ page

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Negev-chan panel</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#161b22;border-bottom:1px solid #21262d;position:sticky;top:0;z-index:5}
header h1{font-size:16px;margin:0;font-weight:600}
header .pill{font-size:11px;padding:2px 10px;border-radius:999px;background:#21262d;color:#8b949e}
main{max-width:1200px;margin:0 auto;padding:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
section{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px}
section h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kv{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:8px 10px}
.kv b{display:block;font-size:11px;color:#8b949e;font-weight:500;text-transform:uppercase;letter-spacing:.05em}
.kv span{font-size:15px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:10px;max-height:340px;overflow:auto}
textarea,input[type=text],input[type=number],select{width:100%;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:8px 10px;font:inherit}
textarea{min-height:70px;resize:vertical}
label{display:block;font-size:12px;color:#8b949e;margin:10px 0 4px}
button{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
button.ghost{background:#21262d;border-color:#30363d;color:#e6edf3;font-weight:500}
button.danger{background:#b62324;border-color:#da3633}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hobby{display:flex;gap:6px;margin-bottom:6px}
.hobby input{flex:1}
.stat{font-size:22px;font-weight:700}
.small{font-size:12px;color:#8b949e}
.ok{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}
#toast{position:fixed;bottom:18px;right:18px;background:#238636;color:#fff;padding:10px 16px;border-radius:8px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
.flash{animation:pulse 1.2s ease-out}
@keyframes pulse{0%{background:#1f6feb33}100%{background:transparent}}
</style></head>
<body>
<header><h1>Negev-chan</h1><span class="pill" id="model"></span><span class="pill" id="bound"></span><span class="pill" id="clock"></span><span class="pill" id="alive"></span></header>
<main>
<section><h2>Right now</h2><div class="grid" id="live"></div></section>
<section><h2>Spend</h2><div class="grid" id="spend"></div><div class="small" id="balance"></div><div class="mono" id="lastreplies" style="margin-top:8px"></div></section>
<section><h2>Her day / sleep / schedule</h2><div class="mono" id="dayplan"></div></section>
<section><h2>The relationship</h2><div class="mono" id="bond"></div></section>
<section><h2>Her head (memory) — editable</h2>
  <label>Add a fact about him (one per line)</label>
  <textarea id="m-add" placeholder="drinks his coffee black\nis moving flats in spring"></textarea>
  <label>…or pin from plain words (same parser as chat)</label>
  <input type="text" id="m-pin" placeholder="remember that my exam is on monday"/>
  <div class="row" style="margin-top:8px">
    <button id="memsave">Save changes</button>
    <button class="ghost" id="memreload">Reload</button>
    <span class="small" id="memstate"></span>
  </div>
  <label style="margin-top:12px">Facts she keeps — x removes</label>
  <div id="faclist" class="mono" style="max-height:260px"></div>
  <label>Conversation summary (older chat, compressed)</label>
  <textarea id="m-summary"></textarea>
</section>
<section><h2>Her character — live</h2>
  <label>Name</label><input type="text" id="c-name"/>
  <label>City she lives in</label><input type="text" id="c-city"/>
  <label>Extra character notes (added to her persona, your words)</label>
  <textarea id="c-bio" placeholder="e.g. you recently got into bouldering; you are saving for a camera"></textarea>
  <label>Hobbies</label><div id="hobbies"></div><button class="ghost" id="addhobby">+ hobby</button>
  <label>Affection dial — 0 = none of her soft marks, 1 = tuned default, up to 1.6</label>
  <input type="number" id="c-aff" step="0.05" min="0" max="1.6"/>
  <label>Spontaneous texts per day (min / max)</label>
  <div class="row"><input type="number" id="c-pmin" min="0" max="24" style="width:90px"/><span>…</span><input type="number" id="c-pmax" min="0" max="30" style="width:90px"/>
  <button class="ghost" id="resched">re-roll today's schedule</button></div>
  <div class="row" style="margin-top:12px"><button id="savechar">Save character</button><span class="small" id="charsaved"></span></div>
</section>
<section><h2>Runtime</h2>
  <label>Reply token cap (blank = default)</label><input type="number" id="r-tokens" min="60" max="320"/>
  <label>Temperature bias (-0.3 … +0.3)</label><input type="number" id="r-temp" step="0.05" min="-0.3" max="0.3"/>
  <label>Quiet mode (she will not text first)</label>
  <div class="row"><button class="ghost" id="q1">1h</button><button class="ghost" id="q4">4h</button><button class="ghost" id="q12">12h</button><button class="ghost" id="q0">off</button><span class="small" id="qstate"></span></div>
  <div class="row" style="margin-top:12px"><button id="saverun">Save runtime</button><button class="danger" id="resetmem">Wipe her memory</button></div>
  <div class="small" id="runsaved"></div>
</section>
<section><h2>Say something as him (drops into her queue)</h2>
  <div class="row"><input type="text" id="chatin" placeholder="hey, what are you up to?"/><button id="chatsend">Send</button></div>
  <div class="small">She answers on Telegram as if he typed it. The reply also lands here when it is ready.</div>
  <div class="mono" id="chatout" style="margin-top:8px;max-height:200px"></div>
</section>
<section style="grid-column:1/-1"><h2>Her log (live tail)</h2><div class="mono" id="log" style="max-height:420px"></div></section>
</main>
<div id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
const toast = (m) => { const t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1600); };
async function api(path, body) {
  const res = await fetch("/api/" + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function kv(label, value, cls = "") { return '<div class="kv"><b>' + label + '</b><span class="' + cls + '">' + value + "</span></div>"; }
let hobbies = [];
function renderHobbies() {
  $("hobbies").innerHTML = hobbies.map((h, i) =>
    '<div class="hobby"><input type="text" data-i="' + i + '" data-k="key" value="' + (h.key || "") + '" placeholder="gym"/><input type="text" data-i="' + i + '" data-k="detail" value="' + (h.detail || "") + '" placeholder="leg day, twice a week"/><button class="ghost" data-del="' + i + '">x</button></div>').join("");
  $("hobbies").querySelectorAll("input").forEach((el) => el.oninput = () => { hobbies[+el.dataset.i][el.dataset.k] = el.value; });
  $("hobbies").querySelectorAll("[data-del]").forEach((el) => el.onclick = () => { hobbies.splice(+el.dataset.del, 1); renderHobbies(); });
}
let charLoaded = false, lastSettings = "";
async function tick() {
  try {
    const [s, p, log, set, memApi] = await Promise.all([api("status"), api("spend"), api("log"), api("settings"), api("memory")]);
    $("model").textContent = s.model; $("bound").textContent = s.owner; $("clock").textContent = s.now;
    $("alive").textContent = s.sleep.awake ? "awake" : "asleep";
    $("alive").className = "pill " + (s.sleep.awake ? "ok" : "");
    $("live").innerHTML =
      kv("mood", s.mood.label + (s.mood.why ? " — " + s.mood.why : ""), "ok") +
      kv("conversation", s.conversation) +
      kv("sleep", s.sleep.awake ? (s.sleep.wokeMinsAgo != null ? "up " + s.sleep.wokeMinsAgo + "m ago" : "awake") : s.sleep.window) +
      kv("busy", s.busyWindowNow ? "in a busy window: " + s.busyWindowNow : s.busy) +
      kv("weather", s.weather || "—") +
      kv("messages today", (s.activity.hisMsgsToday || 0) + " him / " + (s.activity.hersMsgsToday || 0) + " her") +
      kv("reading him", s.reading.length > 60 ? s.reading.slice(0, 60) + "…" : s.reading) +
      kv("memory", s.memory.turns + " turns · " + s.memory.facts + " facts" + (s.memory.unanswered ? " · " + s.memory.unanswered + " unanswered" : ""));
    $("spend").innerHTML =
      kv("today", "$" + (p.today.cost || 0).toFixed(4) + " · " + (p.today.calls || 0) + " calls") +
      kv("total", "$" + (p.total.cost || 0).toFixed(4) + " · " + p.total.calls + " calls");
    $("balance").textContent = p.balance ? "DeepSeek balance: " + p.balance : "";
    $("lastreplies").textContent = p.lastReplies.map((r) => new Date(r.at).toTimeString().slice(0, 5) + "  " + (r.kind || "reply") + "  $" + (r.cost || 0).toFixed(5)).join("\\n");
    $("dayplan").textContent =
      "schedule: " + s.schedule.pending + " thing(s) she is holding\\n" +
      s.schedule.items.map((x) => "  " + x.date + " " + String(Math.floor((x.whenMin || 0) / 60)).padStart(2, "0") + ":" + String((x.whenMin || 0) % 60).padStart(2, "0") + "  " + x.what).join("\\n") +
      "\\nher night: " + s.sleep.window + "\\nbusy now: " + (s.busyWindowNow || "no");
    $("bond").textContent =
      s.bond.days + " day(s) · stage: " + s.bond.stage + " · closeness " + s.bond.closeness + "\\n" +
      "shared: " + (s.bond.ourThings.join(" | ") || "(none yet)") + "\\n" +
      "truths told: " + s.bond.truthsTold + " · repairs: " + s.bond.repairs + "\\n" +
      "open tension: " + (s.bond.openTension || "none");
    // promises + off-limits ride under the facts list
    $("memstate").dataset.promises = (memApi.promises || []).map((x) => "[" + x.by + "] " + (x.done ? "done: " : "") + x.text).join(" | ") || "";
    $("log").textContent = log.tail;
    // memory editor: keep the list in sync unless the user is mid-edit (focused)
    if (document.activeElement === document.body || document.activeElement === null) {
      renderFacts(memApi.facts || []);
      if (document.activeElement !== $("m-summary")) $("m-summary").value = memApi.summary || "";
    }
    // character form: fill once, then only when the file changed underneath us
    const setJson = JSON.stringify(set.settings);
    if (!charLoaded || setJson !== lastSettings) {
      const c = set.settings.character;
      $("c-name").value = c.name; $("c-city").value = c.city; $("c-bio").value = c.bioExtra || "";
      $("c-aff").value = set.settings.affection.level;
      $("c-pmin").value = set.settings.proactive.min; $("c-pmax").value = set.settings.proactive.max;
      $("r-tokens").value = set.settings.replyMaxTokens || ""; $("r-temp").value = set.settings.temperatureBias;
      hobbies = (c.hobbies || []).slice(); renderHobbies();
      charLoaded = true; lastSettings = setJson;
    }
    const q = set.settings.quietUntil;
    $("qstate").textContent = q > Date.now() ? "until " + new Date(q).toTimeString().slice(0, 5) : "off";
  } catch (e) { $("alive").textContent = "panel error"; console.error(e); }
}
$("addhobby").onclick = () => { hobbies.push({ key: "", detail: "" }); renderHobbies(); };
let factsNow = [];
function renderFacts(facts) {
  factsNow = facts;
  $("faclist").innerHTML = facts.length
    ? facts.map((f, i) => '<div>· ' + f.replace(/&/g, "&amp;").replace(/</g, "&lt;") + ' <button class="ghost" data-fact="' + i + '" style="padding:0 6px;font-size:11px">x</button></div>').join("")
    : "(nothing yet)";
  $("faclist").querySelectorAll("[data-fact]").forEach((el) => el.onclick = () => {
    factsNow.splice(+el.dataset.fact, 1);
    renderFacts(factsNow);
  });
}
$("memreload").onclick = () => tick();
$("memsave").onclick = async () => {
  const add = $("m-add").value.split("\\n").map((s) => s.trim()).filter(Boolean);
  const r = await api("memory", {
    add,
    pin: $("m-pin").value.trim(),
    summary: $("m-summary").value,
  });
  $("m-add").value = ""; $("m-pin").value = "";
  $("memstate").textContent = "saved " + new Date().toTimeString().slice(0, 5) + (r.added.length ? " · +" + r.added.length : "");
  toast("her memory updated — she just knows it now");
  tick();
};
$("savechar").onclick = async () => {
  const hobbiesClean = hobbies.filter((h) => h.key && h.key.trim());
  await api("settings", { character: { name: $("c-name").value, city: $("c-city").value, bioExtra: $("c-bio").value, hobbies: hobbiesClean }, affection: { level: parseFloat($("c-aff").value) || 1 }, proactive: { min: parseInt($("c-pmin").value) || 0, max: parseInt($("c-pmax").value) || 0 } });
  $("charsaved").textContent = "saved " + new Date().toTimeString().slice(0, 5); toast("character saved — live on her next reply");
};
$("saverun").onclick = async () => {
  await api("settings", { replyMaxTokens: $("r-tokens").value ? parseInt($("r-tokens").value) : null, temperatureBias: parseFloat($("r-temp").value) || 0 });
  $("runsaved").textContent = "saved"; toast("runtime saved");
};
for (const [id, h] of [["q1", 1], ["q4", 4], ["q12", 12]]) $(id).onclick = async () => { await api("settings", { quietUntil: Date.now() + h * 3600000 }); toast("quiet " + h + "h"); tick(); };
$("q0").onclick = async () => { await api("settings", { quietUntil: 0 }); toast("quiet off"); tick(); };
$("resched").onclick = async () => { const r = await api("resched", {}); toast(r.ok ? "today's schedule re-rolled" : "failed"); };
$("resetmem").onclick = async () => {
  if (!confirm("Wipe her memory of you? History, facts, summary — everything except the binding.")) return;
  await api("reset", {}); toast("memory wiped"); tick();
};
$("chatsend").onclick = sendChat;
$("chatin").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
async function sendChat() {
  const text = $("chatin").value.trim(); if (!text) return;
  $("chatin").value = "";
  const r = await api("chat", { text });
  $("chatout").textContent += "you: " + text + "\\n" + (r.ok ? "(queued — she will react on her own timing)" : "(failed: " + (r.error || "?") + ")") + "\\n";
}
setInterval(tick, 5000); tick();
</script>
</body></html>`;

export function startPanel() {
  if (PORT === 0 || server) return;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(PAGE);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        let body = "";
        for await (const chunk of req) body += chunk;
        return json(res, 200, await apiSaveSettings(JSON.parse(body || "{}")));
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        let body = "";
        for await (const chunk of req) body += chunk;
        return json(res, 200, await apiChat(JSON.parse(body || "{}")));
      }
      if (req.method === "POST" && url.pathname === "/api/resched") {
        const { rerollSchedule } = await import("./bot-internals.js");
        return json(res, 200, { ok: await rerollSchedule() });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        mem.resetMemory();
        log("[panel] memory wiped from the control panel");
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, await apiStatus());
      if (req.method === "GET" && url.pathname === "/api/spend") return json(res, 200, await apiSpend());
      if (req.method === "GET" && url.pathname === "/api/memory") return json(res, 200, await apiMemory());
      if (req.method === "POST" && url.pathname === "/api/memory") {
        let body = "";
        for await (const chunk of req) body += chunk;
        return json(res, 200, await apiMemoryEdit(JSON.parse(body || "{}")));
      }
      if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, await apiSettings());
      if (req.method === "GET" && url.pathname === "/api/log") return json(res, 200, await apiLog());
      json(res, 404, { error: "not found" });
    } catch (err) {
      logErr("[panel] request failed:", err.message);
      json(res, 500, { error: err.message });
    }
  });
  // A taken port must never take her down with it. Another copy of her, or any
  // other app already on 8765, used to raise an uncaught EADDRINUSE and kill the
  // whole process - which is exactly what a preview run against a live instance did.
  const srv = server;
  srv.on("error", (err) => {
    logErr(`[panel] cannot listen on 127.0.0.1:${PORT} (${err.code || err.message}) - the panel stays off, she carries on`);
    if (server === srv) server = null;
  });
  srv.listen(PORT, "127.0.0.1", () => {
    log(`[panel] control panel live at http://127.0.0.1:${PORT} (localhost only)`);
  });
}

export function stopPanel() {
  if (server) server.close();
  server = null;
}
