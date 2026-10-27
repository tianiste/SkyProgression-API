/** Short-lived cache of relay answers (memory first, then the Cache API), shared by /checklist and /player. */

export interface Entry { at: number; body: string }

const MEMORY_ENTRIES = 64;
const memory = new Map<string, Entry>();

function cacheKey(key: string): Request {
  return new Request(`https://skyprogression-api.internal/${key}`);
}

/** The entry for key when it is younger than maxMs. */
export async function cached(key: string, maxMs: number): Promise<Entry | undefined> {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < maxMs) return hit;
  const response = await caches.default.match(cacheKey(key));
  if (!response) return undefined;
  const at = Number(response.headers.get("X-At-Ms") ?? "0");
  if (!(Date.now() - at < maxMs)) return undefined;
  const entry = { at, body: await response.text() };
  memory.set(key, entry);
  return entry;
}

export function store(key: string, entry: Entry, maxMs: number, ctx: ExecutionContext): void {
  memory.delete(key);
  memory.set(key, entry);
  for (const old of memory.keys()) {
    if (memory.size <= MEMORY_ENTRIES) break;
    memory.delete(old);
  }
  ctx.waitUntil(caches.default.put(cacheKey(key), new Response(entry.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${Math.round(maxMs / 1000)}`, "X-At-Ms": String(entry.at) },
  })).catch(() => undefined));
}
