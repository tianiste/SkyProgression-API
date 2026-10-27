# Contributing to SkyProgression API

This Worker is the hosted backend of the [SkyProgression](https://github.com/tianiste/SkyProgression) mod. Bug reports
and pull requests are welcome; the mod repository's [CONTRIBUTING.md](https://github.com/tianiste/SkyProgression/blob/main/CONTRIBUTING.md)
has the general guidelines.

## Running it locally

You need Node.js 22 or newer.

```bash
npm ci
npm run check      # type-check
npx wrangler dev   # local Worker on http://localhost:8787
```

For `/profile`, give the local Worker a Hypixel key through a Git-ignored `.dev.vars` file (`HYPIXEL_API_KEY=...`) or
the environment. Prices and `/health` work without a key.

## Rules for changes

- **Stay thin.** The Worker fetches, caches and rate-limits raw data. All calculations belong in the mod's `core/`.
- **Stay inside the free plan.** Keep CPU time per request small (no full parse of the large Hypixel resources) and
  respect the subrequest, KV write and request limits described in the [README](README.md).
- **Never commit secrets.** Keys, `.dev.vars`, tokens and Cloudflare account details stay out of Git. Wrangler may
  write a KV namespace ID into your local `wrangler.jsonc` on deploy; do not commit that line.
- **Never log keys or full responses.** Error messages may include Hypixel's short reason, never the key.
- **Unknown is not zero.** A missing price is left out, never reported as 0.

GitHub Actions type-checks every push and runs `wrangler deploy --dry-run`. Deploying is done by the maintainer.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
