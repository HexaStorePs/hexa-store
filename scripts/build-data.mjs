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
const OUT = process.env.OUT_FILE || path.join(ROOT, "data", "games.json");
const META = path.join(ROOT, "data", "meta.json"); // genres per Sony product (fetched once, then cached)
const PR = { r5: 1700, r4: 1150, rsec: 800, discLo: 50, discHi: 100, extraLo: 100, extraHi: 200, perk: 110, ...(cfg.pricing || {}) };

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
const REGIONS = {"US":["en","USD"],"CA":["en","CAD"],"MX":["es","MXN"],"BR":["pt","BRL"],"AR":["es","USD"],"CL":["es","USD"],"CO":["es","USD"],"HN":["es","HNL"],"NI":["es","NIO"],"BO":["es","USD"],"CR":["es","USD"],"EC":["es","USD"],"SV":["es","USD"],"GT":["es","USD"],"PA":["es","USD"],"PY":["es","USD"],"PE":["es","USD"],"UY":["es","USD"],"GB":["en","GBP"],"DE":["de","EUR"],"PL":["pl","PLN"],"AT":["de","EUR"],"BE":["fr","EUR"],"BG":["en","EUR"],"HR":["en","EUR"],"CY":["en","EUR"],"FI":["en","EUR"],"FR":["fr","EUR"],"GR":["en","EUR"],"IS":["en","EUR"],"IE":["en","EUR"],"IT":["it","EUR"],"LU":["de","EUR"],"MT":["en","EUR"],"NL":["nl","EUR"],"PT":["pt","EUR"],"SK":["en","EUR"],"SI":["en","EUR"],"ES":["es","EUR"],"CZ":["en","CZK"],"HU":["en","HUF"],"RO":["en","RON"],"SE":["sv","SEK"],"NO":["no","NOK"],"DK":["da","DKK"],"CH":["de","CHF"],"UA":["uk","UAH"],"TR":["en","TRY"],"RU":["ru","RUB"],"IL":["en","ILS"],"SA":["en","USD"],"AE":["en","USD"],"BH":["en","USD"],"KW":["en","USD"],"OM":["en","USD"],"QA":["en","USD"],"LB":["en","USD"],"ZA":["en","ZAR"],"IN":["en","INR"],"JP":["ja","JPY"],"KR":["ko","KRW"],"HK":["en","HKD"],"TW":["en","TWD"],"ID":["en","IDR"],"TH":["en","THB"],"MY":["en","MYR"],"SG":["en","SGD"],"AU":["en","AUD"],"NZ":["en","NZD"]}; // cc -> [language, store currency]
const GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const HASH = "4df6284f982e57bec70f23c77e2c219dc792eb19af7fb3d3a81767aa3f1958aa";
const GAME_TYPES = ["FULL_GAME", "GAME_BUNDLE", "PREMIUM_EDITION"];
const sonySearch = (term) => sonySearchIn("US", "en", term);
async function sonySearchIn(cc, lang, term) {
  const vars = { countryCode: cc, languageCode: lang, nextCursor: "", pageOffset: 0, pageSize: 12, searchTerm: term };
  const url = `${GQL}?operationName=getSearchResults&variables=${encodeURIComponent(JSON.stringify(vars))}&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH } }))}`;
  return retry(async () => {
    const r = await fetch(url, { headers: { "content-type": "application/json", "x-psn-store-locale-override": `${lang}-${cc}`, origin: "https://store.playstation.com", referer: "https://store.playstation.com/" } });
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
  return by("MASTER") || by("PORTRAIT_BANNER") || by("GAMEHUB_COVER_ART") || imgs[0]?.url || null;
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

// --------------------------------------------------------------- PlayStation Plus subscriptions
function plusInfo(name) {
  const m = String(name).match(/^plus\s+(e[a-z]*|extra|deluxe|premium)[a-z]*\s+(\d+)\s*months?/i);
  if (!m) return null;
  const t = m[1].toLowerCase(), months = Number(m[2]);
  const tier = t.startsWith("e") && t !== "extra" ? "Essential" : t === "extra" ? "Extra" : "Deluxe";
  return { name: `PlayStation Plus ${tier} - ${months} ${months === 1 ? "Month" : "Months"}`, tier, months };
}

// --------------------------------------------------------------- card rates + regional cost (to keep auto prices profitable)
async function loadCardRates() {
  if (SAMPLE) return JSON.parse(process.env.CARD_RATES || '{"TR":1.45,"UA":1.36,"US":51}');
  if (!TOKEN || !cfg.notionCardRatesDb) return null;
  try {
    const rows = await queryAll(cfg.notionCardRatesDb);
    const out = {};
    for (const pg of rows) {
      const p = pg.properties ?? {};
      const cc = strOf(prop(p, ["Code"])).trim().toUpperCase(), v = numOf(prop(p, ["Rate"]));
      if (cc && v > 0 && REGIONS[cc]) out[cc] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch (e) { console.warn("card rates unavailable (share 💱 Card Rates with the integration):", e.message); return null; }
}
async function fxTable() {
  for (const url of ["https://api.coinbase.com/v2/exchange-rates?currency=USD", "https://open.er-api.com/v6/latest/USD"]) {
    try { const j = await (await fetch(url)).json(); const r = j?.data?.rates ?? j?.rates; if (r?.EGP) return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])); } catch { /* next */ }
  }
  return {};
}
function listingCurrency(text, regionCur) {
  const s = String(text || "");
  if (/US\$|USD/i.test(s)) return "USD";
  if (/TL|₺|TRY/.test(s)) return "TRY";
  if (s.includes("$") && !["USD", "CAD", "AUD", "NZD", "HKD", "TWD", "SGD", "MXN"].includes(regionCur)) return "USD";
  return regionCur;
}
// cheapest EGP cost of this game over the regions you buy cards for (card rate = EGP per 1 unit of the store currency)
async function cheapestCost(name, platforms, rates, fx) {
  let best = null;
  await pool(Object.keys(rates), 5, async (cc) => {
    const [lang, cur] = REGIONS[cc];
    try {
      let res = await sonySearchIn(cc, lang, name);
      let x = pickProduct(name, res, { p5: platforms.includes("PS5") ? 1 : null, p4: platforms.includes("PS4") ? 1 : null });
      if (!x && lang !== "en") { res = await sonySearchIn(cc, cc === "UA" ? "ru" : "en", name); x = pickProduct(name, res, { p5: platforms.includes("PS5") ? 1 : null, p4: platforms.includes("PS4") ? 1 : null }); }
      if (!x) return;
      const plus = (x.price.serviceBranding ?? []).includes("PS_PLUS");
      const txt = plus ? x.price.basePrice : (x.price.discountedPrice ?? x.price.basePrice);
      let v = parsePrice(txt); if (!v) return;
      const from = listingCurrency(txt, cur);
      if (from !== cur) { if (!fx[from] || !fx[cur]) return; v = v * (fx[cur] / fx[from]); }
      const cost = v * rates[cc];
      if (!best || cost < best) best = cost;
    } catch { /* region skipped */ }
  });
  return best;
}

// --------------------------------------------------------------- auto pricing (same rules as HEXA Pricer)
const r10 = (n) => Math.round(n / 10) * 10;
async function officialDollar() {
  for (const url of ["https://api.coinbase.com/v2/exchange-rates?currency=USD", "https://open.er-api.com/v6/latest/USD"]) {
    try {
      const j = await (await fetch(url)).json();
      const v = Number(j?.data?.rates?.EGP ?? j?.rates?.EGP);
      if (v > 20) return v;
    } catch { /* next source */ }
  }
  return Number(cfg.fallbackDollar) || 50;
}
// the (hidden) Full price is cheaper than the dollar value by discLo..discHi EGP, on a round number
function fullFor(V) {
  if (V < 400) return Math.max(10, r10(V * 0.85));
  const mid = V - (PR.discLo + PR.discHi) / 2, c = [];
  for (let x = Math.ceil((V - PR.discHi) / 10) * 10; x <= V - PR.discLo; x += 10) if (x > 0) c.push(x);
  if (!c.length) return r10(V * 0.85);
  return c.sort((a, b) => ((a % 50 ? 1000 : 0) + Math.abs(a - mid)) - ((b % 50 ? 1000 : 0) + Math.abs(b - mid)))[0];
}
const PERK_RE = /fifa|ea sports fc|\bfc ?\d{2}\b|madden|nba ?2k|ultimate team|\bpoints\b|\bvc\b/i;
function autoPrices(usd, platforms, name, dollar, cost) {
  const full = fullFor(usd * dollar);
  const has4 = platforms.includes("PS4"), has5 = platforms.includes("PS5") || has4; // PS4 games run on PS5 too
  const slots = [];
  if (has5) slots.push(["ps5", PR.r5]);
  if (has4) slots.push(["ps4", PR.r4]);
  const ref = has5 ? PR.r5 : PR.r4;
  slots.push(["sec", PERK_RE.test(name) ? (ref * PR.perk) / 100 : PR.rsec]);
  const target = full + (PR.extraLo + PR.extraHi) / 2, tw = slots.reduce((a, [, w]) => a + w, 0), out = {};
  slots.forEach(([k, w]) => (out[k] = Math.max(10, r10((target * w) / tw))));
  let sum = Object.values(out).reduce((a, b) => a + b, 0);
  const big = slots.slice().sort((a, b) => b[1] - a[1])[0][0];
  for (let g = 0; g < 30 && (sum < full + PR.extraLo || sum > full + PR.extraHi); g++) { const d = sum < full + PR.extraLo ? 10 : -10; out[big] += d; sum += d; }
  // never sell at a loss: if the slots together don't cover the cheapest card cost + minimum margin, raise them
  if (cost) {
    const need = cost * (1 + (Number(cfg.minMargin) || 0.2)), have = Object.values(out).reduce((a, b) => a + b, 0);
    if (have < need) { const f = need / have; for (const k of Object.keys(out)) out[k] = Math.ceil((out[k] * f) / 10) * 10; }
  }
  return { ps5: out.ps5 ?? null, ps4: out.ps4 ?? null, sec: out.sec ?? null };
}

// --------------------------------------------------------------- main
const notionGames = await loadNotion();
const DOLLAR = await officialDollar();
const CARD_RATES = await loadCardRates();
const FX = CARD_RATES ? await fxTable() : {};
let autoPriced = 0, raised = 0;
if (CARD_RATES) console.log("Card rates for cost check:", Object.keys(CARD_RATES).join(", ")); else console.log("No card rates → prices are NOT cost-checked");
const meta = JSON.parse(await fs.readFile(META, "utf8").catch(() => "{}"));
console.log(`Notion: ${notionGames.length} games`);

let found = 0, genresFetched = 0;
const rows = await pool(notionGames, 6, async (g) => {
  const hasPrice = g.p5 != null || g.p4 != null || g.sec != null;
  const unpriced = !hasPrice;
  const row = {
    id: g.id, name: cleanName(g.name), notionName: g.name,
    prices: { ps5: g.p5, ps4: g.p4, sec: g.sec }, avail: g.avail,
    cover: null, genres: [], usd: null, platforms: [], sonyId: null,
  };
  const plus = plusInfo(g.name);
  if (plus) {
    row.name = plus.name; row.cover = "assets/psplus.png"; row.genres = ["اشتراك"]; row.platforms = ["PS4", "PS5"]; row.subscription = true;
    return row;
  }
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
      if (unpriced && row.usd) { // not priced in Notion → price it with the same rule the HEXA Pricer uses
        const cost = CARD_RATES ? await cheapestCost(row.name, row.platforms, CARD_RATES, FX) : null;
        const base = autoPrices(row.usd.now, row.platforms, row.name, DOLLAR, null);
        row.prices = autoPrices(row.usd.now, row.platforms, row.name, DOLLAR, cost);
        if (JSON.stringify(base) !== JSON.stringify(row.prices)) raised++;
        row.autoPriced = true; autoPriced++;
      }
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
console.log(`Dollar ${DOLLAR}. Done: ${unique.length} games written (${found} matched on PS Store, ${genresFetched} new genre lookups, ${autoPriced} priced automatically, ${raised} of them raised to stay profitable).`);
