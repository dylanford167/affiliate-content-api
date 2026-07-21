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

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(serverDirectory, ".env") });

const app = express();
const port = Number(process.env.PORT || 8787);
const accounts = new Map(); // MVP only: replace with encrypted DB storage.
const oauthStates = new Map();
const preparedMedia = new Map();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const metaVersion = process.env.META_GRAPH_VERSION || "v23.0";
app.use(cors({ origin: /^chrome-extension:\/\// }));
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Affiliate Content Studio Server</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#f6f7f8;font:16px/1.55 system-ui,sans-serif}.card{width:min(560px,calc(100% - 40px));padding:32px;border:1px solid #293039;border-radius:20px;background:#15191e;box-shadow:0 24px 80px #0008}.status{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;background:#202a1d;color:#cbff4a;font-size:13px;font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:#cbff4a;box-shadow:0 0 12px #cbff4a}h1{font-size:28px;line-height:1.15;margin:18px 0 10px}p{color:#aeb7c1}ol{padding-left:20px;color:#d8dde2}code{padding:3px 6px;border-radius:5px;background:#0b0d10;color:#c9b9ff}a{color:#cbff4a}</style>
</head><body><main class="card"><span class="status"><i class="dot"></i>Server đang hoạt động</span><h1>Affiliate Content Studio</h1><p>Server API đã sẵn sàng tại cổng <code>${port}</code>.</p><ol><li>Giữ cửa sổ terminal đang chạy.</li><li>Mở một bài mạng xã hội được hỗ trợ.</li><li>Mở Chrome Extension và bấm <b>Quét bài viết hiện tại</b>.</li></ol><p>Kiểm tra kỹ thuật: <a href="/health">/health</a></p></main></body></html>`);
});
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/accounts", (_req, res) => res.json(Object.fromEntries([...accounts].map(([key, value]) => [key, {
  connected: true,
  profile: value.profile,
  grantedPermissions: value.grantedPermissions || [],
  canPublish: (value.grantedPermissions || []).includes("pages_manage_posts"),
  canComment: (value.grantedPermissions || []).includes("pages_manage_engagement"),
  items: (value.items || []).map(item => ({ id: item.id, name: item.name, username: item.username, pageId: item.pageId, pageName: item.pageName }))
}]))));

const allowedMediaHosts = ["facebook.com", "fbcdn.net", "cdninstagram.com", "instagram.com", "threads.net", "threads.com", "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "ibytedtos.com", "muscdn.com", "akamaized.net"];
function assertAllowedMediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedMediaHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error("URL video không thuộc CDN mạng xã hội được hỗ trợ");
  return url.href;
}

const mediaProxySecret = process.env.MEDIA_PROXY_SECRET || process.env.THREADS_APP_SECRET || process.env.META_APP_SECRET || "development-only";
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
    await fs.rm(outputPath, { force: true }).catch(() => {});
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
    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
    res.status(422).json({ error: error.message });
  }
});

app.get("/api/media/download/:id", (req, res) => {
  const media = preparedMedia.get(req.params.id);
  if (!media) return res.status(404).json({ error: "Video đã hết hạn hoặc không tồn tại" });
  res.download(media.path, "video.mp4", error => {
    if (!error) preparedMedia.delete(req.params.id);
    if (!error) fs.rm(media.path, { force: true }).catch(() => {});
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
    const state = crypto.randomUUID();
    oauthStates.set(state, { platform, createdAt: Date.now() });
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: `${publicBaseUrl}/auth/threads/callback`, scope: process.env.THREADS_SCOPES || "threads_basic,threads_content_publish,threads_manage_replies", response_type: "code", state });
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
  const state = String(req.query.state || ""); const session = oauthStates.get(state); oauthStates.delete(state);
  if (!session || session.platform !== "threads") return res.status(400).send("Threads OAuth state không hợp lệ.");
  if (req.query.error || !req.query.code) return res.status(400).send(`Threads từ chối: ${req.query.error_message || req.query.error || "missing code"}`);
  try {
    const form = new URLSearchParams({ client_id: process.env.THREADS_APP_ID, client_secret: process.env.THREADS_APP_SECRET, grant_type: "authorization_code", redirect_uri: `${publicBaseUrl}/auth/threads/callback`, code: String(req.query.code) });
    const tokenResponse = await fetch("https://graph.threads.net/oauth/access_token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const token = await tokenResponse.json(); if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_message || token.error?.message || "Không lấy được token");
    const profileResponse = await fetch(`https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(token.access_token)}`);
    const profile = await profileResponse.json(); if (!profileResponse.ok) throw new Error(profile.error?.message || "Không đọc được Threads profile");
    accounts.set("threads", { connectedAt: new Date().toISOString(), profile, items: [{ id: profile.id, name: profile.username }], grantedPermissions: (process.env.THREADS_SCOPES || "").split(","), userAccessToken: token.access_token });
    res.type("html").send(`<meta charset="utf-8"><h1>Đã kết nối Threads</h1><p>@${profile.username}</p><p>Đóng tab này và bấm Làm mới trong extension.</p>`);
  } catch (error) { res.status(500).send(`Threads OAuth thất bại: ${error.message}`); }
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
    const pagesResponse = await fetch(`https://graph.facebook.com/${metaVersion}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(token.access_token)}`);
    const pages = await pagesResponse.json();
    const pageData = pagesResponse.ok && Array.isArray(pages.data) ? pages.data : [];
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
    const permissionNote = pagesResponse.ok ? "" : `<p style="color:#ffcb6b">Đăng nhập cơ bản thành công, nhưng app chưa có quyền đọc Page. Hãy thêm quyền Page trong Meta Use Case rồi cập nhật META_${session.platform.toUpperCase()}_SCOPES.</p>`;
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
    const threads = accounts.get("threads");
    if (!threads) return res.status(401).json({ error: "Threads chưa kết nối" });
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
          throw new Error(`${stage}: ${apiError.message || "Threads API từ chối yêu cầu"}${code ? ` (#${code})` : ""}${detail ? ` — ${detail}` : ""}`);
        }
        return body;
      };
      const threadsGet = async (path, payload = {}) => {
        const params = new URLSearchParams(Object.entries({ ...payload, access_token: threads.userAccessToken }).map(([key, value]) => [key, String(value)]));
        const response = await fetch(`https://graph.threads.net/v1.0/${path}?${params}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error?.message || body.error_message || "Không kiểm tra được trạng thái media Threads");
        return body;
      };
      const waitContainer = async id => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const state = await threadsGet(id, { fields: "status,error_message" });
          if (["FINISHED", "PUBLISHED"].includes(state.status)) return;
          if (["ERROR", "EXPIRED"].includes(state.status)) throw new Error(state.error_message || `Threads xử lý media thất bại (${state.status})`);
          await new Promise(resolve => setTimeout(resolve, 1250));
        }
        throw new Error("Threads xử lý media quá lâu; hãy thử đăng lại sau.");
      };
      let creation;
      if (selectedUrls.length > 1) {
        const children = [];
        for (const [index, url] of selectedUrls.entries()) {
          const isVideo = selectedVideos.includes(url);
          const publicUrl = mediaProxyUrl(url);
          const child = await threadsPost("me/threads", { media_type: isVideo ? "VIDEO" : "IMAGE", ...(isVideo ? { video_url: publicUrl } : { image_url: publicUrl }), is_carousel_item: true }, `Tạo ${isVideo ? "video" : "ảnh"} ${index + 1}`);
          if (!child.id) throw new Error("Threads không tạo được carousel item");
          if (isVideo) await waitContainer(child.id);
          children.push(child.id);
        }
        creation = await threadsPost("me/threads", { media_type: "CAROUSEL", children: children.join(","), text: draft.caption }, "Tạo carousel");
      } else {
        const mediaType = selectedVideos.length ? "VIDEO" : selectedUrls.length ? "IMAGE" : "TEXT";
        const publicUrl = selectedUrls[0] ? mediaProxyUrl(selectedUrls[0]) : "";
        creation = await threadsPost("me/threads", { media_type: mediaType, text: draft.caption, ...(mediaType === "IMAGE" ? { image_url: publicUrl } : {}), ...(mediaType === "VIDEO" ? { video_url: publicUrl } : {}) }, `Tạo bài ${mediaType.toLowerCase()}`);
      }
      if (!creation.id) throw new Error("Threads không tạo được media container");
      if (selectedUrls.length) await waitContainer(creation.id);
      const publishForm = new URLSearchParams({ creation_id: creation.id, access_token: threads.userAccessToken });
      const publishResponse = await fetch("https://graph.threads.net/v1.0/me/threads_publish", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: publishForm });
      const published = await publishResponse.json();
      if (!publishResponse.ok) throw new Error(published.error?.message || "Threads từ chối xuất bản");
      const commentMessage = [draft.commentText, draft.affiliateLink].map(value => String(value || "").trim()).filter(Boolean).join("\n\n");
      let comment = null;
      if (commentMessage && published.id) {
        try {
          const replyCreation = await threadsPost("me/threads", { media_type: "TEXT", text: commentMessage, reply_to_id: published.id }, "Tạo comment Threads");
          const reply = await threadsPost("me/threads_publish", { creation_id: replyCreation.id }, "Đăng comment Threads");
          comment = { ok: Boolean(reply.id), id: reply.id, pin: { ok: false, error: "Threads API hiện chưa cung cấp endpoint ghim reply." } };
        } catch (error) { comment = { ok: false, error: error.message, pin: { ok: false, error: "Threads API hiện chưa cung cấp endpoint ghim reply." } }; }
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

    let result;
    if (videoUrls.length === 1 && imageUrls.length > 0) {
      const attachedMedia = [];
      for (const url of imageUrls) {
        const photo = await graphPost("photos", { url, published: false });
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
        attachedMedia.push({ media_fbid: video.id });
      } finally {
        await fs.rm(prepared.outputPath, { force: true }).catch(() => {});
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
        await fs.rm(prepared.outputPath, { force: true }).catch(() => {});
      }
    } else if (imageUrls.length === 1) {
      result = await graphPost("photos", { url: imageUrls[0], caption: draft.caption });
    } else if (imageUrls.length > 1) {
      const attachedMedia = [];
      for (const url of imageUrls) {
        const photo = await graphPost("photos", { url, published: false });
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
    if (commentMessage && postId) {
      if (!facebook.grantedPermissions?.includes("pages_manage_engagement")) {
        commentResult = { error: { message: "Token chưa có pages_manage_engagement. Vào Tài khoản > Cấp quyền comment rồi đăng nhập lại." } };
      } else {
        const commentResponse = await fetch(`https://graph.facebook.com/${metaVersion}/${postId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: commentMessage, access_token: page.accessToken }) });
        commentResult = await commentResponse.json();
        if (commentResponse.ok && commentResult.id) {
          const pinResponse = await fetch(`https://graph.facebook.com/${metaVersion}/${commentResult.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_pinned: true, access_token: page.accessToken }) });
          pinResult = await pinResponse.json();
        }
      }
    }
    return res.json({ requestId: crypto.randomUUID(), results: [{ platform: "facebook", pageId: page.id, ok: true, postId, comment: commentResult ? { ok: Boolean(commentResult.id), id: commentResult.id, error: commentResult.error?.message } : null, pin: pinResult ? { ok: Boolean(pinResult.success || !pinResult.error), error: pinResult.error?.message } : null }] });
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
