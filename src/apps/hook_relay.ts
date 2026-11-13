/**
 * A stable address for inbound webhooks. A payment provider is given one URL
 * and keeps it; a preview's address changes with every pull. Production's
 * host answers `POST /__forge/hook/<pull>/<path>` by handing the request,
 * untouched, to that pull's preview as `POST /<path>`. The body and headers
 * (so the provider's own signature) arrive as sent: the app verifies the
 * provider, the forge adds nothing it could break. Plain data in, plain data out.
 */

/** Largest body relayed: a webhook is a small JSON document. */
export const HOOK_MAX_BYTES = 1024 * 1024;

export const HOOK_PREFIX = "/__forge/hook/";

/** The pull and the path the preview is asked for, or nothing when the path is no hook's. */
export function hookPath(pathname: string): { pull: number; path: string } | undefined {
  if (!pathname.startsWith(HOOK_PREFIX)) return undefined;
  const match = /^([1-9]\d{0,8})(\/[^\s]*)?$/.exec(pathname.slice(HOOK_PREFIX.length));
  if (match === null) return undefined;
  const path = match[2] ?? "/";
  // No way out of the app's own paths, and none into the forge's.
  if (path.split("/").some((part) => part === ".." || part === ".")) return undefined;
  if (path.startsWith("//") || path.startsWith("/__forge")) return undefined;
  return { pull: Number(match[1]), path };
}

/** The body's bytes, or nothing once more than `max` have been read: the count is of bytes received, whatever the headers claimed. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
