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

import { holdForCaller } from "./caller.ts";
import { isSignedIn } from "./limits.ts";
import { holdStream, tooManyStrangers } from "./strangers.ts";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { listEvents, listEventsVisibleTo } from "../core/events.ts";
import { audienceFilter, eventForReader } from "../core/event_audience.ts";
import { canRead, getRepoById } from "../core/repos.ts";
import { mayReadLogOfRun } from "../actions/runs.ts";
import { getRun } from "../core/runs.ts";
import { frameOf, tapRunLogs } from "../runs/log.ts";
import type { ForgeEvent } from "../core/events.ts";

const HEARTBEAT_MS = 25_000;

/**
 * How much unread stream a client may be behind before it is dropped.
 *
 * An SSE connection whose reader has stopped reading — a laptop that slept, a
 * tab the OS froze, a scraper that opened the stream and walked away — does
 * not error. It simply never drains, and every event the forge appends is
 * another buffer held alive by a controller nobody is pulling from. With a
 * fleet of agents pushing events that is a memory leak with a heartbeat.
 *
 * So the buffer is a budget. A quarter-megabyte is thousands of events, far
 * more than any live viewer is ever behind; a client past it is not slow, it
 * is gone, and dropping it is both correct and kind. Nothing is lost by the
 * drop: the outbox is the source of truth and a reconnect resumes from the
 * last id it saw.
 */
const MAX_BUFFERED_BYTES = 256 * 1024;

/**
 * How many streams have been dropped for falling too far behind. Exported so
 * the behaviour can be asserted rather than assumed — a backpressure policy
 * nobody can observe is a comment.
 */
let slowClientsDropped = 0;
export const sseDroppedCount = (): number => slowClientsDropped;
/** Test seam. */
export const resetSseDroppedCount = (): void => {
  slowClientsDropped = 0;
};

/**
 * Every stream open in this process, by the way to end it for a drain. A
 * process that is going away (a roll) ends each with a resume hint — reconnect
 * in a second, from the last id you saw — rather than letting the socket
 * drop: the browser's EventSource reconnects, and lands on the process that
 * replaced this one (docs/ARCHITECTURE.md, "Two processes at once").
 */
const openStreams = new Set<() => void>();

/** How soon a drained stream's client reconnects, in milliseconds. */
export const DRAIN_RETRY_MS = 1000;

/** End every open stream with a resume hint; how many there were. */
export function drainStreams(): number {
  const ending = [...openStreams];
  for (const end of ending) end();
  return ending.length;
}

/** Send one frame. `id` lets a reconnecting client resume where it left off. */
export type Emit = (event: string, data: unknown, id?: string) => void;

/**
 * Open a stream. `register` is called once with the emitter and a `close`;
 * it returns its own unsubscribe, which runs when the client goes away, when
 * `close` is called, or when a write fails — whichever happens first.
 *
 * Every stream is counted on `app` while it is open (`strangers.ts`): a
 * stranger's against its address and every stranger's together, anyone's
 * against the forge's whole budget. Past either, the answer is a 429 and
 * nothing is registered.
 */
export function eventStream(
  app: App,
  request: Request,
  register: (emit: Emit, close: () => void, ready: () => boolean) => () => void,
): Response {
  const held = holdStream(app, request, !isSignedIn(request));
  if (!held.allowed) return tooManyStrangers(held);
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let open = true;
        const write = (text: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
            return;
          }
          // `desiredSize` is the budget minus what is still queued, so it
          // goes negative exactly when a reader has stopped keeping up. One
          // check after the write, no bookkeeping of our own, and the client
          // is released the moment it stops being one.
          const room = controller.desiredSize;
          if (room !== null && room <= 0) {
            slowClientsDropped++;
            cleanup();
          }
        };

        const emit: Emit = (event, data, id) => {
          write(
            `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          );
        };

        // A source of samples (the latest wins, older ones are worthless)
        // skips a frame while the reader is behind instead of queueing it.
        const ready = () => open && (controller.desiredSize ?? 0) > MAX_BUFFERED_BYTES / 2;

        const heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
        // Assigned before `register` runs: a source that finishes immediately
        // (a job that is already done) must find a cleanup that works.
        let unsubscribe = () => {};
        // An account suspended or removed ends its open streams then.
        let release = () => {};
        cleanup = () => {
          if (!open) return;
          open = false;
          held.release();
          release();
          unsubscribe();
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        const drain = () => {
          write(`retry: ${DRAIN_RETRY_MS}\nevent: drain\ndata: {}\n\n`);
          cleanup();
        };
        openStreams.add(drain);
        const closeOnce = cleanup;
        cleanup = () => {
          openStreams.delete(drain);
          closeOnce();
        };
        request.signal.addEventListener("abort", cleanup);
        release = holdForCaller(request, () => cleanup());
        write(`: connected\n\n`);
        unsubscribe = register(emit, () => cleanup(), ready);
        // A registration that closed the stream synchronously leaves an
        // unsubscribe nobody has run yet.
        if (!open) unsubscribe();
      },
      cancel() {
        cleanup();
      },
    },
    // Byte-counted, not chunk-counted. The default strategy counts one per
    // enqueue with a high-water mark of one, which would call every stream
    // that is two frames ahead of its reader "full" — the budget has to be
    // in the unit the leak is measured in.
    new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED_BYTES }),
  );

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

/**
 * Everything one viewer may see, as it happens: every event on every
 * repository they can read, replayed from `Last-Event-ID` first so a
 * browser that reconnects misses nothing. Visibility is decided once per
 * repository per connection; a repository whose visibility changes is
 * seen on the next connection.
 */
export function viewerStream(
  app: App,
  viewer: User | undefined,
  request: Request,
): Response {
  const seen = new Map<string, boolean>();
  const visible = (repoId: string): boolean => {
    const known = seen.get(repoId);
    if (known !== undefined) return known;
    const repo = getRepoById(app.db, repoId);
    const ok = repo !== undefined && canRead(app.db, repo, viewer);
    seen.set(repoId, ok);
    return ok;
  };
  // Readable is not the same as meant-for: configuration events are the
  // admins', a person's own choices are theirs (`core/event_audience.ts`).
  const meant = audienceFilter(app.db, viewer);
  const redact = eventForReader(app.db, viewer);
  const named = (raw: ForgeEvent): Record<string, unknown> => {
    const event = redact(raw);
    const repo =
      event.repoId === null ? undefined : getRepoById(app.db, event.repoId);
    return {
      id: event.id,
      kind: event.kind,
      repo: repo === undefined ? null : `${repo.ownerName}/${repo.name}`,
      payload: event.payload,
      at: event.createdAt,
    };
  };
  const after = resumeFrom(request);
  return eventStream(app, request, (emit, _close, ready) => {
    // Subscribed before the replay is read, so no event falls between them; an
    // event both hold is sent once, in the replay.
    const replayed = new Set<string>();
    const send = (event: ForgeEvent, live = true): void => {
      if (live ? replayed.delete(event.id) : (replayed.add(event.id), false)) return;
      emit("forge", named(event), event.id);
    };
    // New log lines of a run whose log the viewer may read (`mayReadRunLog`). Not
    // history: no id, never replayed — a late tab reads the log file.
    const gone = new AbortController();
    // The verdict is decided once per run per connection, like repository
    // visibility: someone removed from the crew keeps this run's lines until
    // they reconnect.
    const verdicts = new Map<string, boolean>();
    tapRunLogs((runId, lines) => {
      let may = verdicts.get(runId);
      if (may === undefined) {
        const run = getRun(app.db, runId);
        const repo = run && getRepoById(app.db, run.repoId);
        may = repo !== undefined && mayReadLogOfRun(app, viewer, repo, runId);
        // Bounded: a tab left open sees many runs go by.
        if (verdicts.size >= 256) verdicts.clear();
        verdicts.set(runId, may);
      }
      // Lossy by design: a reader that is behind skips the frame rather than
      // spend the byte budget the durable `forge` frames need to stay open.
      if (!may || !ready()) return;
      emit("run.log", { run: runId, ...frameOf(lines) });
    }, gone.signal);
    const unsubscribe = app.bus.subscribe((event: ForgeEvent) => {
      if (event.repoId === null ? !event.kind.startsWith("backup.") : !visible(event.repoId)) return;
      if (!meant(event)) return;
      send(event);
    }, "ordered");
    if (after !== undefined) {
      const missed = listEventsVisibleTo(app.db, viewer, {
        afterId: after,
        limit: 200,
      }).reverse();
      for (const event of missed)
        if (meant(event)) send(event, false);
    }
    return () => {
      gone.abort();
      unsubscribe();
    };
  });
}

export function sseStream(
  app: App,
  repoId: string,
  request: Request,
  viewer: User | undefined,
): Response {
  const meant = audienceFilter(app.db, viewer);
  const redact = eventForReader(app.db, viewer);
  const after = resumeFrom(request);
  return eventStream(app, request, (emit) => {
    // The event id doubles as the SSE id, so a reconnecting client resumes
    // from where it stopped: what it missed first, oldest first, then live.
    // Subscribed first, and an event both hold is sent once (see `viewerStream`).
    const replayed = new Set<string>();
    const send = (event: ForgeEvent, live = true): void => {
      if (live ? replayed.delete(event.id) : (replayed.add(event.id), false)) return;
      emit(event.kind, redact(event), event.id);
    };
    const unsubscribe = app.bus.subscribe((event: ForgeEvent) => {
      if (event.repoId === repoId && meant(event)) send(event);
    }, "ordered");
    if (after !== undefined)
      for (const event of listEvents(app.db, {
        repoId,
        afterId: after,
        limit: 200,
      }).reverse())
        if (meant(event)) send(event, false);
    return unsubscribe;
  });
}

/** Where a reconnecting client asks to resume: the last event it heard. */
function resumeFrom(request: Request): string | undefined {
  const after =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("since") ??
    "";
  return after === "" ? undefined : after;
}
