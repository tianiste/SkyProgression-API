# SkyProgression API

A thin [Cloudflare Worker](https://developers.cloudflare.com/workers/) that gives the
[SkyProgression](https://github.com/tianiste/SkyProgression) mod the data it needs: a player's raw Hypixel
SkyBlock profiles and one cached bundle of market prices. All calculations run inside the mod; this Worker only
holds the Hypixel API key, caches, and rate-limits.

## Endpoints

All endpoints are `GET` and answer JSON. Errors look like `{"error": "message", "code": "rate_limited"}`.
Requests that carry a browser `Origin` header are refused (no CORS).

| Endpoint | What it returns |
| --- | --- |
| `/health` | `{"ok": true, "ready": <key configured>, "prices": {"updatedAt", "count"} \| null}` |
| `/uuid?name=<Minecraft name>` | `{"id": "<32 hex>", "name": "<name>"}` from Mojang, cached for a day (unknown names for 10 minutes). Mojang refuses many Cloudflare addresses (403, seen on the deployed Worker), so the mod asks Mojang itself and uses this only as a fallback; when Mojang refuses the Worker and a relay is configured, the relay looks the name up |
| `/profile?uuid=<32 hex>[&fresh=1]` | The raw Hypixel `v2/skyblock/profiles` body, passed through unparsed (max 16 MB). `X-Fetched-At` says when it was fetched; `X-Cache` is `HIT`, `STALE` or `MISS` |
| `/prices` | `{"updatedAt", "prices": {id: {buy, sell, source, updatedAt, available, npc?, npcUpdatedAt?}}, "mayor": [...] \| null, "complete", "bazaarAt"}` |
| `/resale?tag=<item>&Rarity=...` | `{"price": {...} \| null}`: Coflnet's lowest BIN for one item copy with its modifiers |

Status codes: `400` bad input, `404` unknown player, `429` rate limited (with `Retry-After`), `502` an upstream
service failed, `503` no or invalid Hypixel key (profiles only) or prices still loading.

### Profiles

A player's profiles are reused for 5 minutes. Older copies (up to 30 minutes) are returned at once while a
background refresh runs; `fresh=1` (the mod's explicit Load) waits for new data instead. If a refresh fails the
older copy is returned with an `X-Refresh-Error` header. Copies live in the isolate's memory and in the
[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/); the Cache API is only effective on a
custom domain, so on `workers.dev` only the in-memory copies help.

### Prices

The cron trigger runs every 3 minutes and does one small step each time, so a run stays inside the free plan:

- Bazaar items: one call to Hypixel's public `v2/skyblock/bazaar` every ~15 minutes. `buy` is the lowest sell
  offer (instant buy), `sell` the highest buy order (instant sell), Bazaar tax not included.
- Auction House items and level-100 pets: Coflnet `item/price/<id>/current` and `.../bin` lookups, 40 per run
  (about 175 items, so each quote is at most ~15 minutes old).
- NPC sell prices: `npc_sell_price` from the official `v2/resources/skyblock/items`, every 6 hours.
- Mayor and minister perks: `v2/resources/skyblock/election`, every 20 minutes.

The large Hypixel resources (3.6 MB and 4.8 MB) are scanned with a single regular expression instead of a full
`JSON.parse`: parsing them takes about 15 ms, more than the free plan's 10 ms CPU limit, while the scan takes
about 3 ms. The bundle is stored in Workers KV under one key (about 480 writes a day). A price that could not be
refreshed for 24 hours is dropped, so the mod shows it as unknown rather than stale. Missing prices are left out;
they are never reported as 0.

`src/price-ids.json` lists the IDs the mod reads. Regenerate it from the mod repository when the mod's catalog
changes:

```bash
./gradlew :core:exportPriceIds -PpriceIdsOut=../SkyProgression-API/src/price-ids.json
```

### Resale

Sale quotes for a player's own item copies depend on modifiers (rarity, reforge, recombobulation, drill parts,
pet level and item), so they cannot be bundled. The mod asks this Worker for each copy instead of calling Coflnet
itself: the Worker validates the filters, reuses Coflnet's filter list per item for an hour and each quote for
15 minutes, and the per-IP limit protects Coflnet from bursts. Quotes are shared between players.

## Limits

| Limit | Value |
| --- | --- |
| Requests per IP | 240 per minute (`/health` is not counted) |
| Hypixel refreshes per player | 4 per minute |
| Hypixel calls in total | 100 per minute per Cloudflare location |
| Profile body | 16 MB |

Rate limits use the [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/);
counts are per Cloudflare location and approximate.

Cloudflare free plan limits this design stays inside (checked October 2026): 100,000 requests a day, 10 ms CPU
per request or cron run, 50 subrequests per invocation, 5 cron triggers per account; KV allows 100,000 reads and
1,000 writes a day. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[KV limits](https://developers.cloudflare.com/kv/platform/limits/).

## Profile relay (application keys with an IP allowlist)

Hypixel application keys can be locked to an IP allowlist, and a Worker has no fixed outbound IP. Then the key lives on
a small fixed-IP server running the SkyProgression companion in relay mode (setup:
[deploy/relay](https://github.com/tianiste/SkyProgression/tree/main/deploy/relay) in the mod repository), and this
Worker forwards `/profile` to it:

- `RELAY_URL` (`vars` in `wrangler.jsonc`, e.g. `https://relay.skyprogression.dev`) and the `RELAY_SECRET` secret
  (`npx wrangler secret put RELAY_SECRET`, the same value as on the server). With both set, `/profile` goes to the relay
  and `HYPIXEL_API_KEY` is not needed; `/health` reports `"relay": true`.
- The relay answers only requests carrying the secret, so only this Worker can use the key. Caching, rate limits and
  error messages stay the same; relay failures answer `502`.
- With `HYPIXEL_API_KEY` also set, a rejected relay key or a relay that is down falls back to that key and skips the
  relay for 10 minutes; if that key is rejected meanwhile, the relay is asked again at once. With both keys rejected,
  `/profile` answers `503` (`bad_key`).
- `/uuid` uses the relay (`/uuid` with the same secret, cached for a day there) when Mojang refuses the Worker.

## Hypixel API key

**A Hypixel application key is needed for public use.** Personal developer keys are meant for personal and
development use, not for an app that other players use. Apply for an application key on the
[Hypixel Developer Dashboard](https://developer.hypixel.net/) and use that key here. Without a key, `/profile`
answers `503` and everything else keeps working.

The key is stored as a Worker secret and never appears in responses or logs. Never commit it, `.dev.vars`,
account IDs or API tokens to this public repository.

## Deploy

Requirements: Node.js 22 or later and a Cloudflare account (the free plan is enough).

```bash
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put HYPIXEL_API_KEY
```

`wrangler deploy` creates the `PRICES` KV namespace on the first deploy and writes its ID into your local
`wrangler.jsonc`. Keep that change local (do not commit it to this public repository); later deploys from the same
checkout reuse it. The first price bundle is complete about
15 minutes after deploying (one Bazaar step plus five Coflnet steps). Check it with
`curl https://<worker>.workers.dev/health`.

Then put the Worker URL in the mod's `config/skyprogression.json` (`"backend"`), or ship it as the mod's default.

Optional: add a custom domain (Workers & Pages > the Worker > Settings > Domains & Routes) so the Cache API is
used for profiles.

## Local development

```bash
npm ci
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/3+*+*+*+*"   # run one price step
```

To test profiles locally, provide the key through the process environment only (for example
`CLOUDFLARE_INCLUDE_PROCESS_ENV=true` with `HYPIXEL_API_KEY` set in that shell), or a Git-ignored `.dev.vars`.

## Checks

GitHub Actions type-checks the Worker and runs `wrangler deploy --dry-run` on every push. It does not deploy.

## License

MIT License, see [LICENSE](LICENSE).
