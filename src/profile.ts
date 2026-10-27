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

interface Entry { at: number; body: ArrayBuffer }

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
  // Trimmed: a key pasted into the dashboard with a space or line break would otherwise be rejected as invalid.
  const key = env.HYPIXEL_API_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!key) throw new HttpError(503, "no_key", "The server has no Hypixel API key configured.");
  const player = await env.PLAYER_LIMIT.limit({ key: uuid });
  if (!player.success) throw new HttpError(429, "rate_limited", "This player was refreshed too often. Wait a minute.", 60);
  const global = await env.HYPIXEL_LIMIT.limit({ key: "hypixel" });
  if (!global.success) throw new HttpError(429, "rate_limited", "The server is busy. Wait a minute before loading again.", 60);
  const response = await get(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${uuid}`, { "API-Key": key }, 15_000);
  if (response.status === 403) {
    // Hypixel's short reason ("Invalid API key"), never the key itself.
    const cause = await boundedJson<{ cause?: string }>(response, 4096).then((b) => String(b.cause ?? "").slice(0, 80)).catch(() => "");
    throw new HttpError(503, "bad_key", `The server's Hypixel API key was rejected${cause ? ` (Hypixel: ${cause})` : ""}.`);
  }
  if (response.status === 429) throw new HttpError(429, "rate_limited", "Hypixel rate limit reached. Wait a few minutes.", 120);
  if (response.status === 404 || response.status === 204) throw new HttpError(404, "not_found", "Player not found.");
  if (response.status !== 200) throw new HttpError(502, "upstream", `Hypixel returned ${response.status}.`);
  const entry = { at: Date.now(), body: await boundedBytes(response, MAX_PROFILE_BYTES) };
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
  const entry = await cached(uuid);
  const age = entry ? Date.now() - entry.at : Infinity;
  if (entry && age < FRESH_MS) return respond(entry, "HIT");
  if (entry && age < STALE_MS && !fresh) {
    ctx.waitUntil(refresh(uuid, env, ctx).catch(() => undefined));
    return respond(entry, "STALE");
  }
  try {
    return respond(await refresh(uuid, env, ctx), "MISS");
  } catch (e) {
    // A failed refresh still answers with the copy we have, labelled, rather than an error.
    if (entry && e instanceof HttpError && e.status !== 404) return respond(entry, "STALE", { "X-Refresh-Error": e.code });
    throw e;
  }
}

const names = new Map<string, { at: number; id: string; name: string } | { at: number; missing: true }>();

/** Minecraft name to UUID through Mojang, cached for a day (unknown names for ten minutes). */
export async function uuid(name: string, ctx: ExecutionContext): Promise<{ id: string; name: string }> {
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
