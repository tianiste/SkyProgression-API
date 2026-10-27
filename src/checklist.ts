import { HttpError, baseHeaders, boundedJson, boundedText, USER_AGENT } from "./http";
import type { Env } from "./index";
import { profileEntry, relayUrl, uuid } from "./profile";
import { cached, store } from "./results";

/** Pages that may call /checklist, /player and /texture from a browser: the website, www and the local Astro dev server. */
const ORIGINS = new Set(["https://skyprogression.dev", "https://www.skyprogression.dev", "http://localhost:4321", "http://127.0.0.1:4321"]);
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
/** A result is reused this long for the same player, profile and requirements (the profile copy itself is fresh for 5 minutes). */
const RESULT_MS = 2 * 60_000;

/** CORS headers for an allowed page origin; empty for requests without Origin (the mod, curl). Throws for other origins. */
export function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  if (!ORIGINS.has(origin)) throw new HttpError(403, "forbidden", "This page may not use the API.");
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Expose-Headers": "X-Cache, Retry-After" };
}

export function preflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: { ...cors(request), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
  });
}

interface Body { ign?: unknown; uuid?: unknown; profile?: unknown; requirements?: unknown }

/**
 * POST /checklist {"ign" or "uuid", "profile"?, "requirements": [...]}: a guide's requirements checked against the
 * player's profile by the engine on the relay. Answers the relay's JSON (results, profiles, fetchedAt, api) plus the
 * player's name.
 */
export async function checklist(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.CHECKLIST_LIMIT.limit({ key: ip })).success) throw new HttpError(429, "rate_limited", "Too many lookups. Wait a minute.", 60);
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request too large.");
  let body: Body;
  try {
    body = JSON.parse(await boundedText(request, MAX_BODY_BYTES)) as Body;
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(413, "too_large", "Request too large.");
    throw new HttpError(400, "bad_request", "Body must be JSON.");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.requirements)) throw new HttpError(400, "bad_request", "requirements must be an array.");
  const profile = typeof body.profile === "string" ? body.profile.trim() : "";
  if (!/^[A-Za-z0-9 -]{0,64}$/.test(profile)) throw new HttpError(400, "bad_request", "Invalid profile.");
  let id = typeof body.uuid === "string" ? body.uuid.replaceAll("-", "").toLowerCase() : "";
  let player: string | undefined;
  if (!id) {
    const name = typeof body.ign === "string" ? body.ign.trim() : "";
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new HttpError(400, "bad_request", "Enter a valid Minecraft name.");
    ({ id, name: player } = await uuid(name, env, ctx));
  }
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(400, "bad_request", "uuid must be 32 hex characters.");

  const requirements = JSON.stringify(body.requirements);
  const key = `${id}/${profile.toLowerCase()}/${await sha256(requirements)}`;
  const hit = await cached(`checklist/${key}`, RESULT_MS);
  if (hit) return answer(hit.body, player, "HIT");

  // The engine runs on the relay; without one there is nothing to evaluate with.
  const relay = relayUrl(env);
  if (!relay) throw new HttpError(503, "unavailable", "Player lookup is not available yet.");
  // The profile comes the same way as /profile (cache, relay, then this Worker's own key, per-player and Hypixel limits);
  // several guides for one player reuse the cached copy. The relay only runs the engine on it.
  const { entry } = await profileEntry(id, false, env, ctx);
  const head = JSON.stringify({ uuid: id, profile, fetchedAt: new Date(entry.at).toISOString() });
  // The raw body is spliced in as bytes: parsing a large profile would cost more CPU than the Worker has.
  const payload = new Blob([`${head.slice(0, -1)},"requirements":${requirements},"data":`, entry.body, "}"]);
  let response: Response;
  try {
    response = await fetch(`${relay}/checklist`, {
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
    // A relay from before /checklist answers "Unknown endpoint".
    if (response.status === 404 && message === "Unknown endpoint") throw new HttpError(503, "unavailable", "Player lookup is not available yet.");
    if (response.status === 404) throw new HttpError(404, "not_found", message || "Player not found.");
    if (response.status === 400 && message.startsWith("data is required")) throw new HttpError(503, "unavailable", "Player lookup is not available yet.");
    if (response.status === 400 || response.status === 413) throw new HttpError(response.status, "bad_request", message || "Invalid request.");
    if (response.status === 429) throw new HttpError(429, "rate_limited", message || "Hypixel rate limit reached. Wait a few minutes.", 120);
    throw new HttpError(502, "relay", "The profile server is down. Try again later.");
  }
  const text = await boundedText(response, MAX_RESULT_BYTES);
  store(`checklist/${key}`, { at: Date.now(), body: text }, RESULT_MS, ctx);
  return answer(text, player, "MISS");
}

function answer(body: string, player: string | undefined, state: string): Response {
  // The relay knows the UUID only; add the name the Worker resolved.
  const value = JSON.parse(body) as Record<string, unknown>;
  if (player) value.player = player;
  return new Response(JSON.stringify(value), {
    headers: { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", "X-Cache": state },
  });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
