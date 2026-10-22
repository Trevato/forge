/**
 * When a clone ends: on a lack of progress, not on a clock (#4482).
 *
 * A wall-clock kill is wrong both ways. It cuts off a large pack moving
 * steadily over a slow link, which is exactly the clone that most needs to
 * finish, and it lets a client that has stopped reading keep its transfer
 * permit until the clock runs out. So a fetch is judged by what it moved:
 * if fewer than `minBytes` went through in the last `windowMs`, it has
 * stalled and is ended. A generous absolute cap still bounds the worst case.
 *
 * One exception reads the stream, and only five bytes of it. While
 * pack-objects is still counting and compressing, upload-pack has no data
 * to send. Every `uploadpack.keepAlive` seconds it sends an empty side-band
 * packet (`0005\x01`) instead. That packet only reaches the meter once the
 * client has read what came before it, so it shows that git is working and
 * the client is reading. It counts as progress.
 */

/** What a fetch must move to count as moving. */
export interface Stall {
  /** The window progress is judged over. */
  readonly windowMs: number;
  /** Fewer bytes than this through the window, and the transfer has stalled. */
  readonly minBytes: number;
}

/** Fewer than 16 KiB in 30 s: stalled. */
export const STALL: Stall = { windowMs: 30_000, minBytes: 16 * 1024 };

/** However well it moves, a fetch ends after two hours. */
export const TRANSFER_CAP_MS = 2 * 60 * 60_000;

/** The window is kept in this many slices, so a stall is caught at most a sixth of a window late. */
const SLICES = 6;

/** Git's side-band keep-alive: an empty packet on band 1. */
const KEEPALIVE = [0x30, 0x30, 0x30, 0x35, 0x01];

export interface Progress {
  /** Bytes that moved, in either direction. */
  moved(bytes: number): void;
  /** Stop watching: the transfer ended. Idempotent. */
  stop(): void;
}

/**
 * Watch a transfer and call `kill` once it stalls, or once `capMs` has
 * passed. The first judgement is made a whole window after the start, so a
 * transfer gets a full window to begin.
 */
export function watchProgress(
  stall: Stall,
  capMs: number,
  kill: () => void,
): Progress {
  const slices: number[] = [];
  let current = 0;
  const tick = setInterval(
    () => {
      slices.push(current);
      current = 0;
      if (slices.length > SLICES) slices.shift();
      if (slices.length < SLICES) return;
      const moved = slices.reduce((sum, n) => sum + n, 0);
      if (moved < stall.minBytes) {
        stop();
        kill();
      }
    },
    Math.max(1, Math.floor(stall.windowMs / SLICES)),
  );
  const cap = setTimeout(() => {
    stop();
    kill();
  }, capMs);
  const stop = (): void => {
    clearInterval(tick);
    clearTimeout(cap);
  };
  return {
    moved(bytes) {
      current += bytes;
    },
    stop,
  };
}

/** A metered stream, and how to end it early. */
export interface Metered {
  readonly stream: ReadableStream<Uint8Array>;
  /**
   * End the stream now. What is still queued is dropped, the source is
   * cancelled, and the reader sees a clean end: a truncated pack, which git
   * reports as an early EOF.
   */
  cut(): void;
}

/** The most handed to the reader at once, so the count follows the reader. */
const PIECE = 64 * 1024;

/**
 * `stream`, counted as it is read. Bun reads a child's stdout as fast as
 * the child writes it, so one chunk can be most of a pack. Each chunk is
 * handed on in pieces, one per read, and a piece is counted when the
 * reader takes it. A keep-alive counts as a whole window's worth of bytes.
 */
export function metered(
  stream: ReadableStream<Uint8Array>,
  progress: Progress,
  stall: Stall,
): Metered {
  const reader = stream.getReader();
  let chunk = new Uint8Array(0);
  let offset = 0;
  let ended = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const end = (): void => {
    if (ended) return;
    ended = true;
    progress.stop();
    try {
      controller?.close();
    } catch {
      // Already closed.
    }
  };
  const out = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      async pull(c) {
        if (offset >= chunk.length) {
          const next = await reader.read();
          if (ended) return;
          if (next.done) return end();
          // A spawn pipe's chunk may be a view over a buffer Bun reuses,
          // and this one is held until the reader takes it: keep a copy.
          chunk = next.value.slice();
          offset = 0;
          if (isKeepAlive(chunk)) progress.moved(stall.minBytes);
        }
        const piece = chunk.subarray(offset, offset + PIECE);
        offset += piece.length;
        progress.moved(piece.length);
        c.enqueue(piece);
      },
      cancel(reason) {
        end();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream: out,
    cut: () => {
      end();
      void reader.cancel().catch(() => {});
    },
  };
}

/** How long a push may run before it is killed. */
export const PUSH_TIMEOUT_MS = 600_000;

export interface Deadline {
  /** The stream to answer with: git's stdout, metered for a fetch. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Bytes the client sent (counted only for a fetch). */
  moved(bytes: number): void;
  /**
   * Git exited. A push's clock stops. A fetch's keeps running until its
   * stream is read to the end: Bun reads a child's stdout as fast as the
   * child writes it, so git can exit with most of the pack still buffered
   * here, and sending that buffer is still the transfer.
   */
  exited(): void;
  /** The transfer is over, however it ended: stop every clock. Idempotent. */
  stop(): void;
}

/**
 * The deadline a pack transfer runs under, shared by smart HTTP and SSH.
 * A fetch ends when it stalls, or after `timeoutMs` (default two hours)
 * whatever it is doing. Ending it kills git and cuts the stream, which also
 * frees the buffer of a client that stopped reading. A push ends after
 * `timeoutMs` (default ten minutes): once its pack is in, index-pack and
 * the hooks run with nothing to send, and that quiet is not a stall.
 */
export function transferDeadline(
  fetch: boolean,
  stdout: ReadableStream<Uint8Array>,
  options: { timeoutMs?: number; stall?: Stall },
  kill: () => void,
): Deadline {
  if (fetch) {
    const stall = options.stall ?? STALL;
    let cut = (): void => {};
    const progress = watchProgress(
      stall,
      options.timeoutMs ?? TRANSFER_CAP_MS,
      () => {
        kill();
        cut();
      },
    );
    const meter = metered(stdout, progress, stall);
    cut = meter.cut;
    return {
      stdout: meter.stream,
      moved: progress.moved,
      exited: () => {},
      stop: progress.stop,
    };
  }
  const timer = setTimeout(kill, options.timeoutMs ?? PUSH_TIMEOUT_MS);
  const stop = (): void => clearTimeout(timer);
  return { stdout, moved: () => {}, exited: stop, stop };
}

function isKeepAlive(chunk: Uint8Array): boolean {
  if (chunk.length < KEEPALIVE.length) return false;
  return KEEPALIVE.every((byte, i) => chunk[i] === byte);
}
