// Reading posts from the internet: X/Twitter, Reddit, YouTube, Instagram, TikTok,
// or any plain web page. Text first, media URLs second (the caller decides what to download).
import fs from "node:fs";
import path from "node:path";
import { CONFIG, PATHS } from "./config.js";
import { logErr, truncate } from "./util.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export function extractUrls(text, max = CONFIG.social.maxLinks) {
  const found = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, max);
}

/** Challenge pages / blocks must never be fed to the model as "content". */
function looksLikeBlock(text = "") {
  return /just a moment|enable javascript|cf-chl|attention required|access denied|verify you are human|checking your browser/i.test(text.slice(0, 600))
    || text.trim().length < 40;
}

function decodeEntities(text = "") {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function metaMap(html) {
  const map = {};
  for (const tag of html.match(/<meta[^>]+>/gi) || []) {
    const key = (tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content\s*=\s*["']([\s\S]*?)["']/i) || [])[1];
    if (key && content) map[key.toLowerCase()] = decodeEntities(content).trim();
  }
  return map;
}

function htmlToText(html) {
  const main = html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    || html.match(/<main[\s\S]*?<\/main>/i)?.[0]
    || html;
  return decodeEntities(
    main
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function fetchText(url, { asJson = false, timeoutMs = CONFIG.social.timeoutMs, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "en,de;q=0.8", ...headers },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.text();
    if (!asJson) return { ok: true, body };
    try {
      return { ok: true, body: JSON.parse(body) };
    } catch {
      return { ok: false, status: 0, error: "bad json" };
    }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function classify(url) {
  const u = String(url);
  if (/(?:twitter|x)\.com\/[^/]+\/status\/\d+/i.test(u)) return "x";
  if (/(?:^|\/\/)(?:[a-z]+\.)?reddit\.com\/r\//i.test(u)) return "reddit";
  if (/(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)/i.test(u)) return "youtube";
  if (/instagram\.com\//i.test(u)) return "instagram";
  if (/tiktok\.com\//i.test(u)) return "tiktok";
  return "web";
}

async function readX(url) {
  const m = url.match(/(?:twitter|x)\.com\/([^/]+)\/status\/(\d+)/i);
  const [user, id] = [m?.[1], m?.[2]];
  if (!id) return null;

  const fx = await fetchText(`https://api.fxtwitter.com/${user}/status/${id}`, { asJson: true });
  if (fx.ok && fx.body?.tweet) {
    const t = fx.body.tweet;
    return {
      kind: "X / Twitter post",
      author: `@${t.author?.screen_name || user}${t.author?.name ? ` (${t.author.name})` : ""}`,
      text: String(t.text || "").trim(),
      extra: [t.likes ? `${t.likes} likes` : "", t.replies ? `${t.replies} replies` : "", t.created_at ? `posted ${t.created_at}` : ""].filter(Boolean).join(", "),
      imageUrls: (t.media?.photos || []).map((p) => p.url).filter(Boolean),
      videoUrls: (t.media?.videos || []).map((v) => v.url).filter(Boolean),
    };
  }

  const vx = await fetchText(`https://api.vxtwitter.com/${user}/status/${id}`, { asJson: true });
  if (vx.ok && vx.body?.text) {
    const b = vx.body;
    return {
      kind: "X / Twitter post",
      author: `@${b.user_screen_name || user}${b.user_name ? ` (${b.user_name})` : ""}`,
      text: String(b.text || "").trim(),
      extra: "",
      imageUrls: (b.media_extended || []).filter((x) => x.type === "image").map((x) => x.url),
      videoUrls: (b.media_extended || []).filter((x) => x.type === "video").map((x) => x.url),
    };
  }
  return null;
}

async function readReddit(url) {
  const clean = url.split("?")[0].replace(/\.json$/i, "").replace(/\/$/, "");
  const res = await fetchText(`${clean}.json?limit=5`, { asJson: true, headers: { "User-Agent": "negev-chan/1.0 (telegram bot)" } });
  if (!res.ok || !res.body) return null;

  // post URL -> [postListing, commentsListing]; subreddit URL -> one Listing object
  const body = res.body;
  const post = Array.isArray(body)
    ? body[0]?.data?.children?.[0]?.data
    : body?.data?.children?.[0]?.data;
  if (!post) return readRedditHtml(clean);
  const commentSource = Array.isArray(body) ? (body[1]?.data?.children || []) : [];
  const comments = commentSource
    .map((c) => c?.data?.body)
    .filter((b) => typeof b === "string" && b.trim())
    .slice(0, 3)
    .map((b) => truncate(b.replace(/\s+/g, " "), 220));
  return {
    kind: "Reddit post",
    author: `u/${post.author} in r/${post.subreddit}`,
    text: [post.title, post.selftext ? truncate(post.selftext.replace(/\s+/g, " "), 900) : ""].filter(Boolean).join("\n"),
    extra: [post.score ? `${post.score} upvotes` : "", post.num_comments ? `${post.num_comments} comments` : "", comments.length ? `top comments: ${comments.join(" // ")}` : ""].filter(Boolean).join(" | "),
    imageUrls: post.url_overridden_by_dest && /\.(jpg|jpeg|png|webp|gif)$/i.test(post.url_overridden_by_dest) ? [post.url_overridden_by_dest] : (post.thumbnail?.startsWith("http") ? [post.thumbnail] : []),
    videoUrls: [],
  };
}

/** Reddit often 403s its JSON API (datacenter/bot blocking). old.reddit serves plain HTML. */
async function readRedditHtml(clean) {
  const oldUrl = clean.replace(/^https?:\/\/(?:www\.)?reddit\.com/i, "https://old.reddit.com");
  const page = await fetchText(oldUrl);
  if (!page.ok) return null;
  const html = page.body;
  const meta = metaMap(html);
  const title = meta["og:title"] || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const blocks = [...html.matchAll(/<div class="md">([\s\S]*?)<\/div>/gi)]
    .slice(0, 3)
    .map((m) => truncate(htmlToText(m[1]).replace(/\s+/g, " "), 500))
    .filter(Boolean);
  const text = [title, blocks.join("\n---\n") || meta["og:description"] || ""].filter(Boolean).join("\n");
  if (!text) return null;
  return {
    kind: "Reddit post",
    author: "",
    text: truncate(text, CONFIG.social.textLimit),
    extra: "read from old.reddit.com (json api blocked)",
    imageUrls: meta["og:image"] ? [meta["og:image"]] : [],
    videoUrls: [],
  };
}

async function readYouTube(url) {
  const oembed = await fetchText(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { asJson: true });
  const title = oembed.ok ? oembed.body?.title : "";
  const author = oembed.ok ? oembed.body?.author_name : "";
  const page = await fetchText(url);
  let description = "";
  if (page.ok) {
    const meta = metaMap(page.body);
    description = meta["og:description"] || meta["description"] || "";
  }
  if (!title && !description) return null;
  return {
    kind: "YouTube video",
    author: author || "",
    text: [title, description ? truncate(description.replace(/\s+/g, " "), 700) : ""].filter(Boolean).join("\n"),
    extra: "",
    imageUrls: oembed.ok && oembed.body?.thumbnail_url ? [oembed.body.thumbnail_url] : [],
    videoUrls: [],
  };
}

async function readGeneric(url) {
  const page = await fetchText(url);
  if (page.ok) {
    const html = page.body;
    const meta = metaMap(html);
    const title = meta["og:title"] || meta["twitter:title"] || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const description = meta["og:description"] || meta["twitter:description"] || meta["description"] || "";
    const rawText = htmlToText(html);
    const bodyText = looksLikeBlock(rawText) ? "" : truncate(rawText, CONFIG.social.textLimit);
    const site = meta["og:site_name"] || "";
    const images = [meta["og:image"], meta["og:image:secure_url"], meta["twitter:image"]].filter(Boolean);
    const isVideoPage = /video|reel|watch/i.test(url);
    // login walls (instagram, tiktok) yield a title and nothing else - not worth reporting
    const trivial = !description && bodyText.length < 120;
    if (!trivial && (title || description || bodyText)) {
      return {
        kind: site ? `${site} page` : "web page",
        author: "",
        text: [title ? `Title: ${title}` : "", description ? `Description: ${description}` : "", bodyText ? `Page text: ${bodyText}` : ""].filter(Boolean).join("\n"),
        extra: isVideoPage ? "looks like a video page" : "",
        imageUrls: images,
        videoUrls: [],
      };
    }
  }

  // last resort: a public reader proxy that renders the page to markdown
  const jina = await fetchText(`https://r.jina.ai/${url}`, { timeoutMs: CONFIG.social.timeoutMs + 5000 });
  if (jina.ok && !looksLikeBlock(jina.body)) {
    return {
      kind: "web page (reader mode)",
      author: "",
      text: truncate(jina.body.replace(/\s+\n/g, "\n").trim(), CONFIG.social.textLimit),
      extra: "",
      imageUrls: [],
      videoUrls: [],
    };
  }
  return null;
}

export async function readPost(url) {
  const kind = classify(url);
  try {
    let post = null;
    if (kind === "x") post = await readX(url);
    else if (kind === "reddit") post = await readReddit(url);
    else if (kind === "youtube") post = await readYouTube(url);
    if (!post) post = await readGeneric(url);
    if (post) return { ok: true, url, kind, ...post };
  } catch (err) {
    logErr("[links] read failed:", err.message);
  }

  // X/IG/TikTok often need the reader fallback
  if (kind === "x" || kind === "instagram" || kind === "tiktok") {
    try {
      const jina = await fetchText(`https://r.jina.ai/${url}`, { timeoutMs: CONFIG.social.timeoutMs + 5000 });
      if (jina.ok && !looksLikeBlock(jina.body)) {
        return {
          ok: true, url, kind, author: "",
          text: truncate(jina.body.replace(/\s+\n/g, "\n").trim(), CONFIG.social.textLimit),
          extra: "read via text proxy", imageUrls: [], videoUrls: [],
        };
      }
    } catch { /* ignore */ }
  }
  return { ok: false, url, kind };
}

/** Download a remote image/video, respecting a hard byte cap. */
export async function downloadRemote(url, maxBytes = CONFIG.social.maxMediaBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) return { tooBig: true, size: len, mime };

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        try { res.body.destroy?.(); } catch { /* ignore */ }
        return { tooBig: true, size: total, mime };
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const ext = mime.includes("png") ? ".png"
      : mime.includes("webp") ? ".webp"
        : mime.includes("gif") ? ".gif"
          : mime.includes("mp4") || mime.includes("video") ? ".mp4"
            : mime.includes("audio") ? ".m4a"
              : ".jpg";
    const file = path.join(PATHS.tmp, `net_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}${ext}`);
    fs.mkdirSync(PATHS.tmp, { recursive: true });
    fs.writeFileSync(file, buffer);
    return { file, size: buffer.length, mime, buffer };
  } catch (err) {
    logErr("[links] download failed:", err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function removeFile(file) {
  try { if (file) fs.unlinkSync(file); } catch { /* ignore */ }
}
