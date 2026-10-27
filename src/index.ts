import { HttpError, error, json } from "./http";
import { priceStatus, prices, refreshPrices, resale } from "./prices";
import { profile, relayUrl, uuid } from "./profile";

export interface Env {
  /** Hypixel API key (Worker secret). Without it /profile answers 503; prices still work. */
  HYPIXEL_API_KEY?: string;
  /** Optional fixed-IP profile relay (the companion in relay mode) and its shared secret; when set, /profile goes there. */
  RELAY_URL?: string;
  RELAY_SECRET?: string;
  PRICES: KVNamespace;
  IP_LIMIT: RateLimit;
  PLAYER_LIMIT: RateLimit;
  HYPIXEL_LIMIT: RateLimit;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") throw new HttpError(405, "method", "GET required.");
  // Browsers send Origin on cross-site requests; the mod does not. No CORS: pages cannot use this API.
  if (request.headers.has("Origin")) throw new HttpError(403, "forbidden", "Browser access is not supported.");
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ ok: true, ready: Boolean(env.HYPIXEL_API_KEY?.trim() || relayUrl(env)), relay: Boolean(relayUrl(env)), prices: await priceStatus(env).catch(() => null) });
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.IP_LIMIT.limit({ key: ip })).success) throw new HttpError(429, "rate_limited", "Too many requests. Wait a minute.", 60);
  switch (url.pathname) {
    case "/profile": {
      const id = (url.searchParams.get("uuid") ?? "").replaceAll("-", "").toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(400, "bad_request", "uuid must be 32 hex characters.");
      return profile(id, url.searchParams.get("fresh") === "1", env, ctx);
    }
    case "/uuid": {
      const name = url.searchParams.get("name") ?? "";
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new HttpError(400, "bad_request", "Enter a valid Minecraft name.");
      return json(await uuid(name, ctx));
    }
    case "/prices":
      return prices(env);
    case "/resale":
      return resale(url);
    default:
      throw new HttpError(404, "unknown_endpoint", "Unknown endpoint");
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return error(e);
      // Never echo upstream bodies or keys; a short generic message is enough for the mod.
      return error(new HttpError(502, "upstream", "Data service unavailable. Please try again later."));
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(refreshPrices(env).then((r) => console.log(`prices: ${r.step}, ${r.auctions} auction quotes, ${r.prices} prices`)));
  },
} satisfies ExportedHandler<Env>;
