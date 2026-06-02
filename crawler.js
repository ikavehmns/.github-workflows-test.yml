// crawler.js - اجرا می‌شه روی GitHub Actions
// ورودی‌ها از environment variables می‌آن

const TITLE_EN = process.env.TITLE_EN || "";
const TITLE_FA = process.env.TITLE_FA || "";
const TYPE = process.env.TYPE || "movie"; // movie یا tv
const SEASON = process.env.SEASON || null;
const EPISODE = process.env.EPISODE || null;
const ORIGINAL_LANG = process.env.ORIGINAL_LANG || "en";

// اطلاعات برگشت به Worker
const KV_WRITE_URL = process.env.KV_WRITE_URL || ""; // آدرس Worker برای ذخیره نتیجه
const CACHE_KEY = process.env.CACHE_KEY || "";
const CHAT_ID = process.env.CHAT_ID || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";

const SOURCES = [
  { url: "https://www.film2movie.asia", name: "Film2Movie" },
  { url: "https://www.uptvs.com", name: "UpTV" }
];

// ── تابع اصلی ──
async function main() {
  console.log(`🔍 شروع جستجو: ${TITLE_EN} / ${TITLE_FA} [${TYPE}]`);
  if (SEASON) console.log(`📺 فصل ${SEASON} قسمت ${EPISODE}`);

  const links = await searchAll();

  if (links.length > 0) {
    console.log(`✅ ${links.length} لینک پیدا شد`);
    await saveAndNotify(links);
  } else {
    console.log("❌ لینکی پیدا نشد");
    await notifyUser([]);
  }
}

async function searchAll() {
  const results = await Promise.all(
    SOURCES.map(s => searchSite(s.url, s.name))
  );
  const combined = results.flat();
  // حذف تکراری
  const seen = new Set();
  return combined.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  }).slice(0, 15);
}

async function searchSite(baseUrl, sourceName) {
  const query = ORIGINAL_LANG === "fa" ? TITLE_FA : TITLE_EN;
  if (!query) return [];

  // لایه ۱: WP REST API
  try {
    const apiUrl = `${baseUrl}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`;
    console.log(`📡 API ${sourceName}: ${apiUrl}`);
    const res = await fetchWithTimeout(apiUrl, 8000);
    console.log(`وضعیت ${sourceName}: ${res.status}`);

    if (res.ok) {
      const posts = await res.json();
      if (posts && posts.length > 0) {
        const matched = findBestPost(posts);
        if (matched) {
          console.log(`🔗 پست پیدا شد: ${matched.link}`);
          const links = await extractFromUrl(matched.link, sourceName);
          if (links.length > 0) return links;
        }
      }
    }
  } catch (e) {
    console.log(`⚠️ خطای API ${sourceName}: ${e.message}`);
  }

  // لایه ۲: HTML Fallback
  return await htmlFallback(baseUrl, query, sourceName);
}

function findBestPost(posts) {
  const normEn = normalizeTitle(TITLE_EN);
  const normFa = normalizeTitle(TITLE_FA);

  for (const post of posts) {
    const normTitle = normalizeTitle(post.title?.rendered || "");
    const linkLower = (post.link || "").toLowerCase();

    // چک نوع اثر
    const isSeries = linkLower.includes("/serial") || linkLower.includes("/series") ||
      normTitle.includes("سریال") || normTitle.includes("فصل");
    if (TYPE === "tv" && linkLower.includes("/movie") && !isSeries) continue;
    if (TYPE === "movie" && isSeries) continue;

    // چک نام اثر
    if (normTitle.includes(normEn) || normTitle.includes(normFa) ||
      linkLower.includes(normEn) || similarity(normTitle, normEn) > 0.75) {
      return post;
    }
  }
  return null;
}

async function htmlFallback(baseUrl, query, sourceName) {
  try {
    const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
    console.log(`📡 HTML Fallback ${sourceName}: ${searchUrl}`);
    const res = await fetchWithTimeout(searchUrl, 8000);
    if (!res.ok) return [];

    const html = await res.text();
    const postUrl = findPostUrl(html, baseUrl);
    if (postUrl) {
      console.log(`🔗 پست از HTML: ${postUrl}`);
      return await extractFromUrl(postUrl, sourceName);
    }
  } catch (e) {
    console.error(`خطا HTML fallback ${sourceName}: ${e.message}`);
  }
  return [];
}

function findPostUrl(html, baseUrl) {
  const cleanBase = baseUrl.replace(/^https?:\/\/(www\.)?/, '');
  const regex = new RegExp(`href="(https?://(?:www\\.)?${cleanBase.replace(/\./g, '\\.')}/[^"]+)"`, 'g');
  const matches = [...html.matchAll(regex)];
  const normEn = normalizeTitle(TITLE_EN).replace(/\s+/g, "-");
  const normFa = normalizeTitle(TITLE_FA);

  for (const match of matches) {
    const url = match[1];
    const urlLower = url.toLowerCase();
    if (urlLower.includes("/category/") || urlLower.includes("/tag/") ||
      urlLower.includes("/page/") || urlLower.includes("/wp-") ||
      urlLower.includes("/feed") || urlLower.includes("/author/")) continue;

    const urlNorm = normalizeTitle(urlLower);
    if (urlNorm.includes(normEn) || urlNorm.includes(normFa)) {
      const isSeries = urlLower.includes("serial") || urlLower.includes("series");
      if (TYPE === "tv" && urlLower.includes("/movie") && !isSeries) continue;
      if (TYPE === "movie" && isSeries) continue;
      return url;
    }
  }
  return null;
}

async function extractFromUrl(postUrl, sourceName) {
  try {
    const res = await fetchWithTimeout(postUrl, 8000);
    if (!res.ok) return [];
    const html = await res.text();

    // روش ۱: WP API
    const postIdMatch = html.match(/(?:post-|postid-|"postId":|postid=)(\d+)/i);
    if (postIdMatch) {
      const postId = postIdMatch[1];
      const baseUrl = new URL(postUrl).origin;
      const endpoints = [
        `/wp-json/wp/v2/posts/${postId}?_embed`,
        `/wp-json/acf/v3/posts/${postId}`,
        `/wp-json/wp/v2/movie/${postId}`
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetchWithTimeout(baseUrl + ep, 5000);
          if (!r.ok) continue;
          const jsonStr = JSON.stringify(await r.json());
          const links = extractLinks(jsonStr, sourceName);
          if (links.length > 0) return links;
        } catch (e) { continue; }
      }
    }

    // روش ۲: HTML scraping
    return extractLinks(html, sourceName);
  } catch (e) {
    console.error(`خطا در extract ${sourceName}: ${e.message}`);
    return [];
  }
}

function extractLinks(html, sourceName) {
  const regex = /(https?:\/\/[^\s"'><\\]+\.(?:mkv|mp4|avi|zip|rar)(?:\?[^\s"'><\\]*)?)/gi;
  const matches = [...html.matchAll(regex)];
  const seen = new Set();
  const links = [];

  let filterRegex = null;
  if (SEASON && EPISODE) {
    const s = parseInt(SEASON);
    const e = parseInt(EPISODE);
    filterRegex = new RegExp(
      `s0*${s}[._-]*e0*${e}(?![0-9])|0*${s}x0*${e}(?![0-9])`, "i"
    );
  }

  for (const match of matches) {
    const url = match[1];
    if (seen.has(url)) continue;

    if (filterRegex && !filterRegex.test(url)) {
      const s = parseInt(SEASON);
      const e = parseInt(EPISODE);
      const fallbacks = [
        new RegExp(`[/_-]0*${s}[/_-]0*${e}(?![0-9])`, "i"),
        new RegExp(`season[._\\s-]?0*${s}[^0-9]+0*${e}(?![0-9])`, "i"),
        e < 10
          ? new RegExp(`[/_-]0*${s}0${e}[._-]`, "i")
          : new RegExp(`[/_-]0*${s}${e}[._-]`, "i")
      ];
      if (!fallbacks.some(p => p.test(url))) continue;
    }

    seen.add(url);
    links.push({ label: getLabel(url, sourceName), url });
  }
  return links;
}

// ── ذخیره در KV و اطلاع‌رسانی به کاربر ──
async function saveAndNotify(links) {
  // ذخیره در KV از طریق Worker endpoint
  if (KV_WRITE_URL && CACHE_KEY) {
    try {
      await fetch(KV_WRITE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: CACHE_KEY, links })
      });
      console.log("✅ لینک‌ها در KV ذخیره شدند");
    } catch (e) {
      console.error("خطا در ذخیره KV:", e.message);
    }
  }
  await notifyUser(links);
}

async function notifyUser(links) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("BOT_TOKEN یا CHAT_ID تنظیم نشده");
    return;
  }

  if (links.length === 0) {
    await sendTelegram("sendMessage", {
      chat_id: CHAT_ID,
      text: "😔 متأسفانه لینک دانلود پیدا نشد.",
    });
    return;
  }

  const titleDisplay = TITLE_FA || TITLE_EN;
  const seasonInfo = SEASON ? ` (فصل ${SEASON} قسمت ${EPISODE})` : "";
  const keyboard = links.map(l => [{ text: l.label, url: l.url }]);

  await sendTelegram("sendMessage", {
    chat_id: CHAT_ID,
    text: `📥 لینک‌های دانلود **${titleDisplay}${seasonInfo}**:\n\n`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendTelegram(method, payload) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// ── توابع کمکی ──
async function fetchWithTimeout(url, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

function getLabel(url, sourceName) {
  const lower = url.toLowerCase();
  let type = "زبان اصلی", emoji = "🎬";
  if (lower.includes("dub") || lower.includes("doble") || lower.includes("farsi-dubbed")) {
    type = "دوبله"; emoji = "🎙";
  } else if (lower.includes("sub") || lower.includes("subbed") || lower.includes("farsi.sub")) {
    type = "زیرنویس"; emoji = "📝";
  }
  let quality = "نامشخص";
  if (lower.includes("2160p") || lower.includes("4k")) quality = "4K";
  else if (lower.includes("1080p")) quality = "1080p";
  else if (lower.includes("720p")) quality = "720p";
  else if (lower.includes("480p")) quality = "480p";
  let codec = lower.includes("x265") || lower.includes("hevc") ? " x265" : "";
  return `${emoji} ${type} ${sourceName} کیفیت ${quality}${codec}`;
}

function normalizeTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi)$/gi, "")
    .replace(/[._\-]/g, " ")
    .replace(/\(\d{4}\)/g, "")
    .replace(/\d{4}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  a = normalizeTitle(a); b = normalizeTitle(b);
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  return (longer.length - editDistance(longer, shorter)) / longer.length;
}

function editDistance(a, b) {
  const costs = [];
  for (let i = 0; i <= a.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= b.length; j++) {
      if (i === 0) { costs[j] = j; }
      else if (j > 0) {
        let newValue = costs[j - 1];
        if (a[i - 1] !== b[j - 1]) newValue = Math.min(newValue, lastValue, costs[j]) + 1;
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[b.length] = lastValue;
  }
  return costs[b.length];
}

main().catch(e => {
  console.error("❌ خطای کلی:", e);
  process.exit(1);
});
