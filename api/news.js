import Parser from "rss-parser";
import he from "he";
import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

const FEEDS = {
  world: [
    { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { name: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
    { name: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  ],
  ai: [
    { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
    { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  ],
  tech: [
    { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
    { name: "WIRED", url: "https://www.wired.com/feed/rss" },
    { name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  ],
  sports: [
    { name: "BBC Sport", url: "https://feeds.bbci.co.uk/sport/rss.xml" },
    { name: "The Guardian Sport", url: "https://www.theguardian.com/sport/rss" },
    { name: "ESPN", url: "https://www.espn.com/espn/rss/news" },
  ],
  politics: [
    { name: "BBC News", url: "https://feeds.bbci.co.uk/news/politics/rss.xml" },
    { name: "The Guardian", url: "https://www.theguardian.com/politics/rss" },
    { name: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml" },
  ],
};

const DEFAULT_CATEGORY = "world";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const PER_FEED_CAP = 25;
const FETCH_TIMEOUT_MS = 8000;
const SUMMARY_MAX = 250;

const FALLBACK_IMAGES = {
  world: "https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1200&q=80",
  ai: "https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=1200&q=80",
  tech: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80",
  sports: "https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1200&q=80",
  politics: "https://images.unsplash.com/photo-1541872703-74c5e44368f9?auto=format&fit=crop&w=1200&q=80",
};

const USER_AGENT =
  "Mozilla/5.0 (compatible; GlobalNewsAPI/1.0; +https://vercel.com) RSS-Aggregator";

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "dcCreator"],
    ],
  },
});

/* -------------------------------------------------------------------------- */
/*  Helpers: text                                                             */
/* -------------------------------------------------------------------------- */

function stripHtml(input = "") {
  if (!input) return "";
  const noBlocks = String(input)
    .replace(/<(script|style|iframe|noscript|form|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return he
    .decode(noBlocks)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSummary(raw) {
  let text = stripHtml(raw);
  // Remove common boilerplate appended by feeds
  text = text
    .replace(/\s*(The post .+? appeared first on .+?\.?|Read more\.{0,3}|Continue reading\.{0,3}|\[…\]|\[\.\.\.\])\s*$/i, "")
    .trim();
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 150 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:\-–—\s]+$/, "") + "…";
}

function cleanAuthor(item, sourceName) {
  let author = item.creator || item.dcCreator || item.author || "";
  if (Array.isArray(author)) author = author.join(", ");
  author = stripHtml(String(author));
  // "email@site.com (Jane Doe)" -> "Jane Doe"
  const paren = author.match(/\(([^)]+)\)/);
  if (paren && author.includes("@")) author = paren[1];
  author = author.replace(/<?[^\s<>]+@[^\s<>]+>?/g, "").replace(/^by\s+/i, "").trim();
  return author || `${sourceName} Editorial`;
}

function canonicalUrl(link) {
  try {
    const u = new URL(String(link).trim());
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|at_|ocid|cmpid|ftag|xtor|source$|ns_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    if (u.protocol === "http:") u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

function makeId(url, title) {
  return createHash("sha1").update(url || title).digest("hex").slice(0, 16);
}

/* -------------------------------------------------------------------------- */
/*  Helpers: images                                                           */
/* -------------------------------------------------------------------------- */

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;

function toHttps(raw, base) {
  if (!raw || typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.startsWith("data:")) return null;
  if (value.startsWith("//")) value = "https:" + value;
  try {
    const u = new URL(value, base);
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

// BBC's feeds serve 240px thumbnails; swap the size segment for a larger one.
function upscale(url) {
  return url.replace(/(ichef\.bbci\.co\.uk\/(?:news|ace\/standard)\/)\d+(\/)/, "$1976$2");
}

function isImageNode(attrs = {}) {
  const type = (attrs.type || "").toLowerCase();
  const medium = (attrs.medium || "").toLowerCase();
  if (type.startsWith("image/") || medium === "image") return true;
  if (type.startsWith("video/") || medium === "video" || type.startsWith("audio/")) return false;
  return IMG_EXT.test(attrs.url || "");
}

function firstImgFromHtml(html) {
  if (!html) return null;
  const regex = /<img\b[^>]*?\b(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = regex.exec(html))) {
    const src = m[1];
    // skip tracking pixels / tiny icons / emoji
    if (/(pixel|tracker|beacon|1x1|spacer|emoji|avatar|logo)/i.test(src)) continue;
    const w = m[0].match(/\bwidth\s*=\s*["']?(\d+)/i);
    if (w && Number(w[1]) < 50) continue;
    return src;
  }
  return null;
}

function extractImage(item, category) {
  const candidates = [];

  // 1. <media:content> – prefer widest
  const mc = (item.mediaContent || [])
    .map((n) => n?.$ || {})
    .filter((a) => a.url && isImageNode(a))
    .sort((a, b) => Number(b.width || 0) - Number(a.width || 0));
  mc.forEach((a) => candidates.push(a.url));

  // 2. <enclosure>
  if (item.enclosure?.url && isImageNode(item.enclosure)) candidates.push(item.enclosure.url);

  // 3. <media:thumbnail> – prefer widest
  (item.mediaThumbnail || [])
    .map((n) => n?.$ || {})
    .filter((a) => a.url)
    .sort((a, b) => Number(b.width || 0) - Number(a.width || 0))
    .forEach((a) => candidates.push(a.url));

  // 4. inline <img> in body HTML
  const htmlImg =
    firstImgFromHtml(item.contentEncoded) ||
    firstImgFromHtml(item["content:encoded"]) ||
    firstImgFromHtml(item.content) ||
    firstImgFromHtml(item.description) ||
    firstImgFromHtml(item.summary);
  if (htmlImg) candidates.push(htmlImg);

  for (const c of candidates) {
    const https = toHttps(c, item.link);
    if (https) return upscale(https);
  }
  return FALLBACK_IMAGES[category] || FALLBACK_IMAGES.world;
}

/* -------------------------------------------------------------------------- */
/*  Feed fetching                                                             */
/* -------------------------------------------------------------------------- */

async function fetchFeed(feed, category) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const xml = await res.text();
    const parsed = await parser.parseString(xml);

    return (parsed.items || []).slice(0, PER_FEED_CAP).flatMap((item) => {
      const title = stripHtml(item.title);
      const sourceUrl = canonicalUrl(item.link || item.guid);
      const date = new Date(item.isoDate || item.pubDate || "");
      if (!title || !sourceUrl || Number.isNaN(date.getTime())) return [];

      return [
        {
          id: makeId(sourceUrl, title),
          title,
          summary: cleanSummary(item.contentSnippet || item.contentEncoded || item.content || item.summary || ""),
          author: cleanAuthor(item, feed.name),
          sourceName: feed.name,
          sourceUrl,
          imageUrl: extractImage(item, category),
          publishedAt: date.toISOString(),
          category,
        },
      ];
    });
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Handler                                                                   */
/* -------------------------------------------------------------------------- */

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const requested = String(req.query?.category || DEFAULT_CATEGORY).toLowerCase().trim();
  const category = FEEDS[requested] ? requested : DEFAULT_CATEGORY;

  const limitParam = parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const feeds = FEEDS[category];
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f, category)));

  const errors = [];
  const merged = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") merged.push(...r.value);
    else errors.push({ source: feeds[i].name, url: feeds[i].url, reason: r.reason?.message || "Unknown error" });
  });

  // De-duplicate by id (same URL syndicated by multiple feeds)
  const seen = new Set();
  const articles = merged
    .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit);

  // Every feed failed -> don't let the CDN cache an error
  if (articles.length === 0) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({
      error: "All upstream news feeds are currently unavailable",
      category,
      errors,
    });
    return;
  }

  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    category,
    count: articles.length,
    updatedAt: new Date().toISOString(),
    sourcesFailed: errors.length,
    errors,
    articles,
  });
}
