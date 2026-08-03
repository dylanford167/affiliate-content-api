import crypto from "node:crypto";
import express from "express";
import { Readable } from "node:stream";

const PAGE_HOSTS = [
  "facebook.com", "fb.watch", "instagram.com", "threads.net", "threads.com",
  "pinterest.com", "pin.it", "tiktok.com",
  "reddit.com", "redd.it", "x.com", "twitter.com"
];

const MEDIA_HOSTS = [
  ...PAGE_HOSTS,
  "fbcdn.net", "fbsbx.com", "cdninstagram.com",
  "pinimg.com", "pinterestusercontent.com",
  "tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "ibytedtos.com",
  "muscdn.com", "akamaized.net",
  "v.redd.it", "preview.redd.it", "redditmedia.com", "redditstatic.com",
  "twimg.com", "video.twimg.com"
];

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function hostMatches(hostname, allowed) {
  const host = String(hostname || "").toLowerCase();
  return allowed.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function assertPublicHttpsUrl(value, allowedHosts) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:") throw new Error("Chỉ hỗ trợ URL HTTPS công khai.");
  if (url.username || url.password || !hostMatches(url.hostname, allowedHosts)) {
    throw new Error("Nền tảng hoặc CDN này chưa nằm trong danh sách được hỗ trợ.");
  }
  return url;
}

function platformFor(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host.includes("facebook") || host.includes("fbcdn") || host === "fb.watch") return "facebook";
  if (host.includes("pinterest") || host.includes("pinimg") || host === "pin.it") return "pinterest";
  if (host.includes("threads")) return "threads";
  if (host.includes("instagram") || host.includes("cdninstagram")) return "instagram";
  if (host.includes("tiktok") || host.includes("byteoversea") || host.includes("ibytedtos") || host.includes("muscdn")) return "tiktok";
  if (host.includes("reddit") || host === "redd.it") return "reddit";
  if (host === "x.com" || host.includes("twitter") || host.includes("twimg")) return "x";
  return "media";
}

function refererFor(hostname) {
  const platform = platformFor(hostname);
  if (platform === "facebook") return "https://www.facebook.com/";
  if (platform === "pinterest") return "https://www.pinterest.com/";
  if (platform === "instagram") return "https://www.instagram.com/";
  if (platform === "threads") return "https://www.threads.net/";
  if (platform === "reddit") return "https://www.reddit.com/";
  if (platform === "x") return "https://x.com/";
  return "https://www.tiktok.com/";
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function tagAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    const key = String(match[1] || "").toLowerCase();
    if (["meta", "video", "source", "img"].includes(key)) continue;
    attributes[key] = htmlDecode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function resolveCandidate(value, baseUrl) {
  try {
    const cleaned = htmlDecode(value).replace(/[),.;]+$/, "");
    return new URL(cleaned, baseUrl).href;
  } catch {
    return "";
  }
}

function mediaKind(value, declared = "") {
  const url = String(value || "");
  const hint = String(declared || "").toLowerCase();
  if (hint.startsWith("video") || /\.(?:mp4|m4v|mov|webm|m3u8|mpd)(?:[?#]|$)/i.test(url)) return "video";
  if (hint.startsWith("image") || /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(url)) return "image";
  return "";
}

function collectJsonMedia(value, output, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach(item => collectJsonMedia(item, output, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /^(?:contentUrl|content_url|videoUrl|video_url|imageUrl|image_url|thumbnailUrl|thumbnail_url)$/i.test(key)) {
      const declared = /video/i.test(key) ? "video" : /image|thumbnail/i.test(key) ? "image" : "";
      output.push({ value: item, declared, source: "structured-data" });
    } else {
      collectJsonMedia(item, output, depth + 1);
    }
  }
}

export function extractPublicMedia(html, pageUrl) {
  const candidates = [];
  const metadata = new Map();

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (!key || !attrs.content) continue;
    metadata.set(key, attrs.content);
    if (/^(?:og:video(?::url|:secure_url)?|twitter:player:stream)$/.test(key)) candidates.push({ value: attrs.content, declared: "video", source: key });
    if (/^(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/.test(key)) candidates.push({ value: attrs.content, declared: "image", source: key });
  }

  for (const tag of html.match(/<(?:video|source)\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const value = attrs.src || attrs["data-src"] || attrs["data-lazy-src"];
    if (value) candidates.push({ value, declared: attrs.type || "video", source: "html-video" });
  }

  for (const script of html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || []) {
    const body = script.replace(/^.*?>/, "").replace(/<\/script>$/i, "").trim();
    try { collectJsonMedia(JSON.parse(htmlDecode(body)), candidates); } catch { /* Third-party JSON-LD can be malformed. */ }
  }

  const decoded = htmlDecode(html);
  for (const match of decoded.matchAll(/https:\/\/[^\s"'<>]+/gi)) {
    if (mediaKind(match[0]) === "video") candidates.push({ value: match[0], declared: "video", source: "page-data" });
  }

  const seen = new Set();
  const media = [];
  for (const candidate of candidates) {
    const absolute = resolveCandidate(candidate.value, pageUrl);
    if (!absolute || seen.has(absolute)) continue;
    let parsed;
    try { parsed = assertPublicHttpsUrl(absolute, MEDIA_HOSTS); } catch { continue; }
    const type = mediaKind(parsed.href, candidate.declared);
    if (!type) continue;
    seen.add(parsed.href);
    media.push({
      type,
      url: parsed.href,
      source: candidate.source,
      format: /\.m3u8(?:[?#]|$)/i.test(parsed.href) ? "hls" : /\.mpd(?:[?#]|$)/i.test(parsed.href) ? "dash" : type === "video" ? "mp4" : "image"
    });
  }

  media.sort((a, b) => {
    const score = item => (item.type === "video" ? 20 : 0) + (/og:|structured/.test(item.source) ? 8 : 0) + (item.source === "html-video" ? 4 : 0);
    return score(b) - score(a);
  });
  return {
    title: metadata.get("og:title") || metadata.get("twitter:title") || "Media công khai",
    description: metadata.get("og:description") || metadata.get("description") || "",
    thumbnail: metadata.get("og:image") || metadata.get("twitter:image") || "",
    media: media.slice(0, 40)
  };
}

async function fetchWithSafeRedirects(source, allowedHosts, options = {}) {
  let current = assertPublicHttpsUrl(source, allowedHosts);
  for (let count = 0; count < 5; count++) {
    const response = await fetch(current, {
      ...options,
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Referer: refererFor(current.hostname),
        Accept: "text/html,application/xhtml+xml,video/*,image/*;q=0.9,*/*;q=0.8",
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(25000)
    });
    if (!REDIRECT_CODES.has(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) break;
    current = assertPublicHttpsUrl(new URL(location, current).href, allowedHosts);
  }
  throw new Error("URL chuyển hướng quá nhiều lần.");
}

async function readLimitedText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Trang nguồn quá lớn để phân tích an toàn.");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeFilename(title, type, format) {
  const base = String(title || "rymz-media").normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "rymz-media";
  const extension = type === "image" ? (format === "image" ? "jpg" : format) : format === "hls" ? "m3u8" : format === "dash" ? "mpd" : "mp4";
  return `${base}.${extension}`;
}

function formatFor(url, type) {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return "hls";
  if (/\.mpd(?:[?#]|$)/i.test(url)) return "dash";
  if (type === "video") return "mp4";
  const match = String(url).match(/\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "image";
}

export function createDownloaderRouter({ secret }) {
  const router = express.Router();
  const signingSecret = String(secret || "development-only");
  const sign = value => crypto.createHmac("sha256", signingSecret).update(value).digest("base64url");

  router.post("/resolve", async (req, res) => {
    try {
      if (req.body?.rightsConfirmed !== true) return res.status(400).json({ error: "Hãy xác nhận bạn có quyền tải và sử dụng nội dung này." });
      const input = assertPublicHttpsUrl(req.body?.url, [...PAGE_HOSTS, ...MEDIA_HOSTS]);
      const { response, finalUrl } = await fetchWithSafeRedirects(input.href, [...PAGE_HOSTS, ...MEDIA_HOSTS]);
      if (!response.ok) throw new Error(`Trang nguồn trả về lỗi ${response.status}. Hãy thử bài viết công khai hoặc dùng extension khi trang yêu cầu đăng nhập.`);
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      let result;
      if (contentType.startsWith("video/") || contentType.startsWith("image/") || mediaKind(finalUrl.href)) {
        const type = contentType.startsWith("image/") ? "image" : "video";
        result = {
          title: "Rymz media", description: "", thumbnail: "",
          media: [{ type, url: finalUrl.href, source: "direct", format: formatFor(finalUrl.href, type) }]
        };
        if (response.body) await response.body.cancel().catch(() => {});
      } else {
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (declaredLength > MAX_HTML_BYTES) throw new Error("Trang nguồn quá lớn để phân tích an toàn.");
        const html = await readLimitedText(response, MAX_HTML_BYTES);
        result = extractPublicMedia(html, finalUrl.href);
      }
      if (!result.media.length) throw new Error("Không tìm thấy luồng media công khai. Nếu bài cần đăng nhập, hãy mở bài và quét bằng extension Rymz Space.");
      const expires = Math.floor(Date.now() / 1000) + 15 * 60;
      const media = result.media.map((item, index) => {
        const encoded = Buffer.from(item.url).toString("base64url");
        const signedValue = `${encoded}.${expires}`;
        return {
          ...item,
          id: `${item.type}-${index + 1}`,
          downloadUrl: `/api/downloader/file?u=${encodeURIComponent(encoded)}&e=${expires}&s=${encodeURIComponent(sign(signedValue))}&name=${encodeURIComponent(safeFilename(result.title, item.type, item.format))}`
        };
      });
      res.json({ ok: true, sourceUrl: finalUrl.href, platform: platformFor(finalUrl.hostname), title: result.title, description: result.description, thumbnail: result.thumbnail, media });
    } catch (error) {
      res.status(422).json({ error: error.message || "Không phân tích được URL." });
    }
  });

  router.get("/file", async (req, res) => {
    try {
      const encoded = String(req.query.u || "");
      const expires = Number(req.query.e || 0);
      const signature = String(req.query.s || "");
      if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return res.status(410).json({ error: "Liên kết tải đã hết hạn. Hãy phân tích lại URL." });
      const expected = sign(`${encoded}.${expires}`);
      if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(403).json({ error: "Liên kết tải không hợp lệ." });
      const source = Buffer.from(encoded, "base64url").toString("utf8");
      const headers = req.headers.range ? { Range: req.headers.range } : {};
      const { response } = await fetchWithSafeRedirects(source, MEDIA_HOSTS, { headers });
      if (!response.ok && response.status !== 206) throw new Error(`CDN trả về lỗi ${response.status}.`);
      ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"].forEach(name => {
        const value = response.headers.get(name); if (value) res.setHeader(name, value);
      });
      const filename = String(req.query.name || "rymz-media").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
      res.setHeader("Content-Disposition", `${req.headers.range ? "inline" : "attachment"}; filename="${filename}"`);
      res.setHeader("Cache-Control", "private, max-age=900");
      res.status(response.status);
      if (!response.body) return res.end();
      Readable.fromWeb(response.body).pipe(res);
    } catch (error) {
      if (!res.headersSent) res.status(502).json({ error: error.message }); else res.end();
    }
  });

  return router;
}
