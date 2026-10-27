import { HttpError, boundedBytes, boundedJson, get } from "./http";
import type { Env } from "./index";

/** A player's profiles are reused for five minutes; an older copy is served while a refresh runs (stale-while-revalidate). */
const FRESH_MS = 5 * 60_000;
/** How long a copy may be served as stale before it must be refetched. */
const STALE_MS = 30 * 60_000;
const MAX_PROFILE_BYTES = 16 * 1024 * 1024;
/** In-isolate copies, so repeated lookups work even where the Cache API is unavailable (workers.dev). */
const MEMORY_ENTRIES = 8;
const MEMORY_BYTES = 48 * 1024 * 1024;

export interface Entry { at: number; body: ArrayBuffer }

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

function remember(uuid: string, entry: Entry): void {
  memory.delete(uuid);
  memory.set(uuid, entry);
  let bytes = 0;
  for (const e of memory.values()) bytes += e.body.byteLength;
  for (const key of memory.keys()) {
    if (memory.size <= MEMORY_ENTRIES && bytes <= MEMORY_BYTES) break;
    bytes -= memory.get(key)!.body.byteLength;
    memory.delete(key);
  }
}

function cacheKey(kind: string, id: string): Request {
  return new Request(`https://skyprogression-api.internal/${kind}/${id}`);
}

async function cached(uuid: string): Promise<Entry | undefined> {
  const hit = memory.get(uuid);
  if (hit) return hit;
  const response = await caches.default.match(cacheKey("profile", uuid));
  if (!response) return undefined;
  const at = Number(response.headers.get("X-Fetched-At-Ms") ?? "0");
  const entry = { at, body: await response.arrayBuffer() };
  if (at > 0) remember(uuid, entry);
  return at > 0 ? entry : undefined;
}

function respond(entry: Entry, state: string, extra: Record<string, string> = {}): Response {
  return new Response(entry.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Fetched-At": new Date(entry.at).toISOString(),
      "X-Cache": state,
      ...extra,
    },
  });
}

async function fetchProfile(uuid: string, env: Env, ctx: ExecutionContext): Promise<Entry> {
  const relay = relayUrl(env);
  // Trimmed: a key pasted into the dashboard with a space or line break would otherwise be rejected as invalid.
  const key = env.HYPIXEL_API_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!relay && !key) throw new HttpError(503, "no_key", "The server has no Hypixel API key configured.");
  const player = await env.PLAYER_LIMIT.limit({ key: uuid });
  if (!player.success) throw new HttpError(429, "rate_limited", "This player was refreshed too often. Wait a minute.", 60);
  const global = await env.HYPIXEL_LIMIT.limit({ key: "hypixel" });
  if (!global.success) throw new HttpError(429, "rate_limited", "The server is busy. Wait a minute before loading again.", 60);
  let relayError: HttpError | undefined;
  if (relay && Date.now() >= relaySkipUntil) {
    try {
      return await fromRelay(relay, uuid, env, ctx);
    } catch (e) {
      // The relay's key not valid yet (e.g. an application key under review) or the relay down: use this Worker's own
      // key when it has one, and skip the relay for a while instead of asking it on every lookup.
      if (!(e instanceof HttpError) || !key || !relayFailure(e)) throw e;
      relayError = e;
      relaySkipUntil = Date.now() + RELAY_RETRY_MS;
    }
  }
  if (!key) throw new HttpError(503, "bad_key", "The profile relay has no working Hypixel key.");
  try {
    return await direct(uuid, key, ctx);
  } catch (e) {
    if (!(e instanceof HttpError) || e.code !== "bad_key" || !relay) throw e;
    // This Worker's key rejected while the relay was being skipped: the relay's key may have been approved meanwhile.
    if (!relayError) {
      try {
        const entry = await fromRelay(relay, uuid, env, ctx);
        relaySkipUntil = 0;
        return entry;
      } catch (r) {
        if (!(r instanceof HttpError) || !relayFailure(r)) throw r;
        relayError = r;
      }
    }
    throw relayError.code === "relay"
      ? new HttpError(503, "bad_key", `${e.message} The profile relay is unavailable.`)
      : new HttpError(503, "bad_key", "Both of the server's Hypixel API keys were rejected. Try again later.");
  }
}

/** A relay answer that another key may get past: its key rejected, or the relay unreachable. */
function relayFailure(e: HttpError): boolean {
  return e.code === "bad_key" || e.code === "relay";
}

/** After the relay's key was rejected or the relay failed, profiles go direct for this long before the relay is tried again. */
const RELAY_RETRY_MS = 10 * 60_000;
let relaySkipUntil = 0;

/** Hypixel called from the Worker with its own key (a personal or development key; no IP allowlist). */
async function direct(uuid: string, key: string, ctx: ExecutionContext): Promise<Entry> {
  const response = await get(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${uuid}`, { "API-Key": key }, 15_000);
  if (response.status === 403) {
    // Hypixel's short reason ("Invalid API key"), never the key itself.
    const cause = await boundedJson<{ cause?: string }>(response, 4096).then((b) => String(b.cause ?? "").slice(0, 80)).catch(() => "");
    throw new HttpError(503, "bad_key", `The server's Hypixel API key was rejected${cause ? ` (Hypixel: ${cause})` : ""}.`);
  }
  if (response.status === 429) throw new HttpError(429, "rate_limited", "Hypixel rate limit reached. Wait a few minutes.", 120);
  if (response.status === 404 || response.status === 204) throw new HttpError(404, "not_found", "Player not found.");
  if (response.status !== 200) throw new HttpError(502, "upstream", `Hypixel returned ${response.status}.`);
  return store(uuid, { at: Date.now(), body: await boundedBytes(response, MAX_PROFILE_BYTES) }, ctx);
}

/** Relay base URL when both RELAY_URL and RELAY_SECRET are configured, else null (the Worker calls Hypixel itself). */
export function relayUrl(env: Env): string | null {
  const url = env.RELAY_URL?.trim().replace(/\/+$/, "");
  return url && env.RELAY_SECRET?.trim() ? url : null;
}

/**
 * Hypixel application keys can be locked to an IP allowlist, and Workers have no fixed outbound IP, so the key may live
 * on a fixed-IP server running the companion in relay mode. Its answers keep their status and message.
 */
async function fromRelay(relay: string, uuid: string, env: Env, ctx: ExecutionContext): Promise<Entry> {
  const response = await get(`${relay}/profile?uuid=${uuid}&fresh=1`, { "X-Relay-Secret": env.RELAY_SECRET!.trim() }, 20_000);
  if (response.status !== 200) {
    const message = await boundedJson<{ error?: string }>(response, 4096).then((b) => String(b.error ?? "").slice(0, 160)).catch(() => "");
    if (response.status === 429) throw new HttpError(429, "rate_limited", message || "Hypixel rate limit reached. Wait a few minutes.", 120);
    if (response.status === 404 && message !== "Unknown endpoint") throw new HttpError(404, "not_found", message || "Player not found.");
    if (response.status === 503) throw new HttpError(503, "bad_key", message || "The profile relay has no working Hypixel key.");
    throw new HttpError(502, "relay", "The profile relay is unavailable. Try again later.");
  }
  const fetchedAt = Date.parse(response.headers.get("X-Fetched-At") ?? "");
  return store(uuid, { at: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(), body: await boundedBytes(response, MAX_PROFILE_BYTES) }, ctx);
}

function store(uuid: string, entry: Entry, ctx: ExecutionContext): Entry {
  remember(uuid, entry);
  ctx.waitUntil(caches.default.put(cacheKey("profile", uuid), new Response(entry.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${STALE_MS / 1000}`, "X-Fetched-At-Ms": String(entry.at) },
  })).catch(() => undefined));
  return entry;
}

/** One upstream fetch per player at a time within this isolate. */
function refresh(uuid: string, env: Env, ctx: ExecutionContext): Promise<Entry> {
  let pending = inflight.get(uuid);
  if (!pending) {
    pending = fetchProfile(uuid, env, ctx).finally(() => inflight.delete(uuid));
    inflight.set(uuid, pending);
  }
  return pending;
}

/** Raw Hypixel profiles response for a UUID. fresh: refetch when the copy is older than five minutes instead of serving it. */
export async function profile(uuid: string, fresh: boolean, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { entry, state, refreshError } = await profileEntry(uuid, fresh, env, ctx);
  return respond(entry, state, refreshError ? { "X-Refresh-Error": refreshError } : {});
}

/**
 * The cached or freshly fetched profiles body with its state (HIT, STALE or MISS): relay first, then this Worker's own
 * key, with the per-player and Hypixel limits. /profile and /checklist share it.
 */
export async function profileEntry(uuid: string, fresh: boolean, env: Env, ctx: ExecutionContext): Promise<{ entry: Entry; state: string; refreshError?: string }> {
  const entry = await cached(uuid);
  const age = entry ? Date.now() - entry.at : Infinity;
  if (entry && age < FRESH_MS) return { entry, state: "HIT" };
  if (entry && age < STALE_MS && !fresh) {
    ctx.waitUntil(refresh(uuid, env, ctx).catch(() => undefined));
    return { entry, state: "STALE" };
  }
  try {
    return { entry: await refresh(uuid, env, ctx), state: "MISS" };
  } catch (e) {
    // A failed refresh still answers with the copy we have, labelled, rather than an error.
    if (entry && e instanceof HttpError && e.status !== 404) return { entry, state: "STALE", refreshError: e.code };
    throw e;
  }
}

const names = new Map<string, { at: number; id: string; name: string } | { at: number; missing: true }>();

/** Minecraft name to UUID through Mojang, cached for a day (unknown names for ten minutes). */
export async function uuid(name: string, env: Env, ctx: ExecutionContext): Promise<{ id: string; name: string }> {
  const key = name.toLowerCase();
  const hit = names.get(key);
  if (hit && Date.now() - hit.at < ("missing" in hit ? 10 * 60_000 : 24 * 3600_000)) {
    if ("missing" in hit) throw new HttpError(404, "not_found", "Minecraft player not found.");
    return { id: hit.id, name: hit.name };
  }
  const cachedResponse = await caches.default.match(cacheKey("uuid", key));
  if (cachedResponse) {
    const value = await cachedResponse.json<{ id: string; name: string }>();
    names.set(key, { at: Date.now(), ...value });
    return value;
  }
  let response: Response | undefined;
  // The services host first; the older API host as a fallback when one of them is unavailable.
  for (const url of [`https://api.minecraftservices.com/minecraft/profile/lookup/name/${name}`, `https://api.mojang.com/users/profiles/minecraft/${name}`]) {
    try {
      response = await get(url, {}, 8_000);
      if (response.status === 200 || response.status === 404 || response.status === 204) break;
    } catch {
      response = undefined;
    }
  }
  const relay = relayUrl(env);
  if (relay && (!response || (response.status !== 200 && response.status !== 404 && response.status !== 204))) {
    // Mojang refuses many Cloudflare addresses (403): ask the relay, which looks names up from its own IP.
    response = (await get(`${relay}/uuid?name=${name}`, { "X-Relay-Secret": env.RELAY_SECRET!.trim() }, 10_000).catch(() => undefined)) ?? response;
    if (response?.status === 404) {
      // An older relay without /uuid answers "Unknown endpoint"; that is not an unknown player.
      const message = await boundedJson<{ error?: string }>(response.clone(), 4096).then((b) => String(b.error ?? "")).catch(() => "");
      if (message === "Unknown endpoint") throw new HttpError(502, "upstream", "Mojang is unavailable. Try again later.");
    }
  }
  if (!response) throw new HttpError(502, "upstream", "Mojang is unavailable. Try again later.");
  if (response.status === 404 || response.status === 204) {
    names.set(key, { at: Date.now(), missing: true });
    throw new HttpError(404, "not_found", "Minecraft player not found.");
  }
  if (response.status === 429) throw new HttpError(429, "rate_limited", "Mojang rate limit reached. Wait a minute.", 60);
  if (response.status !== 200) throw new HttpError(502, "upstream", `Mojang returned ${response.status}.`);
  const body = await boundedJson<{ id?: string; name?: string }>(response, 64 * 1024);
  if (!body.id || !/^[0-9a-f]{32}$/i.test(body.id)) throw new HttpError(404, "not_found", "Minecraft player not found.");
  const value = { id: body.id.toLowerCase(), name: body.name ?? name };
  if (names.size > 2000) names.clear();
  names.set(key, { at: Date.now(), ...value });
  ctx.waitUntil(caches.default.put(cacheKey("uuid", key), new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" },
  })).catch(() => undefined));
  return value;
}
