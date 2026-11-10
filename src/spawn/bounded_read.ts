/**
 * A request body read by the bytes that actually arrive. A Content-Length
 * is the client's claim and a chunked body makes none, so the stream is
 * counted and the read stops one chunk past the limit: nothing past `max`
 * is ever held. Undefined past the limit or when the client goes away.
 */

export async function readCapped(req: Request, max: number): Promise<Uint8Array | undefined> {
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
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
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks);
}
