// DeepSeek client: OpenAI-compatible chat completions on api.deepseek.com.
// One fixed non-thinking flash model, vision-capable, with network retries.
import { CONFIG } from "./config.js";
import { sleep, stripEmojis } from "./util.js";

const ENDPOINT = "https://api.deepseek.com/chat/completions";

// Where token usage is reported (usage.js). Kept as a plain sink so this client
// stays independent of the ledger and can be used on its own.
let usageSink = null;
export function setUsageSink(fn) {
  usageSink = typeof fn === "function" ? fn : null;
}

export function currentModel() {
  return CONFIG.model;
}

export function imagePart(buffer, mime = "image/jpeg", detail = CONFIG.imageDetail) {
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${buffer.toString("base64")}`, detail },
  };
}

export function textPart(text) {
  return { type: "text", text };
}

async function callOnce(model, messages, { maxTokens, temperature }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.deepseekKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        // keep the model non-reasoning: no chain-of-thought, no wasted tokens
        thinking: CONFIG.thinking,
      }),
      signal: ctrl.signal,
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat completion.
 * `messages[].content` is either a string or an array of content parts.
 * Returns plain text (never throws on emoji / whitespace issues).
 *
 * The model is intentionally not an option. Every call uses CONFIG.model, which
 * is permanently set to the non-reasoning DeepSeek V4 Flash tier.
 */
export async function llm(messages, { maxTokens = CONFIG.replyMaxTokens, temperature = 0.95 } = {}) {
  let lastError = "unknown error";
  const model = CONFIG.model;
  const cappedTokens = Math.min(Math.max(1, Number(maxTokens) || CONFIG.replyMaxTokens), CONFIG.maxOutputTokens);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { status, body } = await callOnce(model, messages, { maxTokens: cappedTokens, temperature });

    if (status === 200) {
      try {
        const data = JSON.parse(body);
        if (data?.usage) {
          try { usageSink?.({ model, usage: data.usage, at: Date.now() }); } catch { /* never let accounting break a reply */ }
        }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string" && content.trim()) return content;
        lastError = "empty completion";
      } catch {
        lastError = "unparseable response";
      }
      continue;
    }

    // hard failures: no point retrying
    if (status === 401 || status === 402 || status === 403) {
      throw new Error(`DeepSeek auth/billing error (${status}): ${body.slice(0, 300)}`);
    }

    if (status === 429 || status >= 500 || status === 0) {
      lastError = `http ${status}: ${body.slice(0, 200)}`;
    } else {
      // A malformed request or unavailable fixed model must be visible. Never
      // silently switch models to hide it or spend on an alternate tier.
      throw new Error(`DeepSeek request error (${status}): ${body.slice(0, 300)}`);
    }

    if (attempt < 2) await sleep(1500 * (attempt + 1));
  }

  throw new Error(`DeepSeek failed: ${lastError}`);
}

/** Clean a raw completion for sending: no emojis, no markdown noise, sane length. */
export function tidyReply(text) {
  return stripEmojis(String(text || ""))
    .replace(/^\s*(negev|negev-chan)\s*[:>-]\s*/i, "")
    // bubble separator the prompts use: must become a plain blank line
    .replace(/^\s*\|{2,}\s*$/gm, "")
    .replace(/\s*\|{2,}\s*/g, "\n\n")
    .replace(/[*_`]{1,}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
