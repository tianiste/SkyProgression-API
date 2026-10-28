import { HttpError, baseHeaders, boundedBytes, boundedJson, boundedText, get, USER_AGENT } from "./http";
import type { Env } from "./index";
import { bundleText } from "./prices";
import { profileEntry, relayUrl, uuid } from "./profile";
import { cached, store } from "./results";

/** The website's player pages (the relay's WebViews); hotm does not depend on the method or prices. */
const VIEWS = new Set(["overview", "gear", "upgrades", "methods", "start", "hotm"]);
const PRICE_MODES = new Set(["INSTANT_SELL", "SELL_OFFER", "NPC_SELL"]);
/** How purchases are priced: instant-buy (the lowest offer) or Bazaar buy orders (the top buy order). */
const COST_MODES = new Set(["INSTANT_BUY", "BUY_ORDER"]);
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
/** A page is reused this long for the same player, profile and options (the profile copy itself is fresh for 5 minutes). */
const RESULT_MS = 2 * 60_000;

/**
 * GET /player?ign= (or uuid=)&view=&profile=&method=&price=&cost=&god=&gear=: one player page computed by the engine on the relay.
 * The Worker resolves the name, gets the profile as for /profile and sends it with its price bundle (both unparsed); the
 * relay answers the page's JSON, which is cached here for two minutes per player, profile, view and options.
 */
export async function player(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const q = new URL(request.url).searchParams;
  const view = q.get("view") ?? "overview";
  if (!VIEWS.has(view)) throw new HttpError(400, "bad_request", "Unknown view.");
  const profile = (q.get("profile") ?? "").trim();
  if (!/^[A-Za-z0-9 -]{0,64}$/.test(profile)) throw new HttpError(400, "bad_request", "Invalid profile.");
  const method = q.get("method") || "MF_GEMS";
  if (!/^[A-Z_]{1,24}$/.test(method)) throw new HttpError(400, "bad_request", "Invalid method.");
  const price = q.get("price") || "INSTANT_SELL";
  if (!PRICE_MODES.has(price)) throw new HttpError(400, "bad_request", "Invalid price mode.");
  const cost = q.get("cost") || "INSTANT_BUY";
  if (!COST_MODES.has(cost)) throw new HttpError(400, "bad_request", "Invalid cost mode.");
  const god = q.get("god") !== "false";
  const gear = q.get("gear") === "equipped" ? "equipped" : "best";

  let id = (q.get("uuid") ?? "").replaceAll("-", "").toLowerCase();
  let name = "";
  if (!id) {
    const ign = (q.get("ign") ?? "").trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(ign)) throw new HttpError(400, "bad_request", "Enter a valid Minecraft name.");
    ({ id, name } = await uuid(ign, env, ctx));
  }
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(400, "bad_request", "uuid must be 32 hex characters.");

  const options = view === "hotm" ? "-" : `${method}/${price}/${cost}/${god}/${view === "gear" ? gear : "best"}`;
  const key = `player/${id}/${profile.toLowerCase()}/${view}/${options}`;
  const hit = await cached(key, RESULT_MS);
  if (hit) return answer(hit.body, "HIT");

  // Only work that reaches the relay counts towards the lookup limit.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.CHECKLIST_LIMIT.limit({ key: ip })).success) throw new HttpError(429, "rate_limited", "Too many lookups. Wait a minute.", 60);
  const relay = relayUrl(env);
  if (!relay) throw new HttpError(503, "unavailable", "Player pages are not available yet.");
  const named = Date.now();
  const { entry, state } = await profileEntry(id, false, env, ctx);
  const bundle = await bundleText(env);
  const fetched = Date.now();
  const head = JSON.stringify({ uuid: id, player: name, view, profile, method, price, cost, god, gear, fetchedAt: new Date(entry.at).toISOString() });
  // Profile and bundle are spliced in as text: parsing them would cost more CPU than the Worker has.
  const payload = new Blob([`${head.slice(0, -1)},"bundle":`, bundle, `,"data":`, entry.body, "}"]);
  let response: Response;
  try {
    response = await fetch(`${relay}/web`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", Accept: "application/json", "X-Relay-Secret": env.RELAY_SECRET!.trim() },
      body: payload,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new HttpError(502, "relay", "The profile server is down. Try again later.");
  }
  if (response.status !== 200) {
    const message = await boundedJson<{ error?: string }>(response, 4096).then((b) => String(b.error ?? "").slice(0, 160)).catch(() => "");
    // A relay from before /web answers "Unknown endpoint".
    if (response.status === 404 && message === "Unknown endpoint") throw new HttpError(503, "unavailable", "Player pages are not available yet.");
    if (response.status === 404) throw new HttpError(404, "not_found", message || "Player not found.");
    if (response.status === 400 || response.status === 413) throw new HttpError(response.status, "bad_request", message || "Invalid request.");
    throw new HttpError(502, "relay", "The profile server is down. Try again later.");
  }
  const text = await boundedText(response, MAX_RESULT_BYTES);
  store(key, { at: Date.now(), body: text }, RESULT_MS, ctx);
  // Where a computed page's time went (Worker clocks advance only across I/O); the relay adds its own read, decode and build.
  const relayTiming = (response.headers.get("Server-Timing") ?? "").replace(/[^a-z0-9;=., ]/gi, "").split(", ").filter(Boolean).map((t) => `relay-${t}`);
  const timing = [`name;dur=${named - started}`, `profile;dur=${fetched - named};desc=${state}`, `relay;dur=${Date.now() - fetched}`, ...relayTiming].join(", ");
  return answer(text, "MISS", timing);
}

function answer(body: string, state: string, timing?: string): Response {
  const headers: Record<string, string> = { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", "X-Cache": state };
  if (timing) headers["Server-Timing"] = timing;
  return new Response(body, { headers });
}

const MAX_TEXTURE_BYTES = 128 * 1024;

/**
 * GET /texture/<hash>: a skin or player-head texture from textures.minecraft.net, which sends no CORS headers, so the
 * website's 3D model can load it into WebGL. PNG only, at most 128 KB, cached for a day (textures never change).
 */
export async function texture(request: Request, ctx: ExecutionContext): Promise<Response> {
  const hash = new URL(request.url).pathname.slice("/texture/".length);
  if (!/^[0-9a-f]{32,64}$/.test(hash)) throw new HttpError(400, "bad_request", "Invalid texture.");
  const cacheKey = new Request(`https://skyprogression-api.internal/texture/${hash}`);
  let png = await caches.default.match(cacheKey);
  if (!png) {
    const upstream = await get(`https://textures.minecraft.net/texture/${hash}`, { Accept: "image/png" }, 8_000).catch(() => null);
    if (!upstream) throw new HttpError(502, "upstream", "Texture server unavailable.");
    if (upstream.status === 404) throw new HttpError(404, "not_found", "Texture not found.");
    if (upstream.status !== 200) throw new HttpError(502, "upstream", "Texture server unavailable.");
    const bytes = new Uint8Array(await boundedBytes(upstream, MAX_TEXTURE_BYTES));
    // PNG signature.
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new HttpError(502, "upstream", "Not a PNG texture.");
    png = new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    ctx.waitUntil(caches.default.put(cacheKey, png.clone()).catch(() => undefined));
  }
  return new Response(png.body, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}
