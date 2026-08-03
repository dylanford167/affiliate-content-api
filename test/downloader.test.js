import test from "node:test";
import assert from "node:assert/strict";
import { extractPublicMedia } from "../src/downloader.js";

test("extracts only declared public media and ignores unrelated page images", () => {
  const html = `
    <meta property="og:title" content="Bài thử nghiệm">
    <meta property="og:image" content="https://i.pinimg.com/originals/a/b/c/photo.jpg">
    <meta property="og:video:secure_url" content="https://video.fbcdn.net/media/video.mp4?token=abc">
    <img src="https://i.pinimg.com/avatar.jpg">
  `;
  const result = extractPublicMedia(html, "https://www.pinterest.com/pin/123/");

  assert.equal(result.title, "Bài thử nghiệm");
  assert.deepEqual(result.media.map(item => item.type), ["video", "image"]);
  assert.equal(result.media.some(item => item.url.includes("avatar.jpg")), false);
});

test("extracts JSON-LD video content URLs", () => {
  const html = `<script type="application/ld+json">{
    "@type":"VideoObject",
    "contentUrl":"https://scontent.fbcdn.net/media/source.mp4",
    "thumbnailUrl":"https://scontent.fbcdn.net/media/poster.jpg"
  }</script>`;
  const result = extractPublicMedia(html, "https://www.facebook.com/example/videos/123");

  assert.equal(result.media.length, 2);
  assert.equal(result.media[0].type, "video");
  assert.equal(result.media[1].type, "image");
});

test("does not collect arbitrary image URLs from embedded page data", () => {
  const html = `<script>window.data={"avatar":"https://i.pinimg.com/avatar.jpg"}</script>`;
  const result = extractPublicMedia(html, "https://www.pinterest.com/pin/123/");
  assert.equal(result.media.length, 0);
});
