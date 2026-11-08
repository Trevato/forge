/**
 * Content-Encoding for the bodies the forge writes itself (#2915 check 7): pages,
 * stylesheets, scripts, JSON, text and XML, as br or gzip when `Accept-Encoding` allows.
 * Both come from the runtime (`Bun.gzipSync`, `node:zlib` brotli); no
 * dependency. A body under MIN_BYTES is left alone, and so is anything that
 * is not on the type list: SSE, git streams, log follows and tarballs keep
 * their bytes and their flush.
 *
 * Bodies that never change (hashed assets) are encoded once and kept (brotli 9: q11 blocks the loop ~0.3 s on the stylesheet); the rest
 * are encoded per response at a speed-first level.
 */

import { brotliCompressSync, constants } from "node:zlib";

export type Encoding = "br" | "gzip";

/** Below this the headers cost more than the bytes saved. */
export const MIN_BYTES = 1024;

const TYPES = new Set([
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/manifest+json",
  "image/svg+xml",
  // The site's words for crawlers and agents: /llms.txt, /robots.txt, the
  // sitemap and the feeds. Left off, the edge encoded them with no Vary (#8328).
  "text/markdown",
  "text/plain",
  "text/xml",
  "application/xml",
  "application/atom+xml",
  "application/rss+xml",
  // /opensearch.xml (#8332).
  "application/opensearchdescription+xml",
]);

/** The encoding to use: br over gzip, a `q=0` or absent coding refused. */
export function negotiate(header: string | null): Encoding | null {
  if (header === null) return null;
  const q: Record<string, number> = {};
  for (const part of header.split(",")) {
    const [name, ...params] = part.split(";");
    let value = 1;
    for (const p of params) {
      const [k, v] = p.split("=").map((x) => x.trim().toLowerCase());
      if (k === "q") value = Number(v);
    }
    const key = (name ?? "").trim().toLowerCase();
    if (key && Number.isFinite(value)) q[key] = value;
  }
  if ((q["br"] ?? 0) > 0) return "br";
  if ((q["gzip"] ?? q["x-gzip"] ?? 0) > 0) return "gzip";
  return null;
}

const mediaType = (type: string | null) => (type ?? "").split(";")[0]!.trim().toLowerCase();

function encode(bytes: Uint8Array<ArrayBuffer>, encoding: Encoding, best: boolean): Uint8Array {
  if (encoding === "gzip") return Bun.gzipSync(bytes, { level: best ? 9 : 4 });
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: best ? 9 : 4,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

/** Speed-first encoding of a body built per response. */
export const compressBytes = (bytes: Uint8Array<ArrayBuffer>, encoding: Encoding) => encode(bytes, encoding, false);

const kept = new Map<string, Uint8Array>();
const KEPT_MAX = 64;

/** Encoded once per `key` (a content hash) and `encoding`, for bodies that never change. */
export function encodeOnce(key: string, bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): Uint8Array {
  const id = `${encoding}:${key}`;
  let out = kept.get(id);
  if (out === undefined) {
    out = encode(bytes, encoding, true);
    if (kept.size >= KEPT_MAX) kept.clear();
    kept.set(id, out);
  }
  return out;
}

/**
 * The response with its body encoded if the request allows it, else the
 * response as it came. `Vary: Accept-Encoding` goes on every compressible type,
 * encoded or not, so a cache never hands a small plain copy's key to the wrong
 * client. Headers are rewritten in place, as `securityFloor` does.
 */
export async function compress(request: Request, response: Response): Promise<Response> {
  try {
    if (!TYPES.has(mediaType(response.headers.get("content-type")))) return response;
    const vary = response.headers.get("vary");
    if (!/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary ?? ""))
      response.headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    const encoding = negotiate(request.headers.get("accept-encoding"));
    if (
      encoding === null ||
      request.method === "HEAD" ||
      response.body === null ||
      response.status === 206 ||
      response.headers.has("content-encoding") ||
      /\bno-transform\b/i.test(response.headers.get("cache-control") ?? "")
    )
      return response;
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (bytes.length < MIN_BYTES) return new Response(bytes, response);
    const out = new Response(encode(bytes, encoding, false), response);
    out.headers.set("content-encoding", encoding);
    out.headers.delete("content-length");
    return out;
  } catch {
    return response;
  }
}
