/**
 * A pipe that is read only when someone asks. Bun drains a child's stdout as
 * fast as the child writes it, whether or not anything reads the stream, so a
 * `stdout: "pipe"` holds a whole pack in the forge's memory and lets git exit
 * long before the client has it. A FIFO read one bounded chunk per pull is
 * pulled instead: git blocks on a full pipe (64 KiB) while the client is
 * behind, and the forge holds a chunk at a time.
 *
 * The FIFO is made in the temp directory and unlinked at once; only the two
 * descriptors name it afterwards. `mkfifo` takes no user text.
 */

import {
  closeSync,
  constants,
  openSync,
  read as readFd_,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PullPipe {
  /** Hand to `Bun.spawn` as `stdout`; call `sealed()` once it has spawned. */
  writeFd: number;
  /** The parent's copy of the write end goes: EOF then follows git's exit. */
  sealed(): void;
  /** Chunks as they are asked for; ends at git's exit, closes the pipe. */
  stream: ReadableStream<Uint8Array>;
  /** Close both ends (a spawn that failed, a stream nobody will read). */
  close(): void;
}

let serial = 0;

/** What one pull reads. */
const CHUNK = 64 * 1024;

/**
 * `onCancel` runs when the reader gives up: git's end is a read-write
 * descriptor (so the open does not wait), which means no SIGPIPE ever tells
 * it nobody is listening — the caller stops it.
 */
export async function pullPipe(
  onCancel: () => void = () => undefined,
): Promise<PullPipe> {
  const path = fifoPath();
  const made = Bun.spawn(["mkfifo", "-m", "600", path], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await made.exited) !== 0) throw new Error("mkfifo failed");
  return openPipe(path, onCancel);
}

/**
 * The same, made synchronously: for a caller that must wire its handlers in
 * the tick it is called (the SSH channel delivers data as soon as it exists).
 */
export function pullPipeSync(onCancel: () => void = () => undefined): PullPipe {
  const path = fifoPath();
  const made = Bun.spawnSync(["mkfifo", "-m", "600", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (made.exitCode !== 0) throw new Error("mkfifo failed");
  return openPipe(path, onCancel);
}

function fifoPath(): string {
  return join(
    tmpdir(),
    `forge-pipe-${process.pid}-${Date.now().toString(36)}-${serial++}`,
  );
}

function openPipe(path: string, onCancel: () => void): PullPipe {
  let writeFd = -1;
  let readFd = -1;
  try {
    // O_RDWR opens without waiting for a reader; the read end is
    // non-blocking, so a read never parks a thread on a quiet git.
    writeFd = openSync(path, constants.O_RDWR);
    readFd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (writeFd >= 0) closeSync(writeFd);
    throw error;
  } finally {
    unlinkSync(path);
  }

  let writeOpen = true;
  let readOpen = true;
  let reading = false;
  const sealed = (): void => {
    if (!writeOpen) return;
    writeOpen = false;
    closeSync(writeFd);
  };
  const close = (): void => {
    sealed();
    // A read in flight holds the descriptor; it closes it when it lands.
    if (!readOpen || reading) {
      readOpen = false;
      return;
    }
    readOpen = false;
    closeSync(readFd);
  };

  /**
   * One bounded read, never ahead of the caller: `Bun.file(fd).stream()` and
   * `proc.stdout` both read as fast as the writer fills the pipe. The
   * descriptor is non-blocking, so no thread waits on git; "nothing yet"
   * (EAGAIN) is retried on a growing timer, capped at 100 ms.
   */
  const readChunk = async (): Promise<Uint8Array | null> => {
    reading = true;
    try {
      // One buffer per call, not per retry: a quiet git is polled for as
      // long as it stays quiet, and allocating each time costs a core's worth.
      const buffer = Buffer.allocUnsafe(CHUNK);
      for (let wait = 2; readOpen; wait = Math.min(wait * 2, 100)) {
        const n = await new Promise<number | "again">((done, fail) =>
          readFd_(readFd, buffer, (error, count) =>
            error === null
              ? done(count)
              : error.code === "EAGAIN"
                ? done("again")
                : fail(error),
          ),
        );
        if (n === "again") await Bun.sleep(wait);
        else return n === 0 ? null : buffer.subarray(0, n);
      }
      return null;
    } finally {
      reading = false;
      if (!readOpen) {
        try {
          closeSync(readFd);
        } catch {
          /* closed already */
        }
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await readChunk();
          if (chunk === null) {
            close();
            controller.close();
          } else controller.enqueue(chunk);
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        onCancel();
        close();
      },
    },
    { highWaterMark: 0 },
  );
  return { writeFd, sealed, stream, close };
}
