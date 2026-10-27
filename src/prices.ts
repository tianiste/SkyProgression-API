import { HttpError, boundedJson, boundedText, get, json } from "./http";
import type { Env } from "./index";
import ids from "./price-ids.json";

/**
 * The price bundle is rebuilt by the cron trigger in small steps so each run stays inside the free plan
 * (10 ms CPU, 50 subrequests): one large Hypixel resource at most per run, scanned with a single regular
 * expression instead of a full JSON parse, plus a batch of Coflnet lookups for the items the Bazaar does not sell.
 */
const BUNDLE_KEY = "bundle";
const BAZAAR_EVERY_MS = 14 * 60_000;
const NPC_EVERY_MS = 6 * 3600_000;
const MAYOR_EVERY_MS = 20 * 60_000;
/** Coflnet quotes younger than this are not refetched. */
const AUCTION_EVERY_MS = 12 * 60_000;
/** Coflnet lookups per run (with at most three Hypixel calls, below the 50-subrequest limit). */
const AUCTION_BATCH = 40;
const AUCTION_PARALLEL = 6;
/** A quote that could not be refreshed for this long is dropped, so it reads as unknown instead of stale. */
const DROP_AFTER_MS = 24 * 3600_000;

/** Same fields as the mod's Price; 0 means none. */
export interface Price {
  buy: number;
  sell: number;
  source: string;
  updatedAt: string;
  available: boolean;
  npc?: number;
  npcUpdatedAt?: string;
}

export interface MayorPerk { mayor: string; name: string; description: string; minister: boolean }

export interface Bundle {
  version: 1;
  updatedAt: string;
  prices: Record<string, Price>;
  /** Current mayor and minister perks; null while the election resource could not be read. */
  mayor: MayorPerk[] | null;
  status: { bazaarAt: number; npcAt: number; mayorAt: number; bazaarIds: string[]; fetched: Record<string, number> };
}

const ITEM_IDS: string[] = ids.items;
const NPC_IDS: string[] = ids.npc;

function empty(): Bundle {
  return { version: 1, updatedAt: "", prices: {}, mayor: null, status: { bazaarAt: 0, npcAt: 0, mayorAt: 0, bazaarIds: [], fetched: {} } };
}

/**
 * Top of the order book per product: buy = lowest sell offer (instant buy), sell = highest buy order (instant sell).
 * Products list product_id, then sell_summary, then buy_summary, so one pass pairs them in order.
 */
export function scanBazaar(text: string): Map<string, { buy: number; sell: number }> {
  const out = new Map<string, { buy: number; sell: number }>();
  const re = /"product_id":"([^"]+)","sell_summary":\[(?:\{"amount":\d+,"pricePerUnit":([0-9.eE+-]+))?|"buy_summary":\[(?:\{"amount":\d+,"pricePerUnit":([0-9.eE+-]+))?/g;
  let current: { buy: number; sell: number } | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1] !== undefined) {
      current = { buy: 0, sell: m[2] ? Number(m[2]) : 0 };
      out.set(m[1], current);
    } else if (current) {
      current.buy = m[3] ? Number(m[3]) : 0;
      current = null;
    }
  }
  return out;
}

/** npc_sell_price of the wanted items, found next to each item's id without parsing the whole items resource. */
export function scanNpc(text: string, wanted: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (wanted.length === 0) return out;
  const re = new RegExp(`"id":"(${wanted.map((w) => w.replace(/[^A-Z0-9_]/g, "\\$&")).join("|")})"`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (out.has(m[1])) continue;
    const start = text.lastIndexOf('},{"', m.index) + 2;
    const end = text.indexOf('},{"', m.index);
    const price = /"npc_sell_price":([0-9.eE+-]+)/.exec(text.slice(start, end < 0 ? text.length : end));
    if (price) out.set(m[1], Number(price[1]));
  }
  return out;
}

async function refreshBazaar(b: Bundle): Promise<void> {
  const response = await get("https://api.hypixel.net/v2/skyblock/bazaar", {}, 15_000);
  if (response.status !== 200) throw new Error(`bazaar ${response.status}`);
  const text = await boundedText(response, 16 * 1024 * 1024);
  const updated = /"lastUpdated":(\d+)/.exec(text.slice(0, 200));
  const at = new Date(updated ? Number(updated[1]) : Date.now()).toISOString();
  const products = scanBazaar(text);
  const bazaarIds: string[] = [];
  for (const id of ITEM_IDS) {
    const p = products.get(id);
    if (!p) continue;
    bazaarIds.push(id);
    const old = b.prices[id];
    b.prices[id] = { buy: p.buy, sell: p.sell, source: "Bazaar (Hypixel)", updatedAt: at, available: p.buy > 0, npc: old?.npc, npcUpdatedAt: old?.npcUpdatedAt };
    b.status.fetched[id] = Date.now();
  }
  b.status.bazaarIds = bazaarIds;
  b.status.bazaarAt = Date.now();
}

async function refreshNpc(b: Bundle): Promise<void> {
  const response = await get("https://api.hypixel.net/v2/resources/skyblock/items", {}, 15_000);
  if (response.status !== 200) throw new Error(`items ${response.status}`);
  const found = scanNpc(await boundedText(response, 24 * 1024 * 1024), NPC_IDS);
  const at = new Date().toISOString();
  for (const [id, npc] of found) {
    if (!(npc > 0)) continue;
    const p = b.prices[id] ?? { buy: 0, sell: 0, source: "No market quote", updatedAt: "unknown", available: false };
    p.npc = npc;
    p.npcUpdatedAt = at;
    b.prices[id] = p;
  }
  b.status.npcAt = Date.now();
}

async function refreshMayor(b: Bundle): Promise<void> {
  try {
    const response = await get("https://api.hypixel.net/v2/resources/skyblock/election", {}, 10_000);
    if (response.status !== 200) throw new Error(`election ${response.status}`);
    type Perk = { name?: string; description?: string };
    const election = await boundedJson<{ mayor?: { name?: string; perks?: Perk[]; minister?: { name?: string; perk?: Perk } } }>(response, 256 * 1024);
    const mayor = election.mayor ?? {};
    const out: MayorPerk[] = (mayor.perks ?? []).map((p) => ({ mayor: mayor.name ?? "", name: p.name ?? "", description: p.description ?? "", minister: false }));
    if (mayor.minister) out.push({ mayor: mayor.minister.name ?? "", name: mayor.minister.perk?.name ?? "", description: mayor.minister.perk?.description ?? "", minister: true });
    b.mayor = out;
  } catch {
    b.mayor = null;
  }
  b.status.mayorAt = Date.now();
}

/** Coflnet: current buy/sell for an Auction House item, or the lowest BIN of a "PET_TYPE;RARITY;LEVEL" key. */
async function auctionQuote(id: string): Promise<Price | null> {
  if (id.includes(";")) {
    const [tag, rarity, level] = id.split(";");
    const response = await get(`https://sky.coflnet.com/api/item/price/${encodeURIComponent(tag)}/bin?Rarity=${encodeURIComponent(rarity)}&PetLevel=${encodeURIComponent(level)}`);
    if (response.status !== 200) return response.status === 404 || response.status === 204 ? null : Promise.reject(new Error(`coflnet ${response.status}`));
    const body = await boundedJson<{ lowest?: number }>(response, 64 * 1024);
    const lowest = Number(body.lowest ?? 0);
    return { buy: lowest, sell: 0, source: `Auction House lowest BIN, level ${level} (Coflnet)`, updatedAt: "Current lowest BIN", available: lowest > 0 };
  }
  const response = await get(`https://sky.coflnet.com/api/item/price/${encodeURIComponent(id)}/current?minAgeSeconds=120`);
  if (response.status !== 200) return response.status === 404 || response.status === 204 ? null : Promise.reject(new Error(`coflnet ${response.status}`));
  const body = await boundedJson<{ buy?: number; sell?: number; available?: number; isAh?: boolean; updatedAt?: string }>(response, 64 * 1024);
  const buy = Number(body.buy ?? 0);
  return {
    buy,
    sell: Math.max(0, Number(body.sell ?? 0)),
    source: body.isAh ? "Auction House (Coflnet)" : "Bazaar (Coflnet)",
    updatedAt: body.updatedAt ?? "Unknown quote time",
    available: buy > 0 && Number(body.available ?? 0) > 0,
  };
}

async function refreshAuctions(b: Bundle): Promise<number> {
  if (b.status.bazaarIds.length === 0) return 0; // Without the Bazaar list every item would look like an auction item.
  const bazaar = new Set(b.status.bazaarIds);
  const now = Date.now();
  const due = ITEM_IDS.filter((id) => !bazaar.has(id) && now - (b.status.fetched[id] ?? 0) > AUCTION_EVERY_MS)
    .sort((x, y) => (b.status.fetched[x] ?? 0) - (b.status.fetched[y] ?? 0))
    .slice(0, AUCTION_BATCH);
  let done = 0;
  const queue = [...due];
  const workers = Array.from({ length: AUCTION_PARALLEL }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const quote = await auctionQuote(id);
        const old = b.prices[id];
        if (quote) b.prices[id] = { ...quote, npc: old?.npc, npcUpdatedAt: old?.npcUpdatedAt };
        else if (old?.npc) b.prices[id] = { buy: 0, sell: 0, source: "No market quote", updatedAt: "unknown", available: false, npc: old.npc, npcUpdatedAt: old.npcUpdatedAt };
        else delete b.prices[id];
        b.status.fetched[id] = Date.now();
        done++;
      } catch {
        // Coflnet busy or down: keep the previous quote and retry on a later run.
      }
    }
  });
  await Promise.all(workers);
  return done;
}

let memoryBundle: { at: number; text: string } | undefined;

/** One cron step: a due Hypixel resource (one large one at most), the mayor, and a batch of Coflnet quotes. */
export async function refreshPrices(env: Env): Promise<{ step: string; auctions: number; prices: number }> {
  const stored = await env.PRICES.get<Bundle>(BUNDLE_KEY, "json");
  const b = stored?.version === 1 ? stored : empty();
  const now = Date.now();
  let step = "none";
  try {
    if (now - b.status.bazaarAt > BAZAAR_EVERY_MS) { step = "bazaar"; await refreshBazaar(b); }
    else if (now - b.status.npcAt > NPC_EVERY_MS) { step = "npc"; await refreshNpc(b); }
  } catch {
    step += " failed";
  }
  if (now - b.status.mayorAt > MAYOR_EVERY_MS) await refreshMayor(b);
  const auctions = await refreshAuctions(b);
  for (const id of Object.keys(b.prices)) if (now - (b.status.fetched[id] ?? 0) > DROP_AFTER_MS && !b.prices[id].npc) delete b.prices[id];
  b.updatedAt = new Date().toISOString();
  const text = JSON.stringify(b);
  await env.PRICES.put(BUNDLE_KEY, text);
  memoryBundle = { at: Date.now(), text };
  return { step, auctions, prices: Object.keys(b.prices).length };
}

/** The current bundle for the mod (without the refresh bookkeeping), read from KV at most once a minute per isolate. */
export async function prices(env: Env): Promise<Response> {
  if (!memoryBundle || Date.now() - memoryBundle.at > 60_000) {
    const text = await env.PRICES.get(BUNDLE_KEY);
    if (text) memoryBundle = { at: Date.now(), text };
  }
  if (!memoryBundle) throw new HttpError(503, "prices_loading", "Prices are still loading. Try again in a few minutes.", 180);
  const b = JSON.parse(memoryBundle.text) as Bundle;
  const auctionIds = ITEM_IDS.filter((id) => !b.status.bazaarIds.includes(id));
  const auctionsKnown = auctionIds.filter((id) => b.status.fetched[id]).length;
  return json({
    version: b.version,
    updatedAt: b.updatedAt,
    prices: b.prices,
    mayor: b.mayor,
    complete: b.status.bazaarAt > 0 && auctionsKnown === auctionIds.length,
    bazaarAt: b.status.bazaarAt ? new Date(b.status.bazaarAt).toISOString() : "",
  });
}

export async function priceStatus(env: Env): Promise<{ updatedAt: string; count: number } | null> {
  const text = memoryBundle?.text ?? (await env.PRICES.get(BUNDLE_KEY));
  if (!text) return null;
  const b = JSON.parse(text) as Bundle;
  return { updatedAt: b.updatedAt, count: Object.keys(b.prices).length };
}

/** Coflnet BIN filters a resale quote may use (the same set the mod builds in Resale.of). */
const RESALE_FILTERS = new Set(["Rarity", "Recombobulated", "Reforge", "PowderCoating", "DrillPartEngine", "DrillPartFuelTank", "DrillPartUpgradeModule", "PetLevel", "PetItem"]);
const filterOptions = new Map<string, { at: number; options: Map<string, string[]> }>();
const resaleQuotes = new Map<string, { at: number; price: Price | null }>();

async function options(tag: string): Promise<Map<string, string[]>> {
  const hit = filterOptions.get(tag);
  if (hit && Date.now() - hit.at < 3600_000) return hit.options;
  const response = await get(`https://sky.coflnet.com/api/filter/options?itemTag=${tag}`, {}, 10_000);
  if (response.status !== 200) throw new HttpError(502, "upstream", "Coflnet is unavailable.");
  const list = await boundedJson<{ name?: string; options?: string[] }[]>(response, 1024 * 1024);
  const out = new Map<string, string[]>();
  for (const f of list) out.set(f.name ?? "", (f.options ?? []).map(String));
  if (filterOptions.size > 500) filterOptions.clear();
  filterOptions.set(tag, { at: Date.now(), options: out });
  return out;
}

/**
 * Modifier-aware sale quote: Coflnet's lowest BIN for the tag with the copy's filters, keeping only filters Coflnet
 * lists for that item (matched case-insensitively). Same rules as the companion; quotes are reused for 15 minutes.
 */
export async function resale(url: URL): Promise<Response> {
  const tag = url.searchParams.get("tag") ?? "";
  if (!/^[A-Z0-9_]{1,64}$/.test(tag)) throw new HttpError(400, "bad_request", "Invalid item tag.");
  const wanted: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (name === "tag") continue;
    if (!RESALE_FILTERS.has(name) || !/^[A-Za-z0-9_ ]{0,40}$/.test(value)) throw new HttpError(400, "bad_request", "Invalid filter.");
    wanted.push([name, value]);
  }
  if (wanted.length > RESALE_FILTERS.size) throw new HttpError(400, "bad_request", "Too many filters.");
  const allowed = await options(tag);
  const query: string[] = [], used: string[] = [], dropped: string[] = [];
  for (const [name, value] of wanted) {
    const values = allowed.get(name);
    if (!values) { dropped.push(name); continue; }
    const match = name === "PetLevel" ? value : values.find((v) => v.toLowerCase() === value.toLowerCase());
    if (match === undefined) { dropped.push(`${name} ${value}`); continue; }
    query.push(`${name}=${encodeURIComponent(match)}`);
    used.push(`${name} ${match}`);
  }
  const path = `${tag}/bin?${query.join("&")}`;
  const hit = resaleQuotes.get(path);
  if (hit && Date.now() - hit.at < 15 * 60_000) return json({ price: hit.price });
  const response = await get(`https://sky.coflnet.com/api/item/price/${path}`, {}, 10_000);
  let price: Price | null = null;
  if (response.status === 200) {
    const lowest = Number((await boundedJson<{ lowest?: number }>(response, 64 * 1024)).lowest ?? 0);
    if (lowest > 0) {
      price = {
        buy: lowest,
        sell: lowest,
        source: `lowest BIN with ${used.length ? used.join(", ") : "no filters"}${dropped.length ? `; not filterable: ${dropped.join(", ")}` : ""} (Coflnet, before Auction House fees)`,
        updatedAt: "Current lowest BIN",
        available: true,
      };
    }
  } else if (response.status !== 404 && response.status !== 204) {
    throw new HttpError(502, "upstream", "Coflnet is unavailable.");
  }
  if (resaleQuotes.size > 2000) resaleQuotes.clear();
  resaleQuotes.set(path, { at: Date.now(), price });
  return json({ price });
}
