import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import fs from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import { put as putBlob } from "@vercel/blob";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(serverDirectory, ".env") });

const app = express();
const port = Number(process.env.PORT || 8787);
const accounts = new Map(); // MVP only: replace with encrypted DB storage.
const threadsAccounts = new Map();
let activeThreadsAccountId = null;
const oauthStates = new Map();
const preparedMedia = new Map();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const metaVersion = process.env.META_GRAPH_VERSION || "v23.0";
const threadsScopes = [...new Set([
  ...(process.env.THREADS_SCOPES || "").split(",").map(value => value.trim()).filter(Boolean),
  "threads_basic",
  "threads_content_publish",
  "threads_read_replies",
  "threads_manage_replies"
])].join(",");
const threadsOAuthStateSecret = process.env.OAUTH_STATE_SECRET || process.env.THREADS_APP_SECRET || process.env.META_APP_SECRET || "development-only";
function createThreadsOAuthState() {
  const payload = Buffer.from(JSON.stringify({ platform: "threads", nonce: crypto.randomUUID(), createdAt: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", threadsOAuthStateSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function verifyThreadsOAuthState(value) {
  try {
    const [payload, signature] = String(value || "").split(".");
    if (!payload || !signature) return false;
    const expected = crypto.createHmac("sha256", threadsOAuthStateSecret).update(payload).digest("base64url");
    const validSignature = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!validSignature) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.platform === "threads" && Number.isFinite(data.createdAt) && Date.now() - data.createdAt < 10 * 60 * 1000;
  } catch {
    return false;
  }
}
const threadsBundleKey = crypto.createHash("sha256").update(process.env.ACCOUNT_BUNDLE_SECRET || process.env.SESSION_SECRET || threadsOAuthStateSecret).digest();
function sealThreadsAccount(account) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", threadsBundleKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({
    profile: account.profile,
    grantedPermissions: account.grantedPermissions,
    userAccessToken: account.userAccessToken,
    expiresAt: account.expiresAt || null,
    issuedAt: Date.now()
  }), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function openThreadsAccountBundle(value) {
  const [version, ivValue, tagValue, encryptedValue] = String(value || "").split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Thông tin kết nối Threads không hợp lệ");
  const decipher = crypto.createDecipheriv("aes-256-gcm", threadsBundleKey, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8"));
  if (!payload.profile?.id || !payload.userAccessToken) throw new Error("Thông tin kết nối Threads bị thiếu");
  return { connectedAt: new Date(payload.issuedAt || Date.now()).toISOString(), profile: payload.profile, items: [{ id: payload.profile.id, name: payload.profile.username }], grantedPermissions: payload.grantedPermissions || [], userAccessToken: payload.userAccessToken, expiresAt: payload.expiresAt || null };
}
app.use(cors({ origin: /^chrome-extension:\/\// }));
app.use(express.json({ limit: "4mb" }));

async function fetchManagedFacebookPages(userAccessToken) {
  const params = new URLSearchParams({
    fields: "id,name,access_token,instagram_business_account{id,username}",
    limit: "100",
    access_token: userAccessToken
  });
  const response = await fetch(`https://graph.facebook.com/${metaVersion}/me/accounts?${params}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || "Không tải được danh sách Facebook Page");
  return Array.isArray(body.data) ? body.data : [];
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Affiliate Content Studio Server</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#f6f7f8;font:16px/1.55 system-ui,sans-serif}.card{width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #293039;border-radius:20px;background:#15191e;box-shadow:0 24px 80px #0008}.status{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;background:#202a1d;color:#cbff4a;font-size:13px;font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:#cbff4a;box-shadow:0 0 12px #cbff4a}h1{font-size:28px;line-height:1.15;margin:18px 0 10px}p{color:#aeb7c1}ol{padding-left:20px;color:#d8dde2}code{padding:3px 6px;border-radius:5px;background:#0b0d10;color:#c9b9ff}a{color:#cbff4a}</style>
</head><body><main class="card"><span class="status"><i class="dot"></i>Server đang hoạt động</span><h1>Affiliate Content Studio</h1><p>Server API đã sẵn sàng tại cổng <code>${port}</code>.</p><ol><li>Giữ cửa sổ terminal đang chạy.</li><li>Mở một bài mạng xã hội được hỗ trợ.</li><li>Mở Chrome Extension và bấm <b>Quét bài viết hiện tại</b>.</li></ol><p>Kiểm tra kỹ thuật: <a href="/health">/health</a></p></main></body></html>`);
});
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config/status", (_req, res) => res.json({
  serverUrl: publicBaseUrl,
  facebook: { configured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET), appId: process.env.META_APP_ID || "", callback: `${publicBaseUrl}/auth/meta/callback` },
  threads: { configured: Boolean(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET), appId: process.env.THREADS_APP_ID || "", callback: `${publicBaseUrl}/auth/threads/callback` }
}));
app.get("/api/accounts", async (_req, res) => {
  const facebook = accounts.get("facebook");
  if (facebook?.userAccessToken) {
    try {
      const pageData = await fetchManagedFacebookPages(facebook.userAccessToken);
      facebook.items = pageData.map(page => ({ id: page.id, name: page.name, accessToken: page.access_token }));
      facebook.pagesRefreshedAt = new Date().toISOString();
      facebook.pagesRefreshError = null;
    } catch (error) {
      facebook.pagesRefreshError = error.message;
    }
  }
  const response = Object.fromEntries([...accounts].map(([key, value]) => [key, {
    connected: true,
    profile: value.profile,
    grantedPermissions: value.grantedPermissions || [],
    canPublish: (value.grantedPermissions || []).includes("pages_manage_posts"),
    canComment: (value.grantedPermissions || []).includes("pages_manage_engagement"),
    items: (value.items || []).map(item => ({ id: item.id, name: item.name, username: item.username, pageId: item.pageId, pageName: item.pageName })),
    refreshError: value.pagesRefreshError || undefined
  }]));
  // Keep the old `threads` shape for backwards compatibility, while exposing
  // every connected Threads identity without ever returning access tokens.
  if (threadsAccounts.size) {
    response.threads = {
      ...(response.threads || {}),
      connected: true,
      activeAccountId: activeThreadsAccountId,
      accounts: [...threadsAccounts.values()].map(account => ({
        id: account.profile.id,
        username: account.profile.username,
        name: account.profile.name || account.profile.username,
        profilePictureUrl: account.profile.threads_profile_picture_url || "",
        connectedAt: account.connectedAt,
        grantedPermissions: account.grantedPermissions || []
      }))
    };
  }
  res.json(response);
});

app.post("/api/accounts/threads/select", (req, res) => {
  const accountId = String(req.body?.accountId || "").trim();
  const account = threadsAccounts.get(accountId);
  if (!account) return res.status(404).json({ error: "Không tìm thấy tài khoản Threads" });
  activeThreadsAccountId = accountId;
  accounts.set("threads", account);
  res.json({ ok: true, activeAccountId: accountId });
});

app.delete("/api/accounts/threads/:accountId", (req, res) => {
  const accountId = String(req.params.accountId || "").trim();
  if (!threadsAccounts.delete(accountId)) return res.status(404).json({ error: "Không tìm thấy tài khoản Threads" });
  if (activeThreadsAccountId === accountId) {
    activeThreadsAccountId = threadsAccounts.keys().next().value || null;
    const next = activeThreadsAccountId ? threadsAccounts.get(activeThreadsAccountId) : null;
    if (next) accounts.set("threads", next); else accounts.delete("threads");
  }
  res.json({ ok: true, activeAccountId: activeThreadsAccountId });
});

const allowedMediaHosts = ["facebook.com", "fbcdn.net", "cdninstagram.com", "instagram.com", "threads.net", "threads.com", "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "ibytedtos.com", "muscdn.com", "akamaized.net"];
function assertAllowedMediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedMediaHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error("URL video không thuộc CDN mạng xã hội được hỗ trợ");
  return url.href;
}

const mediaProxySecret = process.env.MEDIA_PROXY_SECRET || process.env.THREADS_APP_SECRET || process.env.META_APP_SECRET || "development-only";
function decodeCommentImageDataUrl(value) {
  const source = String(value || "");
  const match = source.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("Ảnh comment rỗng.");
  return { buffer, mimeType: match[1], extension: match[1].split("/")[1].replace("jpg", "jpeg") };
}
async function hostPublicCommentImage(value, prefix = "comments") {
  const source = String(value || "").trim();
  if (/^https:\/\//i.test(source)) return { url: source, cleanup: null };
  const imageData = decodeCommentImageDataUrl(source);
  if (!imageData) throw new Error("Ảnh comment không đúng định dạng.");
  if (imageData.buffer.length > 3 * 1024 * 1024) throw new Error("Ảnh comment vượt giới hạn 3 MB.");
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Thiếu BLOB_READ_WRITE_TOKEN để gửi ảnh comment.");
  const blob = await putBlob(`${prefix}/${crypto.randomUUID()}.${imageData.extension}`, imageData.buffer, { access: "public", contentType: imageData.mimeType, addRandomSuffix: false });
  return { url: blob.url, cleanup: null };
}
function signMediaValue(value) {
  return crypto.createHmac("sha256", mediaProxySecret).update(value).digest("base64url");
}
function mediaProxyUrl(sourceUrl) {
  const source = assertAllowedMediaUrl(sourceUrl);
  if (!/^https:\/\//i.test(publicBaseUrl)) throw new Error("PUBLIC_BASE_URL phải là HTTPS công khai để Threads tải media");
  const encoded = Buffer.from(source).toString("base64url");
  return `${publicBaseUrl}/api/media/proxy?u=${encodeURIComponent(encoded)}&s=${encodeURIComponent(signMediaValue(encoded))}`;
}

app.get("/api/media/proxy", async (req, res) => {
  try {
    const encoded = String(req.query.u || "");
    const signature = String(req.query.s || "");
    const expected = signMediaValue(encoded);
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(403).end();
    const source = assertAllowedMediaUrl(Buffer.from(encoded, "base64url").toString("utf8"));
    const hostname = new URL(source).hostname;
    const referer = hostname.endsWith("fbcdn.net") || hostname.endsWith("facebook.com") ? "https://www.facebook.com/"
      : hostname.endsWith("cdninstagram.com") || hostname.endsWith("instagram.com") ? "https://www.instagram.com/"
        : hostname.endsWith("threads.net") || hostname.endsWith("threads.com") ? "https://www.threads.net/"
          : "https://www.tiktok.com/";
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", Referer: referer };
    if (req.headers.range) headers.Range = req.headers.range;
    let currentSource = source;
    let upstream;
    for (let redirect = 0; redirect < 4; redirect++) {
      upstream = await fetch(currentSource, { headers, redirect: "manual", signal: AbortSignal.timeout(120000) });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location) break;
      currentSource = assertAllowedMediaUrl(new URL(location, currentSource).href);
    }
    if (!upstream) return res.status(502).end();
    if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).end();
    ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"].forEach(name => {
      const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
    });
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(upstream.status);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: error.message }); else res.end();
  }
});

function looksLikeVideoUrl(value) {
  return /\.(?:mp4|m3u8|mpd)(?:\?|$)/i.test(String(value || ""));
}

function fullVideoUrl(value) {
  const url = new URL(assertAllowedMediaUrl(value));
  url.searchParams.delete("bytestart");
  url.searchParams.delete("byteend");
  return url.href;
}

function runFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("FFmpeg quá thời gian xử lý")); }, timeoutMs);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(stderr.trim() || `FFmpeg exit ${code}`)); });
  });
}

async function prepareVideoMp4(sourceUrl) {
  const source = fullVideoUrl(sourceUrl);
  const outputPath = path.join(os.tmpdir(), `affiliate-${crypto.randomUUID()}.mp4`);
  const hostname = new URL(source).hostname;
  const referer = hostname.endsWith("fbcdn.net") || hostname.endsWith("facebook.com") ? "https://www.facebook.com/"
    : hostname.endsWith("cdninstagram.com") || hostname.endsWith("instagram.com") ? "https://www.instagram.com/"
      : hostname.endsWith("threads.net") || hostname.endsWith("threads.com") ? "https://www.threads.net/"
        : "https://www.tiktok.com/";
  const common = ["-y", "-loglevel", "error", "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", "-referer", referer, "-i", source, "-map", "0:v:0", "-map", "0:a?", "-movflags", "+faststart"];
  try {
    try {
      await runFfmpeg([...common, "-c", "copy", outputPath]);
    } catch {
      await runFfmpeg([...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k", outputPath]);
    }
    const stat = await fs.stat(outputPath);
    if (stat.size < 1024) throw new Error("Video MP4 tao ra khong hop le");
    if (stat.size > 1024 * 1024 * 1024) throw new Error("Video lon hon 1 GB; hay chon video ngan hon de dang");
    return { outputPath, size: stat.size };
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => { });
    throw error;
  }
}

app.post("/api/media/prepare", async (req, res) => {
  let outputPath;
  try {
    const sourceUrl = fullVideoUrl(req.body?.url);
    const id = crypto.randomUUID();
    outputPath = path.join(os.tmpdir(), `affiliate-${id}.mp4`);
    const hostname = new URL(sourceUrl).hostname;
    const referer = hostname.endsWith("fbcdn.net") || hostname.endsWith("facebook.com") ? "https://www.facebook.com/"
      : hostname.endsWith("cdninstagram.com") || hostname.endsWith("instagram.com") ? "https://www.instagram.com/"
        : hostname.endsWith("threads.net") || hostname.endsWith("threads.com") ? "https://www.threads.net/"
          : "https://www.tiktok.com/";
    const common = ["-y", "-loglevel", "error", "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", "-referer", referer, "-i", sourceUrl, "-map", "0:v:0", "-map", "0:a?", "-movflags", "+faststart"];
    try {
      await runFfmpeg([...common, "-c", "copy", outputPath]);
    } catch {
      await runFfmpeg([...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k", outputPath]);
    }
    const stat = await fs.stat(outputPath);
    if (stat.size < 1024) throw new Error("Video MP4 tạo ra không hợp lệ");
    preparedMedia.set(id, { path: outputPath, createdAt: Date.now() });
    res.json({ ok: true, size: stat.size, downloadUrl: `/api/media/download/${id}` });
  } catch (error) {
    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => { });
    res.status(422).json({ error: error.message });
  }
});

app.get("/api/media/download/:id", (req, res) => {
  const media = preparedMedia.get(req.params.id);
  if (!media) return res.status(404).json({ error: "Video đã hết hạn hoặc không tồn tại" });
  res.download(media.path, "video.mp4", error => {
    if (!error) preparedMedia.delete(req.params.id);
    if (!error) fs.rm(media.path, { force: true }).catch(() => { });
  });
});

app.get("/auth/facebook/engagement", (_req, res) => {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) return res.status(501).send("Thiếu META_APP_ID hoặc META_APP_SECRET");
  const state = crypto.randomUUID();
  oauthStates.set(state, { platform: "facebook", purpose: "engagement", createdAt: Date.now() });
  const params = new URLSearchParams({ client_id: process.env.META_APP_ID, redirect_uri: `${publicBaseUrl}/auth/meta/callback`, state, response_type: "code", scope: "pages_manage_engagement", auth_type: "rerequest" });
  res.redirect(`https://www.facebook.com/${metaVersion}/dialog/oauth?${params}`);
});

app.get("/auth/:platform", (req, res) => {
  const platform = req.params.platform;
  if (!["facebook", "instagram", "tiktok", "threads"].includes(platform)) return res.status(404).send("Nền tảng không hỗ trợ");
  if (["facebook", "instagram"].includes(platform)) {
    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) return res.status(501).send("Thiếu META_APP_ID hoặc META_APP_SECRET trong server/.env");
    const state = crypto.randomUUID();
    oauthStates.set(state, { platform, createdAt: Date.now() });
    // Start with basic login. Add Page/Instagram publishing scopes in .env only
    // after they are enabled for this app's Use Case in Meta Dashboard.
    const configuredScopes = platform === "instagram"
      ? process.env.META_INSTAGRAM_SCOPES
      : process.env.META_FACEBOOK_SCOPES;
    const scopes = (configuredScopes || "public_profile").split(",").map(value => value.trim()).filter(Boolean);
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: `${publicBaseUrl}/auth/meta/callback`,
      state,
      response_type: "code",
      scope: scopes.join(",")
    });
    return res.redirect(`https://www.facebook.com/${metaVersion}/dialog/oauth?${params}`);
  }
  if (platform === "threads") {
    const clientId = process.env.THREADS_APP_ID;
    if (!clientId || !process.env.THREADS_APP_SECRET) return res.status(501).send("Thiếu THREADS_APP_ID hoặc THREADS_APP_SECRET trong server/.env");
    const state = createThreadsOAuthState();
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: `${publicBaseUrl}/auth/threads/callback`, scope: threadsScopes, response_type: "code", state });
    return res.redirect(`https://threads.net/oauth/authorize?${params}`);
  }
  if (platform === "tiktok") {
    if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) return res.status(501).send("Thiếu TIKTOK_CLIENT_KEY hoặc TIKTOK_CLIENT_SECRET trong server/.env");
    const state = crypto.randomUUID();
    oauthStates.set(state, { platform, createdAt: Date.now() });
    const params = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, redirect_uri: `${publicBaseUrl}/auth/tiktok/callback`, scope: process.env.TIKTOK_SCOPES || "user.info.basic,video.publish", response_type: "code", state });
    return res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params}`);
  }
  res.status(501).send(`OAuth ${platform} sẽ được cấu hình sau khi luồng crawl/download được xác nhận hoạt động.`);
});

app.get("/auth/threads/callback", async (req, res) => {
  const state = String(req.query.state || "");
  if (!verifyThreadsOAuthState(state)) return res.status(400).send("Threads OAuth state không hợp lệ hoặc đã hết hạn.");
  if (req.query.error || !req.query.code) return res.status(400).send(`Threads từ chối: ${req.query.error_message || req.query.error || "missing code"}`);
  try {
    const form = new URLSearchParams({ client_id: process.env.THREADS_APP_ID, client_secret: process.env.THREADS_APP_SECRET, grant_type: "authorization_code", redirect_uri: `${publicBaseUrl}/auth/threads/callback`, code: String(req.query.code) });
    const tokenResponse = await fetch("https://graph.threads.net/oauth/access_token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const token = await tokenResponse.json(); if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_message || token.error?.message || "Không lấy được token");
    let userAccessToken = token.access_token;
    let expiresIn = Number(token.expires_in || 0);
    try {
      const longTokenParams = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: process.env.THREADS_APP_SECRET, access_token: token.access_token });
      const longTokenResponse = await fetch(`https://graph.threads.net/access_token?${longTokenParams}`);
      const longToken = await longTokenResponse.json().catch(() => ({}));
      if (longTokenResponse.ok && longToken.access_token) {
        userAccessToken = longToken.access_token;
        expiresIn = Number(longToken.expires_in || expiresIn);
      }
    } catch {}
    const profileResponse = await fetch(`https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url&access_token=${encodeURIComponent(userAccessToken)}`);
    const profile = await profileResponse.json(); if (!profileResponse.ok) throw new Error(profile.error?.message || "Không đọc được Threads profile");
    const account = { connectedAt: new Date().toISOString(), profile, items: [{ id: profile.id, name: profile.username }], grantedPermissions: threadsScopes.split(","), userAccessToken, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null };
    threadsAccounts.set(profile.id, account);
    activeThreadsAccountId = profile.id;
    // Keep the legacy active-account slot so existing publishing code and
    // already-saved drafts continue to work unchanged.
    accounts.set("threads", account);
    const connectedParams = new URLSearchParams({ accountId: profile.id, username: profile.username || "", name: profile.name || profile.username || "", profilePictureUrl: profile.threads_profile_picture_url || "", bundle: sealThreadsAccount(account) });
    // Keep the encrypted bundle in the URL fragment so it is not sent to the
    // server again or recorded in request logs. The extension captures it.
    res.redirect(`${publicBaseUrl}/auth/threads/connected#${connectedParams}`);
  } catch (error) { res.status(500).send(`Threads OAuth thất bại: ${error.message}`); }
});

app.get("/auth/threads/connected", (_req, res) => {
  res.type("html").send(`<meta charset="utf-8"><title>Đã kết nối Threads</title><style>body{background:#090c11;color:#fff;font:16px system-ui;padding:40px}strong{color:#6bb8ff}</style><h1>Đã kết nối Threads</h1><p>Rymz Space đang tự động nhận ID và lưu tài khoản. Bạn có thể đóng tab này.</p><script>setTimeout(()=>window.close(),1800)</script>`);
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const state = String(req.query.state || ""); const session = oauthStates.get(state); oauthStates.delete(state);
  if (!session || session.platform !== "tiktok") return res.status(400).send("TikTok OAuth state không hợp lệ.");
  if (req.query.error || !req.query.code) return res.status(400).send(`TikTok từ chối: ${req.query.error_description || req.query.error || "missing code"}`);
  try {
    const form = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code: String(req.query.code), grant_type: "authorization_code", redirect_uri: `${publicBaseUrl}/auth/tiktok/callback` });
    const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const token = await tokenResponse.json(); if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || token.error || "Không lấy được token");
    const profileResponse = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", { headers: { Authorization: `Bearer ${token.access_token}` } });
    const profileBody = await profileResponse.json(); const profile = profileBody.data?.user;
    if (!profileResponse.ok || !profile) throw new Error(profileBody.error?.message || "Không đọc được TikTok profile");
    accounts.set("tiktok", { connectedAt: new Date().toISOString(), profile, items: [{ id: profile.open_id, name: profile.display_name }], grantedPermissions: String(token.scope || "").split(","), userAccessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expires_in });
    res.type("html").send(`<meta charset="utf-8"><h1>Đã kết nối TikTok</h1><p>${profile.display_name}</p><p>Đóng tab này và bấm Làm mới trong extension.</p>`);
  } catch (error) { res.status(500).send(`TikTok OAuth thất bại: ${error.message}`); }
});

app.get("/auth/meta/callback", async (req, res) => {
  const session = oauthStates.get(String(req.query.state || ""));
  oauthStates.delete(String(req.query.state || ""));
  if (!session || Date.now() - session.createdAt > 10 * 60 * 1000) return res.status(400).send("OAuth state không hợp lệ hoặc đã hết hạn.");
  if (req.query.error) return res.status(400).send(`Meta từ chối đăng nhập: ${req.query.error_description || req.query.error}`);
  if (!req.query.code) return res.status(400).send("Meta không trả authorization code.");
  try {
    const tokenParams = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: `${publicBaseUrl}/auth/meta/callback`,
      code: String(req.query.code)
    });
    const tokenResponse = await fetch(`https://graph.facebook.com/${metaVersion}/oauth/access_token?${tokenParams}`);
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) throw new Error(token.error?.message || "Không đổi được authorization code");
    const profileResponse = await fetch(`https://graph.facebook.com/${metaVersion}/me?fields=id,name&access_token=${encodeURIComponent(token.access_token)}`);
    const profile = await profileResponse.json();
    if (!profileResponse.ok) throw new Error(profile.error?.message || "Không đọc được hồ sơ Meta");
    const permissionsResponse = await fetch(`https://graph.facebook.com/${metaVersion}/me/permissions?access_token=${encodeURIComponent(token.access_token)}`);
    const permissionsBody = await permissionsResponse.json();
    const grantedPermissions = permissionsResponse.ok
      ? (permissionsBody.data || []).filter(permission => permission.status === "granted").map(permission => permission.permission)
      : [];
    let pageData = [];
    let pagesError = "";
    try { pageData = await fetchManagedFacebookPages(token.access_token); }
    catch (error) { pagesError = error.message; }
    const connected = session.platform === "instagram"
      ? pageData.filter(page => page.instagram_business_account).map(page => ({ pageId: page.id, pageName: page.name, ...page.instagram_business_account, accessToken: page.access_token }))
      : pageData.map(page => ({ id: page.id, name: page.name, accessToken: page.access_token }));
    const previousAccount = accounts.get(session.platform);
    const mergedPermissions = [...new Set([...(previousAccount?.grantedPermissions || []), ...grantedPermissions])];
    accounts.set(session.platform, {
      connectedAt: new Date().toISOString(),
      profile: { id: profile.id, name: profile.name },
      items: connected.length ? connected : (previousAccount?.items || []),
      grantedPermissions: mergedPermissions,
      userAccessToken: token.access_token
    });
    const permissionNote = !pagesError ? "" : `<p style="color:#ffcb6b">Đăng nhập cơ bản thành công, nhưng app chưa đọc lại được Page: ${pagesError}. Hãy kiểm tra quyền Page trong Meta Use Case rồi kết nối lại.</p>`;
    res.type("html").send(`<meta charset="utf-8"><title>Đã kết nối</title><style>body{background:#0b0d10;color:#fff;font:16px system-ui;padding:40px}a{color:#cbff4a}</style><h1>Đã kết nối ${session.platform}</h1><p>Tài khoản: ${profile.name}</p><p>Tìm thấy ${connected.length} tài khoản/Page có thể quản lý.</p>${permissionNote}<p>Bạn có thể đóng tab này và bấm Làm mới trong extension.</p>`);
  } catch (error) {
    res.status(500).send(`OAuth thất bại: ${error.message}`);
  }
});

app.post("/api/publish", async (req, res) => {
  const draft = req.body;
  if (!draft?.caption) return res.status(400).json({ error: "Bản nháp không hợp lệ" });
  if (!draft.sourceUrl) return res.status(400).json({ error: "Thiếu URL nguồn" });
  const publishPlatform = draft.publishPlatform || "facebook";
  const selectedUrls = (Array.isArray(draft.media) ? draft.media : []).map(item => typeof item === "string" ? item : item?.url).filter(Boolean);
  const selectedVideos = selectedUrls.filter(url => (draft.videos || []).includes(url));

  if (publishPlatform === "threads") {
    const requestedThreadsAccountId = String(draft.threadsAccountId || "").trim();
    let bundledThreadsAccount = null;
    if (draft.threadsAuthBundle) {
      try { bundledThreadsAccount = openThreadsAccountBundle(draft.threadsAuthBundle); }
      catch (error) { return res.status(401).json({ error: `${error.message}. Hãy kết nối lại tài khoản Threads.` }); }
    }
    const threads = bundledThreadsAccount || (requestedThreadsAccountId
      ? threadsAccounts.get(requestedThreadsAccountId)
      : (threadsAccounts.get(activeThreadsAccountId) || accounts.get("threads")));
    if (!threads) return res.status(401).json({ error: "Threads chưa kết nối" });
    if (requestedThreadsAccountId && threads.profile?.id !== requestedThreadsAccountId) return res.status(400).json({ error: "Tài khoản Threads đã chọn không khớp thông tin kết nối" });
    if (selectedUrls.length > 20) return res.status(400).json({ error: "Threads hỗ trợ tối đa 20 media mỗi carousel" });
    try {
      const threadsPost = async (path, payload, stage = path) => {
        const form = new URLSearchParams(Object.entries({ ...payload, access_token: threads.userAccessToken }).map(([key, value]) => [key, String(value)]));
        const response = await fetch(`https://graph.threads.net/v1.0/${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const apiError = body.error || {};
          const code = [apiError.code, apiError.error_subcode].filter(value => value !== undefined).join("/");
          const detail = apiError.error_user_msg || apiError.error_data?.details || body.error_message || "";
          const error = new Error(`${stage}: ${apiError.message || "Threads API từ chối yêu cầu"}${code ? ` (#${code})` : ""}${detail ? ` — ${detail}` : ""}`);
          error.httpStatus = response.status;
          error.apiCode = apiError.code;
          throw error;
        }
        return body;
      };
      const threadsGet = async (path, payload = {}) => {
        const params = new URLSearchParams(Object.entries({ ...payload, access_token: threads.userAccessToken }).map(([key, value]) => [key, String(value)]));
        const response = await fetch(`https://graph.threads.net/v1.0/${path}?${params}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(body.error?.message || body.error_message || "Không kiểm tra được trạng thái media Threads");
          error.httpStatus = response.status;
          error.apiCode = body.error?.code;
          throw error;
        }
        return body;
      };
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      const isTransientThreadsError = error =>
        error?.httpStatus === 429 || error?.httpStatus >= 500 || [1, 2, 4, 17, 32, 341].includes(Number(error?.apiCode));
      const isPendingContainerLookup = error =>
        error?.httpStatus === 404 || Number(error?.apiCode) === 24 || /requested resource does not exist|media with id .*cannot be found|4279009/i.test(error?.message || "");
      const waitContainer = async (id, { timeoutMs = 120000, label = "media" } = {}) => {
        const startedAt = Date.now();
        let attempt = 0;
        let lastStatus = "IN_PROGRESS";
        let lastLookupError = null;
        while (Date.now() - startedAt < timeoutMs) {
          try {
            const state = await threadsGet(id, { fields: "id,status,error_message" });
            lastStatus = String(state.status || "IN_PROGRESS").toUpperCase();
            lastLookupError = null;
            if (["FINISHED", "PUBLISHED"].includes(lastStatus)) return state;
            if (["ERROR", "EXPIRED"].includes(lastStatus)) {
              throw new Error(state.error_message || `Threads xử lý ${label} thất bại (${lastStatus})`);
            }
          } catch (error) {
            if (!isTransientThreadsError(error) && !isPendingContainerLookup(error)) throw error;
            lastLookupError = error;
          }
          const delayMs = Math.min(5000, 1200 + attempt * 350);
          await sleep(delayMs);
          attempt += 1;
        }
        const detail = lastLookupError ? ` Lần kiểm tra cuối lỗi: ${lastLookupError.message}` : "";
        throw new Error(`Threads vẫn đang xử lý ${label} sau ${Math.round(timeoutMs / 1000)} giây (trạng thái ${lastStatus}).${detail} Hãy giữ nguyên bản nháp và bấm đăng lại sau.`);
      };
      const publishContainer = async (creationId, label = "bài viết") => {
        await waitContainer(creationId, { timeoutMs: 120000, label });
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await threadsPost("me/threads_publish", { creation_id: creationId }, `Xuất bản ${label}`);
          } catch (error) {
            lastError = error;
            const stillProcessing = /not ready|in.progress|processing|media.*ready|try again/i.test(error.message);
            if ((!stillProcessing && !isTransientThreadsError(error)) || attempt === 2) throw error;
            await sleep(2500 * (attempt + 1));
            await waitContainer(creationId, { timeoutMs: 30000, label });
          }
        }
        throw lastError;
      };
      const waitPublishedThread = async (id, { timeoutMs = 30000, label = "bài viết" } = {}) => {
        const startedAt = Date.now();
        let lastError;
        while (Date.now() - startedAt < timeoutMs) {
          try {
            const thread = await threadsGet(id, { fields: "id,media_type,text,permalink" });
            if (thread?.id) return thread;
          } catch (error) {
            lastError = error;
          }
          await sleep(1500);
        }
        const error = new Error(`Threads đã trả ID nhưng chưa xác nhận ${label} hiển thị.${lastError?.message ? ` ${lastError.message}` : ""}`);
        error.apiCode = lastError?.apiCode;
        error.httpStatus = lastError?.httpStatus;
        throw error;
      };
      const hostThreadsCommentImage = async value => {
        // Threads fetches image_url asynchronously, so keep the public Blob
        // available while the reply container is processed and published.
        return hostPublicCommentImage(value, "threads-comments");
      };
      const createCarouselChildren = async () => {
        const children = new Array(selectedUrls.length);
        const concurrency = 4;
        for (let offset = 0; offset < selectedUrls.length; offset += concurrency) {
          const batch = selectedUrls.slice(offset, offset + concurrency);
          const created = await Promise.all(batch.map(async (url, batchIndex) => {
            const index = offset + batchIndex;
            const isVideo = selectedVideos.includes(url);
            const publicUrl = mediaProxyUrl(url);
            const child = await threadsPost("me/threads", {
              media_type: isVideo ? "VIDEO" : "IMAGE",
              ...(isVideo ? { video_url: publicUrl } : { image_url: publicUrl }),
              is_carousel_item: true
            }, `Tạo ${isVideo ? "video" : "ảnh"} ${index + 1}`);
            if (!child.id) throw new Error(`Threads không tạo được media thứ ${index + 1} trong carousel`);
            return child.id;
          }));
          created.forEach((id, batchIndex) => { children[offset + batchIndex] = id; });
        }
        // Creating a child returns an ID before Threads has finished fetching
        // and processing the public image/video URL. Referencing that ID in a
        // carousel too early produces #24/4279009 (media cannot be found).
        await Promise.all(children.map((id, index) => waitContainer(id, {
          timeoutMs: 120000,
          label: `carousel child ${index + 1}`
        })));
        // Allow the ready state to propagate to the carousel endpoint.
        await sleep(900);
        return children;
      };
      let creation;
      if (selectedUrls.length > 1) {
        const children = await createCarouselChildren();
        let createError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            creation = await threadsPost("me/threads", { media_type: "CAROUSEL", children: children.join(","), text: draft.caption }, "Tạo carousel");
            break;
          } catch (error) {
            createError = error;
            const childNotVisibleYet = /requested resource does not exist|media with id .*cannot be found|4279009/i.test(error.message);
            if (!childNotVisibleYet || attempt === 2) throw error;
            await sleep(1500 * (attempt + 1));
          }
        }
        if (!creation?.id) throw createError || new Error("Threads không tạo được carousel");
      } else {
        const mediaType = selectedVideos.length ? "VIDEO" : selectedUrls.length ? "IMAGE" : "TEXT";
        const publicUrl = selectedUrls[0] ? mediaProxyUrl(selectedUrls[0]) : "";
        creation = await threadsPost("me/threads", { media_type: mediaType, text: draft.caption, ...(mediaType === "IMAGE" ? { image_url: publicUrl } : {}), ...(mediaType === "VIDEO" ? { video_url: publicUrl } : {}) }, `Tạo bài ${mediaType.toLowerCase()}`);
      }
      if (!creation.id) throw new Error("Threads không tạo được media container");
      const published = await publishContainer(creation.id, selectedUrls.length > 1 ? "carousel" : "bài viết");
      if (!published.id) throw new Error("Threads đã nhận container nhưng không trả ID bài viết");
      const commentMessage = [draft.commentText, draft.affiliateLink].map(value => String(value || "").trim()).filter(Boolean).join("\n\n");
      const commentImage = String(draft.commentImage || "").trim();
      let comment = null;
      if ((commentMessage || commentImage) && published.id) {
        // Give the newly published root post a moment to propagate before a
        // reply references it. A failed verification must never fail the post.
        await sleep(1800);
        let replyError;
        let hostedImage;
        let replyCreationId;
        let replyPublishedId;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (commentImage && !hostedImage) hostedImage = await hostThreadsCommentImage(commentImage);
            if (!replyCreationId) {
              const replyContainer = await threadsPost("me/threads", commentImage
                ? { media_type: "IMAGE", ...(commentMessage ? { text: commentMessage } : {}), image_url: hostedImage.url, reply_to_id: published.id }
                : { media_type: "TEXT", text: commentMessage, reply_to_id: published.id }, "Tạo comment Threads");
              if (!replyContainer.id) throw new Error("Threads không trả ID comment container");
              replyCreationId = replyContainer.id;
            }
            // A reply is a normal Threads media container and must go through
            // threads_publish. A container ID alone is not proof it is visible.
            if (!replyPublishedId) {
              const reply = await publishContainer(replyCreationId, "comment Threads");
              if (!reply.id) throw new Error("Threads không trả ID comment");
              replyPublishedId = reply.id;
            }
            const confirmedReply = await waitPublishedThread(replyPublishedId, { timeoutMs: 30000, label: "comment" });
            comment = { ok: true, id: replyPublishedId, permalink: confirmedReply.permalink, imageUrl: hostedImage?.url, pin: { ok: false, error: "Threads API hiện chưa cung cấp endpoint ghim reply." } };
            break;
          } catch (error) {
            replyError = error;
            // Reuse a created container so a retry cannot create duplicate replies.
            if ((!replyCreationId && !isTransientThreadsError(error)) || attempt === 2) break;
            await sleep(1500 * (attempt + 1));
          }
        }
        if (!comment) comment = { ok: false, error: replyError?.message || "Threads không đăng được comment", pin: { ok: false, error: "Threads API hiện chưa cung cấp endpoint ghim reply." } };
      }
      return res.json({ requestId: crypto.randomUUID(), results: [{ platform: "threads", ok: true, postId: published.id, comment }] });
    } catch (error) { return res.status(502).json({ error: error.message }); }
  }

  if (publishPlatform === "tiktok") {
    const tiktok = accounts.get("tiktok");
    if (!tiktok) return res.status(401).json({ error: "TikTok chưa kết nối" });
    if (!selectedUrls.length) return res.status(400).json({ error: "TikTok yêu cầu ít nhất một ảnh hoặc video" });
    try {
      const headers = { Authorization: `Bearer ${tiktok.userAccessToken}`, "Content-Type": "application/json; charset=UTF-8" };
      const creatorResponse = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", { method: "POST", headers, body: "{}" });
      const creator = await creatorResponse.json();
      if (!creatorResponse.ok || creator.error?.code !== "ok") throw new Error(creator.error?.message || "Không đọc được TikTok Creator Info");
      const privacy = creator.data?.privacy_level_options?.includes("SELF_ONLY") ? "SELF_ONLY" : creator.data?.privacy_level_options?.[0];
      const isVideo = selectedVideos.length > 0;
      const endpoint = isVideo ? "video/init/" : "content/init/";
      const payload = isVideo ? {
        post_info: { title: draft.caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
        source_info: { source: "PULL_FROM_URL", video_url: selectedVideos[0] }
      } : {
        post_info: { title: draft.caption.slice(0, 90), description: draft.caption.slice(0, 4000), privacy_level: privacy, disable_comment: false, auto_add_music: true },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: selectedUrls.slice(0, 35) },
        post_mode: "DIRECT_POST", media_type: "PHOTO"
      };
      const postResponse = await fetch(`https://open.tiktokapis.com/v2/post/publish/${endpoint}`, { method: "POST", headers, body: JSON.stringify(payload) });
      const posted = await postResponse.json();
      if (!postResponse.ok || posted.error?.code !== "ok") throw new Error(posted.error?.message || "TikTok từ chối Direct Post; kiểm tra verified URL domain");
      return res.json({ requestId: crypto.randomUUID(), results: [{ platform: "tiktok", ok: true, publishId: posted.data?.publish_id }] });
    } catch (error) { return res.status(502).json({ error: error.message }); }
  }

  const facebook = accounts.get("facebook");
  if (!facebook) return res.status(401).json({ error: "Facebook chưa kết nối" });
  if (!facebook.grantedPermissions?.includes("pages_manage_posts")) return res.status(403).json({ error: "Meta chưa cấp pages_manage_posts cho token này. Hãy hoàn tất quyền trong App Review rồi kết nối lại Facebook" });
  const page = facebook.items?.find(item => item.id === draft.pageId);
  if (!page) return res.status(400).json({ error: "Hãy chọn Facebook Page để đăng" });
  try {
    const selected = (Array.isArray(draft.media) ? draft.media : []).map(item => typeof item === "string" ? item : item?.url).filter(Boolean);
    const videoSet = new Set(draft.videos || []);
    const videoUrls = selected.filter(url => videoSet.has(url) || looksLikeVideoUrl(url));
    const imageUrls = selected.filter(url => !videoSet.has(url) && !looksLikeVideoUrl(url));
    if (videoUrls.length > 1) throw new Error("Hiện chỉ hỗ trợ một video mỗi bài.");
    if (imageUrls.length > (videoUrls.length ? 9 : 10)) throw new Error("Facebook hỗ trợ tối đa 10 media mỗi bài.");

    const graphPost = async (endpoint, payload) => {
      const response = await fetch(`https://graph.facebook.com/${metaVersion}/${page.id}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, access_token: page.accessToken })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "Meta từ chối đăng bài");
      return body;
    };

    const decodeImageDataUrl = value => {
      const imageData = decodeCommentImageDataUrl(value);
      if (imageData && imageData.buffer.length > 3 * 1024 * 1024) throw new Error("Ảnh thêm từ máy vượt giới hạn 3 MB.");
      return imageData;
    };

    const uploadFacebookPhoto = async (value, published, caption = "") => {
      const source = String(value || "");
      const imageData = decodeImageDataUrl(source);
      if (!imageData) return graphPost("photos", { url: source, published, ...(caption ? { caption } : {}) });
      const form = new FormData();
      form.set("source", new Blob([imageData.buffer], { type: imageData.mimeType }), `affiliate-image.${imageData.extension}`);
      form.set("published", String(Boolean(published)));
      if (caption) form.set("caption", caption);
      form.set("access_token", page.accessToken);
      const response = await fetch(`https://graph.facebook.com/${metaVersion}/${page.id}/photos`, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.id) throw new Error(body.error?.message || "Meta từ chối ảnh thêm từ máy.");
      return body;
    };

    // Page video uploads are asynchronous.  Do not attach an unpublished video
    // to a feed post until Facebook has finished transcoding it.
    const waitForFacebookVideo = async videoId => {
      const startedAt = Date.now();
      let lastStatus = "processing";
      let readFailures = 0;
      while (Date.now() - startedAt < 90000) {
        const params = new URLSearchParams({ fields: "status", access_token: page.accessToken });
        let response;
        let body = {};
        try {
          response = await fetch(`https://graph.facebook.com/${metaVersion}/${videoId}?${params}`, { signal: AbortSignal.timeout(15000) });
          body = await response.json().catch(() => ({}));
        } catch (error) {
          readFailures += 1;
          if (readFailures >= 3) return { status: "unknown", detail: error.message };
          await new Promise(resolve => setTimeout(resolve, 2500));
          continue;
        }
        if (!response.ok) {
          readFailures += 1;
          if (readFailures >= 3) return { status: "unknown", detail: body.error?.message };
        } else {
          readFailures = 0;
          const status = body.status || {};
          const videoStatus = String(status.video_status || "").toLowerCase();
          const processingStatus = String(status.processing_phase?.status || "").toLowerCase();
          lastStatus = videoStatus || processingStatus || lastStatus;
          if (["ready", "complete", "completed", "published"].includes(videoStatus) || ["complete", "completed"].includes(processingStatus)) return { status: "ready", detail: status };
          if (["error", "failed"].includes(videoStatus) || ["error", "failed"].includes(processingStatus)) {
            throw new Error(status.processing_phase?.errors?.[0]?.message || "Facebook không xử lý được video trong bài hỗn hợp.");
          }
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      return { status: "timeout", detail: lastStatus };
    };

    let result;
    if (videoUrls.length === 1 && imageUrls.length > 0) {
      const attachedMedia = [];
      for (const url of imageUrls) {
        const photo = await uploadFacebookPhoto(url, false);
        if (!photo.id) throw new Error("Meta không trả ID cho một ảnh trong bài hỗn hợp.");
        attachedMedia.push({ media_fbid: photo.id });
      }
      const prepared = await prepareVideoMp4(videoUrls[0]);
      try {
        const videoFile = await openAsBlob(prepared.outputPath, { type: "video/mp4" });
        const form = new FormData();
        form.set("source", videoFile, "affiliate-video.mp4");
        form.set("published", "false");
        form.set("access_token", page.accessToken);
        const upload = await fetch(`https://graph.facebook.com/${metaVersion}/${page.id}/videos`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(10 * 60 * 1000)
        });
        const video = await upload.json().catch(() => ({}));
        if (!upload.ok || !video.id) throw new Error(video.error?.message || "Meta không trả ID cho video trong bài hỗn hợp.");
        const videoState = await waitForFacebookVideo(video.id);
        if (videoState.status === "timeout") throw new Error(`Facebook vẫn đang xử lý video (${videoState.detail}). Hãy thử đăng lại sau ít phút.`);
        attachedMedia.push({ media_fbid: video.id });
      } finally {
        await fs.rm(prepared.outputPath, { force: true }).catch(() => { });
      }
      result = await graphPost("feed", { message: draft.caption, attached_media: attachedMedia });
    } else if (videoUrls.length === 1) {
      // Facebook CDN URLs are often short-lived streams, so Graph cannot reliably
      // fetch them through file_url. Convert to a local MP4 and upload the bytes.
      const prepared = await prepareVideoMp4(videoUrls[0]);
      try {
        const videoFile = await openAsBlob(prepared.outputPath, { type: "video/mp4" });
        const form = new FormData();
        form.set("source", videoFile, "affiliate-video.mp4");
        form.set("description", draft.caption);
        form.set("access_token", page.accessToken);
        const upload = await fetch(`https://graph.facebook.com/${metaVersion}/${page.id}/videos`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(10 * 60 * 1000)
        });
        const body = await upload.json().catch(() => ({}));
        if (!upload.ok) throw new Error(body.error?.message || "Meta tu choi upload video");
        result = body;
      } finally {
        await fs.rm(prepared.outputPath, { force: true }).catch(() => { });
      }
    } else if (imageUrls.length === 1) {
      result = await uploadFacebookPhoto(imageUrls[0], true, draft.caption);
    } else if (imageUrls.length > 1) {
      const attachedMedia = [];
      for (const url of imageUrls) {
        const photo = await uploadFacebookPhoto(url, false);
        if (!photo.id) throw new Error("Meta không trả ID cho một ảnh trong album.");
        attachedMedia.push({ media_fbid: photo.id });
      }
      result = await graphPost("feed", { message: draft.caption, attached_media: attachedMedia });
    } else {
      result = await graphPost("feed", { message: draft.caption });
    }
    // Compatibility guard for the legacy single-media response check below.
    const response = { ok: true };
    const postId = result.post_id || result.id;
    let commentResult = null;
    let pinResult = null;
    const commentMessage = [draft.commentText, draft.affiliateLink].map(value => String(value || "").trim()).filter(Boolean).join("\n\n");
    const commentImage = String(draft.commentImage || "").trim();
    if ((commentMessage || commentImage) && postId) {
      if (!facebook.grantedPermissions?.includes("pages_manage_engagement")) {
        commentResult = { error: { message: "Token chưa có pages_manage_engagement. Vào Tài khoản > Cấp quyền comment rồi đăng nhập lại." } };
      } else {
        try {
          let attachmentId = "";
          let hostedCommentImage = null;
          const imageErrors = [];
          if (commentImage) {
            try { hostedCommentImage = await hostPublicCommentImage(commentImage, "facebook-comments"); }
            catch (error) { imageErrors.push(`Lưu ảnh comment: ${error.message}`); }
          }
          const commentEndpoint = `https://graph.facebook.com/${metaVersion}/${postId}/comments`;
          const commentPayload = { ...(commentMessage ? { message: commentMessage } : {}), ...(hostedCommentImage?.url ? { attachment_url: hostedCommentImage.url } : {}), access_token: page.accessToken };
          let commentResponse = await fetch(commentEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commentPayload) });
          commentResult = await commentResponse.json().catch(() => ({}));
          if ((!commentResponse.ok || !commentResult.id) && commentResult.error?.message) imageErrors.push(`URL ảnh: ${commentResult.error.message}`);

          // Some Page/API combinations reject attachment_url. Retry with an
          // unpublished Page photo attachment before falling back to multipart.
          if ((!commentResponse.ok || !commentResult.id) && commentImage) {
            try {
              const uploadedCommentImage = await uploadFacebookPhoto(commentImage, false);
              attachmentId = uploadedCommentImage.id || "";
            } catch (error) { imageErrors.push(`Tải ảnh lên Page: ${error.message}`); }
            if (attachmentId) {
              commentResponse = await fetch(commentEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(commentMessage ? { message: commentMessage } : {}), attachment_id: attachmentId, access_token: page.accessToken }) });
              commentResult = await commentResponse.json().catch(() => ({}));
              if ((!commentResponse.ok || !commentResult.id) && commentResult.error?.message) imageErrors.push(`Đính kèm ảnh: ${commentResult.error.message}`);
            }
          }
          // Keep a final multipart fallback for Graph versions that accept a
          // raw source on the comments edge but reject both URL and attachment.
          if ((!commentResponse.ok || !commentResult.id) && commentImage) {
            const imageData = decodeImageDataUrl(commentImage);
            if (imageData) {
              const form = new FormData();
              if (commentMessage) form.set("message", commentMessage);
              form.set("source", new Blob([imageData.buffer], { type: imageData.mimeType }), `affiliate-comment.${imageData.extension}`);
              form.set("access_token", page.accessToken);
              commentResponse = await fetch(commentEndpoint, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
              commentResult = await commentResponse.json().catch(() => ({}));
              if ((!commentResponse.ok || !commentResult.id) && commentResult.error?.message) imageErrors.push(`Multipart ảnh: ${commentResult.error.message}`);
            }
          }

          if (commentResponse.ok && commentResult.id) {
            if (imageErrors.length && commentImage) commentResult.image_error = imageErrors.join(" | ");
            const pinResponse = await fetch(`https://graph.facebook.com/${metaVersion}/${commentResult.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_pinned: true, access_token: page.accessToken }) });
            pinResult = await pinResponse.json();
          } else if (!commentResult.error) {
            commentResult = { error: { message: "Meta từ chối ảnh trong comment." } };
          }
          // A Page may have permission to comment but not permission to attach
          // media to comments. Preserve the useful text/link comment instead
          // of reporting the whole operation as failed.
          if ((!commentResult?.id) && commentMessage && commentImage) {
            const textOnlyResponse = await fetch(commentEndpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: commentMessage, access_token: page.accessToken })
            });
            const textOnly = await textOnlyResponse.json().catch(() => ({}));
            if (textOnlyResponse.ok && textOnly.id) {
              commentResult = { ...textOnly, image_error: imageErrors.join(" | ") || commentResult.error?.message || "Meta không cho phép đính kèm ảnh comment." };
              const pinResponse = await fetch(`https://graph.facebook.com/${metaVersion}/${textOnly.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_pinned: true, access_token: page.accessToken }) });
              pinResult = await pinResponse.json();
            } else if (textOnly.error?.message) {
              commentResult = { error: { message: `${commentResult.error?.message || "Không đăng được comment ảnh"} | Comment chữ cũng thất bại: ${textOnly.error.message}` } };
            }
          }
        } catch (error) {
          commentResult = { error: { message: error.message } };
        }
      }
    }
    return res.json({ requestId: crypto.randomUUID(), results: [{ platform: "facebook", pageId: page.id, ok: true, postId, comment: commentResult ? { ok: Boolean(commentResult.id), id: commentResult.id, error: commentResult.error?.message, imageError: commentResult.image_error } : null, pin: pinResult ? { ok: Boolean(pinResult.success || !pinResult.error), error: pinResult.error?.message } : null }] });
    if (!response.ok) throw new Error(result.error?.message || "Meta từ chối đăng bài");
    res.json({ requestId: crypto.randomUUID(), results: [{ platform: "facebook", pageId: page.id, ok: true, postId: result.post_id || result.id }] });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// Vercel imports this module as a serverless function; local development still
// starts a normal Express listener.
export default app;
if (!process.env.VERCEL) app.listen(port, () => console.log(`Affiliate Content Studio server: http://localhost:${port}`));
