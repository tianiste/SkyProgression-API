/** Shared response helpers and bounded upstream fetches. */

export const USER_AGENT = "SkyProgression-API (github.com/tianiste/SkyProgression-API)";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", ...headers } });
}

export function error(e: HttpError): Response {
  const headers: Record<string, string> = {};
  if (e.retryAfter) headers["Retry-After"] = String(e.retryAfter);
  return json({ error: e.message, code: e.code }, e.status, headers);
}

export function baseHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

/** GET with a timeout; the caller decides how much of the body to read. */
export async function get(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
}

/** Whole body as bytes, refusing anything larger than maxBytes (checked on the header and while reading). */
/** A request body can be read the same way. */
type Body = Pick<Response, "headers" | "body">;

export async function boundedBytes(response: Body, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new HttpError(502, "too_large", "Upstream response too large");
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(502, "too_large", "Upstream response too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out.buffer;
}

export async function boundedText(response: Body, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await boundedBytes(response, maxBytes));
}

export async function boundedJson<T>(response: Body, maxBytes: number): Promise<T> {
  return JSON.parse(await boundedText(response, maxBytes)) as T;
}
