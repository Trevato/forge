/**
 * Server-sent events: a live tail of the event bus for one repository. The
 * outbox is already the source of truth; this just fans durable events out to
 * connected browsers so the UI can update as things happen — the "transparent
 * frontend". Access is checked by the caller before the stream opens; every
 * event streamed here is for a repo the viewer can already read.
 */

import type { App } from "../app.ts";
import type { ForgeEvent } from "../core/events.ts";

const HEARTBEAT_MS = 25_000;

function frame(event: ForgeEvent): string {
  // The event id doubles as the SSE id, so a reconnecting client can resume.
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function sseStream(
  app: App,
  repoId: string,
  request: Request,
): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const safeEnqueue = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      const unsubscribe = app.bus.subscribe((event) => {
        if (event.repoId === repoId) safeEnqueue(frame(event));
      });
      const heartbeat = setInterval(
        () => safeEnqueue(`: ping\n\n`),
        HEARTBEAT_MS,
      );

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
      safeEnqueue(`: connected\n\n`);
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
