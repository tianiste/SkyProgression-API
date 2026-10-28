import { HttpError, baseHeaders, boundedBytes, boundedJson, boundedText, get, USER_AGENT } from "./http";
import type { Env } from "./index";
import { bundleText } from "./prices";
import { knownUuid, profileEntry, relayUrl, rememberUuid, uuid } from "./profile";
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
 * The relay is asked first, without a profile: it answers from a copy it already holds (under five minutes old, the same
 * rule as this Worker's profile cache) and resolves names itself, so another Cloudflare location does not look the name up
 * or fetch the profile again. Only when it holds none (409) does the Worker get the profile as for /profile and send it with
 * its price bundle (both unparsed). The page's JSON is cached here for two minutes per player, profile, view and options.
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
  let ign = "";
  if (!id) {
    ign = (q.get("ign") ?? "").trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(ign)) throw new HttpError(400, "bad_request", "Enter a valid Minecraft name.");
    // Only names already resolved in this location; the relay resolves the others.
    const known = await knownUuid(ign);
    if (known) ({ id, name } = known);
  } else if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(400, "bad_request", "uuid must be 32 hex characters.");

  const options = view === "hotm" ? "-" : `${method}/${price}/${cost}/${god}/${view === "gear" ? gear : "best"}`;
  const keyOf = (uuid: string) => `player/${uuid}/${profile.toLowerCase()}/${view}/${options}`;
  if (id) {
    const hit = await cached(keyOf(id), RESULT_MS);
    if (hit) return answer(hit.body, "HIT");
  }

  // Only work that reaches the relay counts towards the lookup limit.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.CHECKLIST_LIMIT.limit({ key: ip })).success) throw new HttpError(429, "rate_limited", "Too many lookups. Wait a minute.", 60);
  const relay = relayUrl(env);
  if (!relay) throw new HttpError(503, "unavailable", "Player pages are not available yet.");
  const bundle = await bundleText(env);
  const named = Date.now();
  const head = { uuid: id, player: id ? name : ign, view, profile, method, price, cost, god, gear };
  let response = await postWeb(relay, env, head, bundle, null);
  const asked = Date.now();
  const timing = [`name;dur=${named - started}`, `relay;dur=${asked - named}`];
  if (response.status === 200) {
    const sent = response.headers.get("X-Uuid") ?? "";
    if (!id && /^[0-9a-f]{32}$/.test(sent)) {
      id = sent;
      rememberUuid(ign, { id, name: (response.headers.get("X-Player") ?? "").replace(/[^A-Za-z0-9_]/g, "") || ign }, ctx);
    }
  } else {
    const message = await boundedJson<{ error?: string; uuid?: string; name?: string }>(response, 4096).catch(() => ({} as { error?: string; uuid?: string; name?: string }));
    // 409: the relay holds no fresh copy; a relay from before this answers 400 without the profile.
    const before = response.status === 400 && String(message.error ?? "").startsWith("data and bundle are required");
    // When the relay could not reach Mojang for an unknown name, this Worker looks it up itself below.
    const noName = !id && response.status === 502;
    if (response.status !== 409 && !before && !noName) throw relayError(response.status, String(message.error ?? ""));
    if (!id && response.status === 409 && /^[0-9a-f]{32}$/.test(message.uuid ?? "")) {
      ({ id, name } = { id: message.uuid!, name: String(message.name ?? "").replace(/[^A-Za-z0-9_]/g, "") || ign });
      rememberUuid(ign, { id, name }, ctx);
    }
    if (!id) ({ id, name } = await uuid(ign, env, ctx));
    if (ign) {
      const hit = await cached(keyOf(id), RESULT_MS);
      if (hit) return answer(hit.body, "HIT");
    }
    const { entry, state } = await profileEntry(id, false, env, ctx);
    const fetched = Date.now();
    response = await postWeb(relay, env, { ...head, uuid: id, player: name, fetchedAt: new Date(entry.at).toISOString() }, bundle, entry.body);
    timing.push(`profile;dur=${fetched - asked};desc=${state}`, `upload;dur=${Date.now() - fetched}`);
    if (response.status !== 200) {
      const error = await boundedJson<{ error?: string }>(response, 4096).then((b) => String(b.error ?? "")).catch(() => "");
      throw relayError(response.status, error);
    }
  }
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(502, "relay", "The profile server is down. Try again later.");
  const text = await boundedText(response, MAX_RESULT_BYTES);
  store(keyOf(id), { at: Date.now(), body: text }, RESULT_MS, ctx);
  // Where a computed page's time went (Worker clocks advance only across I/O); the relay adds its own read, decode and build.
  const relayTiming = (response.headers.get("Server-Timing") ?? "").replace(/[^a-z0-9;=., ]/gi, "").split(", ").filter(Boolean).map((t) => `relay-${t}`);
  return answer(text, "MISS", [...timing, ...relayTiming].join(", "));
}

/** POST /web on the relay: the options, the price bundle and (when not null) the profile, spliced in as text (parsing them would cost more CPU than the Worker has). */
async function postWeb(relay: string, env: Env, head: Record<string, unknown>, bundle: string, data: ArrayBuffer | null): Promise<Response> {
  const text = JSON.stringify(head);
  const parts: (string | ArrayBuffer)[] = [`${text.slice(0, -1)},"bundle":`, bundle];
  if (data) parts.push(`,"data":`, data);
  parts.push("}");
  try {
    return await fetch(`${relay}/web`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", Accept: "application/json", "X-Relay-Secret": env.RELAY_SECRET!.trim() },
      body: new Blob(parts),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new HttpError(502, "relay", "The profile server is down. Try again later.");
  }
}

function relayError(status: number, error: string): HttpError {
  const message = error.slice(0, 160);
  // A relay from before /web answers "Unknown endpoint".
  if (status === 404 && message === "Unknown endpoint") return new HttpError(503, "unavailable", "Player pages are not available yet.");
  if (status === 404) return new HttpError(404, "not_found", message || "Player not found.");
  if (status === 400 || status === 413) return new HttpError(status, "bad_request", message || "Invalid request.");
  if (status === 429) return new HttpError(429, "rate_limited", message || "Mojang rate limit reached. Wait a minute.", 60);
  return new HttpError(502, "relay", "The profile server is down. Try again later.");
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
