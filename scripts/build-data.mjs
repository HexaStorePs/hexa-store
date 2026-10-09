#!/usr/bin/env node
/*
 * HEXA Website data builder
 * ------------------------
 * Reads your games + selling prices from Notion (Prices (PS)) and which slots are in stock (PS ALL GAMES),
 * then adds from the PlayStation Store (US): cover image, genres and today's dollar price / discount.
 * Writes data/games.json, which the website (index.html) loads.  The Full Account price is NEVER written.
 *
 *   NOTION_TOKEN=secret_xxx node scripts/build-data.mjs          # real run (GitHub Actions does this every 30 min)
 *   node scripts/build-data.mjs --sample                          # preview run using scripts/sample-notion.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "site.config.json"), "utf8"));
const SAMPLE = process.argv.includes("--sample");
const TOKEN = (process.env.NOTION_TOKEN || "").trim();
const OUT = path.join(ROOT, "data", "games.json");
const META = path.join(ROOT, "data", "meta.json"); // genres per Sony product (fetched once, then cached)

// --------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
async function retry(fn, tries = 3) {
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) { if (a >= tries - 1) throw e; await sleep(600 * (a + 1)); }
  }
}
function norm(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\s*\((?!\d{4}\)).*$/, " ").replace(/[™®©]/g, "")
    .replace(/\bps[45]\b(\s*(&|and|y|e|et|und|og|och|i|ve)\s*ps[45]\b)?/g, " ")
    .replace(/['’‘`´]/g, "").replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const cmp = (s) => norm(s).replace(/ /g, "");
function parsePrice(s) {
  const m = String(s ?? "").replace(/\s/g, "").match(/\d[\d.,]*/);
  if (!m) return null;
  let d = m[0].replace(/[.,]$/, "");
  const i = Math.max(d.lastIndexOf("."), d.lastIndexOf(","));
  d = i >= 0 && d.length - i - 1 !== 3 ? d.slice(0, i).replace(/[.,]/g, "") + "." + d.slice(i + 1) : d.replace(/[.,]/g, "");
  const n = Number(d);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// display name: drop the internal tags you use in Notion ("(AR)", "( ps4 )", "PS4 & PS5", "NL ENGLISH"...)
function cleanName(n) {
  return String(n)
    .replace(/\(\s*(ar|ps ?[45]( ?(&|and) ?ps ?[45])?( only)?|ps5 only|crossgen|ps4ver)\s*\)/gi, "")
    .replace(/\(\s*ps\d.*?\)/gi, "")
    .replace(/\bPS4 ?(&|AND) ?PS5\b/gi, "")
    .replace(/\s+NL ENGLISH$/i, "")
    .replace(/\s{2,}/g, " ").trim();
}

// --------------------------------------------------------------- Notion
const NV = "2022-06-28";
async function notion(p, body, method) {
  return retry(async () => {
    const r = await fetch("https://api.notion.com/v1" + p, {
      method: method || (body ? "POST" : "GET"),
      headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NV, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { await sleep(1500); throw new Error("rate limited"); }
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion ${r.status}: ${j.message || ""}`);
    return j;
  }, 4);
}
async function queryAll(db) {
  const out = []; let cur;
  do {
    const j = await notion(`/databases/${db}/query`, { page_size: 100, ...(cur ? { start_cursor: cur } : {}) });
    out.push(...j.results); cur = j.has_more ? j.next_cursor : null;
  } while (cur);
  return out;
}
const plain = (a) => (a ?? []).map((o) => o?.plain_text ?? "").join("");
const bl = (s) => String(s).toLowerCase().replace(/[\s_-]/g, "");
const prop = (p, names) => { const w = names.map(bl); for (const [k, v] of Object.entries(p)) if (w.includes(bl(k))) return v; };
const numOf = (v) => !v ? null : v.type === "number" ? v.number : v.type === "formula" && v.formula?.type === "number" ? v.formula.number : null;
const strOf = (v) => !v ? "" : v.type === "formula" ? String(v.formula?.string ?? v.formula?.number ?? "") : v.type === "title" ? plain(v.title) : v.type === "rich_text" ? plain(v.rich_text) : v.type === "select" ? v.select?.name ?? "" : "";

async function loadNotion() {
  if (SAMPLE) {
    const s = JSON.parse(await fs.readFile(path.join(ROOT, "scripts", "sample-notion.json"), "utf8"));
    return s.map((g) => ({ id: g.name, name: g.name, p5: g.p5 ?? null, p4: g.p4 ?? null, sec: g.sec ?? null, avail: null }));
  }
  if (!TOKEN) throw new Error("NOTION_TOKEN is missing (add it as a repository secret, or run with --sample)");
  const pages = await queryAll(cfg.notionPricesDb);
  const games = pages.map((pg) => {
    const p = pg.properties ?? {};
    const title = Object.values(p).find((v) => v?.type === "title");
    return {
      id: pg.id, name: plain(title?.title).trim(),
      p5: numOf(prop(p, ["Primary PS5 Price"])), p4: numOf(prop(p, ["Primary PS4 Price"])), sec: numOf(prop(p, ["Secondary Price"])),
      avail: { ps5: false, ps4: false, sec: false },
    };
  }).filter((g) => g.name);
  // stock: available accounts per game (same rule the HEXA Companion uses)
  try {
    const accs = await queryAll(cfg.notionAccountsDb);
    const byId = new Map(games.map((g) => [g.id, g]));
    for (const a of accs) {
      const p = a.properties ?? {};
      if (numOf(prop(p, ["FILTER"])) !== 1) continue;
      const ids = (prop(p, ["Game"])?.relation ?? []).map((r) => r.id);
      const ok = (names) => strOf(prop(p, names)) === "✅";
      for (const id of ids) {
        const g = byId.get(id); if (!g) continue;
        if (ok(["SEC"])) g.avail.sec = true;
        if (ok(["PRIMARY 4", "Primary 4"])) g.avail.ps4 = true;
        if (ok(["PRIMARY 5", "Primary 5"])) g.avail.ps5 = true;
      }
    }
  } catch (e) { console.warn("stock lookup failed, showing everything as available:", e.message); games.forEach((g) => (g.avail = null)); }
  return games;
}

// --------------------------------------------------------------- PlayStation Store (US)
const GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const HASH = "4df6284f982e57bec70f23c77e2c219dc792eb19af7fb3d3a81767aa3f1958aa";
const GAME_TYPES = ["FULL_GAME", "GAME_BUNDLE", "PREMIUM_EDITION"];
async function sonySearch(term) {
  const vars = { countryCode: "US", languageCode: "en", nextCursor: "", pageOffset: 0, pageSize: 12, searchTerm: term };
  const url = `${GQL}?operationName=getSearchResults&variables=${encodeURIComponent(JSON.stringify(vars))}&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH } }))}`;
  return retry(async () => {
    const r = await fetch(url, { headers: { "content-type": "application/json", "x-psn-store-locale-override": "en-US", origin: "https://store.playstation.com", referer: "https://store.playstation.com/" } });
    if (!r.ok) throw new Error("sony " + r.status);
    return (await r.json())?.data?.universalSearch?.results ?? [];
  });
}
// pick the product that matches the Notion name (exact name first, then "contains all words"), preferring the version
// whose platforms fit the slots you sell (PS5+PS4 → cross-gen, PS5 only → anything with PS5...)
function pickProduct(name, results, g) {
  const want = norm(name), wantC = cmp(name), words = want.split(" ").filter(Boolean);
  const ok = results.filter((x) => x?.name && x.price && !x.price.isFree && GAME_TYPES.includes(x.storeDisplayClassification));
  let hits = ok.filter((x) => cmp(x.name) === wantC);
  if (!hits.length) {
    const c = ok.filter((x) => { const n = norm(x.name); return (words.every((w) => n.includes(w)) || cmp(x.name).includes(wantC)) && n.split(" ").every((w) => !/^\d+$/.test(w) || words.includes(w)); })
      .sort((a, b) => norm(a.name).length - norm(b.name).length);
    if (c[0]) hits = c.filter((x) => cmp(x.name) === cmp(c[0].name));
  }
  if (!hits.length) return null;
  const need5 = g.p5 != null, need4 = g.p4 != null;
  const score = (x) => { const pl = x.platforms ?? []; return (need5 && pl.includes("PS5") ? 2 : 0) + (need4 && pl.includes("PS4") ? 2 : 0) + pl.length * 0.1; };
  return hits.slice().sort((a, b) => score(b) - score(a))[0];
}
function coverOf(x) {
  const imgs = (x.media ?? []).filter((m) => m.type === "IMAGE");
  const by = (role) => imgs.find((m) => m.role === role)?.url;
  return by("GAMEHUB_COVER_ART") || by("MASTER") || by("PORTRAIT_BANNER") || imgs[0]?.url || null;
}
const AR_GENRES = [
  [/role playing|rpg/i, "آر بي جي"], [/action/i, "أكشن"], [/adventure/i, "مغامرة"], [/shooter/i, "تصويب"], [/fight/i, "قتال"],
  [/racing|driving/i, "سباقات"], [/sport/i, "رياضة"], [/simulation/i, "محاكاة"], [/strategy/i, "استراتيجية"], [/horror/i, "رعب"],
  [/puzzle/i, "ألغاز"], [/platform/i, "منصات"], [/arcade/i, "أركيد"], [/family/i, "عائلية"], [/party/i, "حفلات"], [/music|rhythm/i, "موسيقى"],
  [/casual/i, "خفيفة"], [/educational/i, "تعليمية"], [/fitness/i, "لياقة"], [/flight/i, "طيران"], [/open world/i, "عالم مفتوح"], [/unique/i, "مميزة"],
];
const arGenre = (g) => AR_GENRES.find(([re]) => re.test(g))?.[1] ?? g;
async function fetchGenres(productId) {
  const url = `https://store.playstation.com/en-us/product/${productId}`;
  const html = await retry(async () => {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36", "accept-language": "en-US,en;q=0.9" } });
    if (!r.ok) throw new Error("page " + r.status);
    return r.text();
  }, 2);
  const m = html.match(/"localizedGenres":\[(.*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"value":"([^"]+)"/g)].map((x) => x[1]);
}

// --------------------------------------------------------------- main
const notionGames = await loadNotion();
const meta = JSON.parse(await fs.readFile(META, "utf8").catch(() => "{}"));
console.log(`Notion: ${notionGames.length} games`);

let found = 0, genresFetched = 0;
const rows = await pool(notionGames, 6, async (g) => {
  const hasPrice = g.p5 != null || g.p4 != null || g.sec != null;
  const row = {
    id: g.id, name: cleanName(g.name), notionName: g.name,
    prices: { ps5: g.p5, ps4: g.p4, sec: g.sec }, avail: g.avail,
    cover: null, genres: [], usd: null, platforms: [], sonyId: null,
  };
  if (!hasPrice) return row;
  try {
    const res = await sonySearch(cleanName(g.name));
    const x = pickProduct(cleanName(g.name), res, g);
    if (x) {
      found++;
      row.sonyId = x.id; row.platforms = x.platforms ?? [];
      row.cover = coverOf(x);
      const now = parsePrice(x.price.discountedPrice ?? x.price.basePrice), base = parsePrice(x.price.basePrice);
      const plus = (x.price.serviceBranding ?? []).includes("PS_PLUS");
      const cur = plus ? base : now;
      if (cur && /\$|USD/.test(String(x.price.discountedPrice ?? x.price.basePrice))) {
        row.usd = { now: cur, base: base ?? cur, pct: base && cur < base ? Math.round((1 - cur / base) * 100) : 0 };
      }
      if (!meta[x.id]) {
        try { meta[x.id] = { genres: await fetchGenres(x.id), at: Date.now() }; genresFetched++; } catch { meta[x.id] = { genres: [], at: Date.now(), failed: true }; }
      }
      row.genres = (meta[x.id].genres ?? []).map(arGenre).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    }
  } catch (e) { console.warn("sony failed for", g.name, e.message); }
  return row;
});

const games = rows.filter((r) => r.prices.ps5 != null || r.prices.ps4 != null || r.prices.sec != null)
  .filter((r) => !(cfg.hideSoldOut && r.avail && !r.avail.ps5 && !r.avail.ps4 && !r.avail.sec))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));
// de-duplicate identical names (Notion sometimes has the same game twice)
const seen = new Set();
const unique = games.filter((g) => { const k = cmp(g.name) + "|" + JSON.stringify(g.prices); if (seen.has(k)) return false; seen.add(k); return true; });

await fs.mkdir(path.join(ROOT, "data"), { recursive: true });
await fs.writeFile(META, JSON.stringify(meta));
await fs.writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), count: unique.length, games: unique }));
console.log(`Done: ${unique.length} games written (${found} matched on PS Store, ${genresFetched} new genre lookups).`);
