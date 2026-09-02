/**
 * Server-sent events: a live tail of something the browser wants to watch.
 *
 * `sseStream` is the original one — the event bus for one repository. The
 * outbox is already the source of truth; this just fans durable events out
 * to connected browsers so the UI can update as things happen (the
 * "transparent frontend"). Access is checked by the caller before the stream
 * opens; every event streamed here is for a repo the viewer can already read.
 *
 * `eventStream` underneath it is the same machinery with the source left
 * open, because a mirror job wants exactly this and is not an event at all:
 * one subscription, a heartbeat, one cleanup path however the connection
 * ends, and no way for a late enqueue on a closed controller to throw into a
 * timer.
 */

import type { App } from "../app.ts";
import type { ForgeEvent } from "../core/events.ts";

const HEARTBEAT_MS = 25_000;

/** Send one frame. `id` lets a reconnecting client resume where it left off. */
export type Emit = (event: string, data: unknown, id?: string) => void;

/**
 * Open a stream. `register` is called once with the emitter and a `close`;
 * it returns its own unsubscribe, which runs when the client goes away, when
 * `close` is called, or when a write fails — whichever happens first.
 */
export function eventStream(
  request: Request,
  register: (emit: Emit, close: () => void) => () => void,
): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      const emit: Emit = (event, data, id) => {
        write(
          `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };

      const heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
      // Assigned before `register` runs: a source that finishes immediately
      // (a job that is already done) must find a cleanup that works.
      let unsubscribe = () => {};
      cleanup = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", cleanup);
      write(`: connected\n\n`);
      unsubscribe = register(emit, () => cleanup());
      // A registration that closed the stream synchronously leaves an
      // unsubscribe nobody has run yet.
      if (!open) unsubscribe();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell nginx-style proxies not to buffer the stream.
      "x-accel-buffering": "no",
    },
  });
}

export function sseStream(
  app: App,
  repoId: string,
  request: Request,
): Response {
  return eventStream(request, (emit) =>
    app.bus.subscribe((event: ForgeEvent) => {
      // The event id doubles as the SSE id, so a reconnecting client can
      // resume from where it stopped.
      if (event.repoId === repoId) emit(event.kind, event, event.id);
    }),
  );
}
