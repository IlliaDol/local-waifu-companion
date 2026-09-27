// What every reply actually cost.
//
// DeepSeek returns usage on each completion (prompt tokens, output tokens, and
// how much of the prompt was served from their cache), so this keeps a ledger:
// one bucket per reply she sends, plus a running total. `!token` (as a reply to
// one of her messages) prints a bucket, `!tokenall` prints the totals.
//
// Cost is computed at the rates on https://api-docs.deepseek.com/quick_start/pricing/
// and peak hours count double: peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri.
import { CONFIG } from "./config.js";
import { state, save, saveSoon } from "./memory.js";
import { nowBerlin } from "./util.js";

// USD per 1M tokens, OFF-PEAK. Peak = double.
const RATES = {
  // Keep the old label only for pricing already stored in the local ledger;
  // active requests are hard-locked to CONFIG.model.
  "deepseek-flash": { hit: 0.003, miss: 0.15, out: 0.6 },
  "deepseek-v4-flash": { hit: 0.003, miss: 0.15, out: 0.6 },
  "deepseek-v4-pro": { hit: 0.022, miss: 0.66, out: 1.98 },
  "deepseek-chat": { hit: 0.028, miss: 0.28, out: 0.42 },
  "deepseek-reasoner": { hit: 0.028, miss: 0.28, out: 0.42 },
};
const FALLBACK_RATES = RATES["deepseek-v4-flash"];
const REPLY_KEEP = 80;

export function isPeak(at = Date.now()) {
  const d = new Date(at);
  const day = d.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function ratesFor(model, at = Date.now()) {
  const base = RATES[model] || FALLBACK_RATES;
  const mult = isPeak(at) ? 2 : 1;
  return { hit: base.hit * mult, miss: base.miss * mult, out: base.out * mult, peak: mult === 2 };
}

function freshTotals() {
  return { calls: 0, prompt: 0, completion: 0, hit: 0, miss: 0, cost: 0 };
}

function ensure() {
  if (!state.usage || typeof state.usage !== "object") {
    state.usage = { since: Date.now(), lastAt: 0, totals: freshTotals(), days: {}, replies: [] };
  }
  const u = state.usage;
  u.totals = { ...freshTotals(), ...(u.totals || {}) };
  u.days = u.days || {};
  u.replies = Array.isArray(u.replies) ? u.replies : [];
  return u;
}

let currentKey = null;
let seq = 0;

function splitUsage(raw = {}) {
  const prompt = Number(raw.prompt_tokens || 0);
  const completion = Number(raw.completion_tokens || 0);
  let hit = Number(raw.prompt_cache_hit_tokens ?? raw.cache_hit_tokens ?? 0);
  let miss = Number(raw.prompt_cache_miss_tokens ?? raw.cache_miss_tokens ?? 0);
  if (!hit && !miss && prompt) miss = prompt; // no cache info: assume nothing was cached
  return { prompt, completion, hit, miss };
}

function price(parts, model, at) {
  const r = ratesFor(model, at);
  return (parts.hit * r.hit + parts.miss * r.miss + parts.completion * r.out) / 1e6;
}

function addTo(target, parts, cost) {
  target.calls += 1;
  target.prompt += parts.prompt;
  target.completion += parts.completion;
  target.hit += parts.hit;
  target.miss += parts.miss;
  target.cost += cost;
}

/** A new reply starts: everything the model does for it lands in one bucket. */
export function begin(meta = {}) {
  const u = ensure();
  seq += 1;
  const key = `${Date.now().toString(36)}-${seq}`;
  const bucket = {
    key,
    at: Date.now(),
    kind: meta.kind || "reply",
    model: null,
    calls: 0,
    prompt: 0,
    completion: 0,
    hit: 0,
    miss: 0,
    cost: 0,
    kinds: {},
    ids: [],
  };
  if (meta.kind && meta.kind !== "reply") bucket.kinds[meta.kind] = 1;
  u.replies.push(bucket);
  while (u.replies.length > REPLY_KEEP) u.replies.shift();
  currentKey = key;
  return key;
}

export function end(key = currentKey) {
  if (key && key === currentKey) currentKey = null;
  saveSoon();
}

function findBucket(key) {
  return ensure().replies.find((r) => r.key === key) || null;
}

/** Every completion reports here (wired up in bot.js as the DeepSeek usage sink). */
export function record({ model, usage, at = Date.now() } = {}) {
  if (!usage) return null;
  const u = ensure();
  const parts = splitUsage(usage);
  const cost = price(parts, model, at);

  addTo(u.totals, parts, cost);
  u.lastAt = at;
  const day = nowBerlin(new Date(at)).dateStr;
  u.days[day] = u.days[day] || freshTotals();
  addTo(u.days[day], parts, cost);

  const bucket = findBucket(currentKey);
  if (bucket) {
    addTo(bucket, parts, cost);
    bucket.model = bucket.model || model || currentModelName();
  }
  saveSoon();
  return { parts, cost };
}

function currentModelName() {
  return CONFIG.model;
}

/**
 * Name an extra call inside the current reply's bucket. A reply's second call can
 * be a regeneration, a fact pass, a summary or a photo caption, and they cost very
 * different amounts - so the label has to say which, not assume.
 */
export function note(kind) {
  if (!kind) return;
  const bucket = findBucket(currentKey);
  if (!bucket) return;
  bucket.kinds[kind] = (bucket.kinds[kind] || 0) + 1;
}

/** Tie a bubble she sent to the bucket it was paid for, so a reply to it can be priced. */
export function attach(key, messageId) {
  if (!key || !messageId) return;
  const bucket = findBucket(key);
  if (!bucket) return;
  bucket.ids.push(Number(messageId));
  saveSoon();
}

export function bucketForMessage(messageId) {
  const wanted = Number(messageId);
  if (!wanted) return null;
  return ensure().replies.find((r) => r.ids.includes(wanted)) || null;
}

export function totals() {
  const u = ensure();
  return { ...u, today: u.days[nowBerlin().dateStr] || freshTotals() };
}

// ------------------------------------------------------------------ output

const num = (n) => Number(n || 0).toLocaleString("en-US");
const usd = (n) => `$${Number(n || 0).toFixed(Math.abs(n) < 0.01 ? 6 : 4)}`;

function rateLine(model, at) {
  const r = ratesFor(model, at);
  return `${usd(r.hit)}/M cached, ${usd(r.miss)}/M input, ${usd(r.out)}/M output${r.peak ? " (peak hours, doubled)" : " (off-peak)"}`;
}

const stamp = (ms) => `${nowBerlin(new Date(ms)).dateStr} ${nowBerlin(new Date(ms)).hhmm}`;

export function renderReply(bucket) {
  const t = nowBerlin(new Date(bucket.at));
  const kinds = Object.entries(bucket.kinds || {}).map(([k, n]) => (n > 1 ? `${n} x ${k}` : k));
  const extra = bucket.calls > 1
    ? ` (${bucket.calls} model calls: the reply${kinds.length ? ` + ${kinds.join(" + ")}` : ` plus ${bucket.calls - 1} more`})`
    : "";
  return [
    "what that reply cost",
    `- sent: ${t.hhmm} Dortmund on ${t.dateStr}${bucket.ids.length > 1 ? ` (${bucket.ids.length} bubbles)` : ""}`,
    `- model: ${bucket.model || currentModelName()}${extra}`,
    `- input: ${num(bucket.prompt)} tokens - ${num(bucket.hit)} cached / ${num(bucket.miss)} fresh`,
    `- output: ${num(bucket.completion)} tokens`,
    `- total: ${num(bucket.prompt + bucket.completion)} tokens`,
    `- cost: ${usd(bucket.cost)}`,
    `- rates: ${rateLine(bucket.model || currentModelName(), bucket.at)}`,
  ].join("\n");
}

/** Live account balance straight from DeepSeek (free call, no tokens spent). */
export async function accountBalance() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${CONFIG.deepseekKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const info = data?.balance_infos?.[0];
    if (!info) return null;
    const num2 = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      available: Boolean(data.is_available),
      currency: info.currency || null,
      total: num2(info.total_balance),
      granted: num2(info.granted_balance),
      toppedUp: num2(info.topped_up_balance),
    };
  } catch {
    return null;
  }
}

export function balanceLine(balance) {
  if (!balance || balance.total === null) return "- balance: could not reach DeepSeek to check it";
  const money = (n) => (balance.currency === "USD" ? `$${n.toFixed(n >= 1 ? 2 : 4)}` : `${n.toFixed(2)} ${balance.currency || ""}`.trim());
  const bits = [`- balance left at DeepSeek: ${money(balance.total)}`];
  if (balance.granted > 0) bits.push(`  (granted ${money(balance.granted)}, topped up ${money(balance.toppedUp)})`);
  if (!balance.available) bits.push("  (account flagged as not available - top up so she keeps talking)");
  return bits.join("\n");
}

export function renderTotals() {
  const u = totals();
  const t = u.totals;
  const first = u.since ? stamp(u.since) : "never";
  const days = Object.keys(u.days).sort();
  const busiest = [...u.replies].sort((a, b) => b.cost - a.cost)[0] || null;
  if (!t.calls) {
    return [
      "everything she has spent",
      `- counting since: ${first} (Dortmund)`,
      "- nothing counted yet - the first number appears with my next reply",
    ].join("\n");
  }
  const lines = [
    "everything she has spent",
    `- counting since: ${first} Dortmund`,
    `- model calls: ${num(t.calls)}`,
    `- input: ${num(t.prompt)} tokens - ${num(t.hit)} cached / ${num(t.miss)} fresh`,
    `- output: ${num(t.completion)} tokens`,
    `- total: ${num(t.prompt + t.completion)} tokens`,
    `- cost: ${usd(t.cost)}`,
    `- today (${nowBerlin().dateStr}): ${num(u.today.calls)} calls, ${num(u.today.prompt + u.today.completion)} tokens, ${usd(u.today.cost)}`,
  ];
  if (busiest) {
    lines.push(`- most expensive reply: ${usd(busiest.cost)} at ${stamp(busiest.at)}`);
  }
  if (days.length) {
    const perDay = days.slice(-7).map((d) => `${d.slice(5)} ${usd(u.days[d].cost)}`);
    lines.push(`- last days: ${perDay.join(" | ")}`);
  }
  return lines.join("\n");
}

export const USAGE_EXAMPLES = "reply to a message of hers with !token, or send !tokenall on its own";

export function helpText() {
  const u = totals();
  const lines = [
    "usage check",
    "- reply to one of my messages with !token and i say what that one cost",
    "- or send !tokenall on its own for everything since the beginning",
    "- both are free, i do not have to think to answer them",
  ];
  const last = u.replies[u.replies.length - 1];
  if (last) {
    lines.push(`- for reference, my last reply (${stamp(last.at)}): ${num(last.prompt + last.completion)} tokens, ${usd(last.cost)}`);
  }
  if (u.totals.calls) {
    lines.push(`- so far: ${num(u.totals.calls)} calls, ${num(u.totals.prompt + u.totals.completion)} tokens, ${usd(u.totals.cost)}`);
  } else {
    lines.push("- nothing counted yet - this is the first thing i am measuring");
  }
  return lines.join("\n");
}

/** Deliberately explains itself: the first thing anyone tries is an old message. */
export function notFoundText(messageId = null) {
  const u = totals();
  const lines = [
    "no numbers for that one",
    `- i only started counting on ${u.since ? stamp(u.since) : "the last start"} (Dortmund), so anything older has nothing to look up`,
    "- reply to a message i sent after that and it works",
  ];
  if (u.totals.calls) {
    lines.push(`- anyway, altogether so far: ${num(u.totals.calls)} calls, ${num(u.totals.prompt + u.totals.completion)} tokens, ${usd(u.totals.cost)}`);
    lines.push(`- today: ${num(u.today.calls)} calls, ${num(u.today.prompt + u.today.completion)} tokens, ${usd(u.today.cost)}`);
  }
  if (messageId) lines.push(`- (nothing tracked for message ${messageId})`);
  return lines.join("\n");
}

/** Accepts !token, /token, !tokens, /usage, !cost, !spend - with or without "all". */
export function parseCommand(text) {
  const compact = String(text || "").replace(/\s+/g, "").toLowerCase();
  const m = compact.match(/^[!/](?:token|tokens|usage|cost|spend)(all)?[.!?]*$/);
  if (!m) return null;
  return m[1] ? "all" : "one";
}

export { num as formatTokens, usd as formatUsd };

/** Used by the self-test to start from a clean slate. */
export function resetForTest() {
  state.usage = { since: Date.now(), lastAt: 0, totals: freshTotals(), days: {}, replies: [] };
  currentKey = null;
}
