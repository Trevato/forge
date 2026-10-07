/**
 * How much of a request body the forge will read, in one place.
 *
 * A declared length is a claim, and a chunked body declares none, so every
 * reader here counts the stream itself and stops keeping bytes at its cap.
 * What is past the cap is still read off the wire and dropped, up to
 * DRAIN_MAX more, so a body that ends there leaves the connection framed
 * and the next request on it is read as itself. A cancelled read would
 * leave the rest on the connection to be taken for the next request — and a
 * client that ignores "Connection: close" (Bun's own fetch does) would send
 * one. A body past even the drain budget is abuse: reading stops, and the
 * connection is closed once the answer is sent (a proxy that could not
 * finish writing a body never reuses its connection). A body no route read
 * and no length declared gets the same: drained within the budget, else
 * closed — left alone, the runtime would drain it for as long as the client
 * sends.
 *
 * The caps:
 *   REQUEST_MAX   the listener's own ceiling (\`maxRequestBodySize\`): the
 *                 largest thing anyone may send, a git push. The runtime
 *                 enforces it on a declared length only.
 *   BODY_MAX      any JSON or form body read by the shared readers.
 *   STRANGER_MAX  a body someone without a token may send: signing up or
 *                 in, a report, a client registration.
 *   FETCH_MAX     a git fetch's negotiation (wants and haves), decompressed.
 *   GZIP_MAX      that negotiation as sent, when the client compressed it.
 *   PUSH_MAX      a git push's pack, as it streams to git.
 *   DRAIN_MAX     what is read and dropped past a cap before giving up.
 */

export const PUSH_MAX = 512 * 1024 * 1024;
export const REQUEST_MAX = PUSH_MAX;
export const BODY_MAX = 16 * 1024 * 1024;
export const STRANGER_MAX = 64 * 1024;
export const FETCH_MAX = 16 * 1024 * 1024;
export const DRAIN_MAX = 1024 * 1024;
export const GZIP_MAX = 1024 * 1024;

const closing = new WeakSet<Request>();
const signedIn = new WeakSet<Request>();

/**
 * The request carries a signed-in person or a token. A body is read before
 * a route checks who is asking, so the cap is decided here: anyone else is
 * a stranger and gets STRANGER_MAX, whatever route they call.
 */
export const noteSignedIn = (request: Request): void => {
  signedIn.add(request);
};

/** The most a shared reader keeps of this request's body. */
export const bodyCapFor = (request: Request): number =>
  signedIn.has(request) ? BODY_MAX : STRANGER_MAX;

/** A request rebuilt from another (a replay) keeps what was noted of it. */
export const carryNotes = (from: Request, to: Request): void => {
  if (signedIn.has(from)) signedIn.add(to);
  const close = closers.get(from);
  if (close !== undefined) closers.set(to, close);
};
const closers = new WeakMap<Request, () => void>();

/** The listener says how to close a request's connection (\`server.timeout\`). */
export const armClose = (request: Request, close: () => void): void => {
  closers.set(request, close);
};

/**
 * Mark this request's connection to close once it is answered. The listener
 * writes the answer first (`http/server.ts`), then ends the connection —
 * calling the armed closer here would abort before a 401/413 for an
 * oversize body could leave, and the client would see an empty hang-up.
 */
export const closeAfter = (request: Request): void => {
  closing.add(request);
};

/**
 * End the connection now: a refusal found mid-stream after the answer
 * began (a git push past its cap). Marks the same as {@link closeAfter},
 * and fires the armed closer at once.
 */
export const closeNow = (request: Request): void => {
  closing.add(request);
  closers.get(request)?.();
};

/** Whether the connection must close after the answer. */
export const mustClose = (request: Request): boolean => closing.has(request);

/** Anything that reads chunks: a request body's reader. */
interface Reader {
  read(): Promise<{ done: boolean; value?: { byteLength: number } }>;
  cancel?(reason?: unknown): Promise<void>;
}

/**
 * Read and drop up to \`budget\` bytes; true when the body ended inside it.
 * Past the budget the reader is cancelled so the runtime is not left
 * waiting on the rest of a chunked body — that hang-up ate the answer
 * for a stranger's oversize POST before 401/413 could leave.
 */
async function drain(reader: Reader, budget: number): Promise<boolean> {
  let dropped = 0;
  for (;;) {
    let read: Awaited<ReturnType<Reader["read"]>>;
    try {
      read = await reader.read();
    } catch {
      return false;
    }
    if (read.done) return true;
    dropped += read.value?.byteLength ?? 0;
    if (dropped > budget) {
      try {
        await reader.cancel?.("drain budget");
      } catch {
        // Already gone.
      }
      return false;
    }
  }
}

/**
 * After the answer: a body no route read and no length declared is drained
 * within the budget, or its connection is closed.
 */
export async function settleBody(request: Request): Promise<void> {
  if (
    request.body === null ||
    request.bodyUsed ||
    request.headers.get("content-length") !== null
  )
    return;
  if (!(await drain(request.body.getReader(), DRAIN_MAX))) closeAfter(request);
}

/**
 * The body's bytes, at most \`max\` of them: past that, \`too_large\`. The
 * rest is drained within the budget (the connection stays framed) or the
 * connection is closed once answered.
 */
export async function readBounded(
  request: Request,
  max: number,
): Promise<Uint8Array | "too_large"> {
  if (Number(request.headers.get("content-length") ?? 0) > max) {
    // The runtime skips a declared length by itself; nothing more is read.
    closeAfter(request);
    return "too_large";
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let read: Awaited<ReturnType<typeof reader.read>>;
    try {
      read = await reader.read();
    } catch {
      // The client went away mid-body: what arrived is all there is.
      closeAfter(request);
      break;
    }
    if (read.done) break;
    size += read.value.byteLength;
    if (size > max) {
      if (!(await drain(reader, DRAIN_MAX))) closeAfter(request);
      return "too_large";
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks);
}

/** A stream counted as it passes; past `max` it errors instead of yielding. */
export function counted(
  stream: ReadableStream<Uint8Array>,
  max: number,
  onExceeded: () => void,
): ReadableStream<Uint8Array> {
  let size = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > max) {
          onExceeded();
          controller.error(new Error("too_large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
