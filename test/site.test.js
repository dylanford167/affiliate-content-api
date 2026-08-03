import test from "node:test";
import assert from "node:assert/strict";
import { DOWNLOADER_PATHS, renderDownloaderPage, renderRobots, renderSitemap } from "../src/site.js";

test("every public route renders one canonical and useful metadata", () => {
  const titles = new Set();
  for (const pathname of DOWNLOADER_PATHS) {
    const html = renderDownloaderPage(pathname);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = html.match(/<meta name="description" content="([^"]+)">/)?.[1];
    const canonicals = html.match(/<link rel="canonical"/g) || [];

    assert.ok(title, `missing title for ${pathname}`);
    assert.ok(description && description.length >= 50, `weak description for ${pathname}`);
    assert.equal(canonicals.length, 1, `canonical count for ${pathname}`);
    assert.equal(titles.has(title), false, `duplicate title: ${title}`);
    titles.add(title);
  }
});

test("downloader landing pages include a working form and structured data", () => {
  for (const pathname of ["/", "/facebook-video-downloader", "/pinterest-video-downloader", "/threads-video-downloader"]) {
    const html = renderDownloaderPage(pathname);
    assert.match(html, /id="resolve-form"/);
    assert.match(html, /id="media-url"/);
    assert.match(html, /WebApplication/);
    assert.match(html, /FAQPage/);
  }
});

test("robots and sitemap expose public pages but exclude APIs", () => {
  const robots = renderRobots();
  const sitemap = renderSitemap();
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/rymz\.space\/sitemap\.xml/);
  assert.match(sitemap, /facebook-video-downloader/);
  assert.match(sitemap, /guides\/video-quality-explained/);
  assert.doesNotMatch(sitemap, /\/api\/downloader/);
});

test("legal and monetization readiness pages are present", () => {
  for (const pathname of ["/privacy", "/terms", "/copyright", "/contact", "/pricing", "/api"]) {
    assert.ok(DOWNLOADER_PATHS.includes(pathname));
    assert.match(renderDownloaderPage(pathname), /<h1>/);
  }
});
