/**
 * Cold code pages highlight and lay out their rows on worker threads, so the
 * main loop keeps serving while a crawl asks for pages nobody has kept (#9630).
 * Two workers, started on first use; a job that fails or runs past
 * `JOB_MS` answers undefined and the caller does the work inline.
 */
import type { Encoding } from "../http/compress.ts";
import type { CodeRows } from "./code_rows.ts";
import type { Job } from "./code_rows_worker.ts";

const WORKERS = 2;
const JOB_MS = 5_000;
/** Jobs in flight past which the caller renders inline instead of queueing. */
const MAX_PENDING = 64;

type Reply = { id: number; result?: unknown; error?: string };

const pool: Worker[] = [];
const waiting = new Map<number, { worker: Worker; done: (result: unknown) => void }>();
let next = 0;

function start(): Worker | undefined {
  try {
    const w = new Worker(new URL("./code_rows_worker.ts", import.meta.url).href);
    w.onmessage = (e: MessageEvent<Reply>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      job?.done(e.data.result);
    };
    w.onerror = () => {
      const at = pool.indexOf(w);
      if (at >= 0) pool.splice(at, 1);
      w.terminate();
      // Its in-flight jobs will never answer: let their callers fall back now, not after JOB_MS.
      for (const [id, job] of waiting) {
        if (job.worker !== w) continue;
        waiting.delete(id);
        job.done(undefined);
      }
    };
    w.unref();
    return w;
  } catch {
    return undefined;
  }
}

type Spec = Job extends infer J ? (J extends Job ? Omit<J, "id"> : never) : never;

function run<T>(job: Spec): Promise<T | undefined> {
  if (waiting.size >= MAX_PENDING) return Promise.resolve(undefined);
  if (pool.length < WORKERS) {
    const w = start();
    if (w) pool.push(w);
  }
  const worker = pool[next++ % Math.max(pool.length, 1)];
  if (!worker) return Promise.resolve(undefined);
  const id = next;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(undefined);
    }, JOB_MS);
    waiting.set(id, {
      worker,
      done: (result) => {
        clearTimeout(timer);
        resolve(result as T | undefined);
      },
    });
    worker.postMessage({ ...job, id });
  });
}

/** Rows for a file's bytes, or undefined when the caller should build them itself. */
export const rowsOffThread = (body: Uint8Array, path: string, limit: number): Promise<CodeRows | undefined> =>
  run<CodeRows>({ kind: "rows", body, path, limit });

/** A finished page's bytes encoded, or undefined when the caller should encode them itself. */
export const encodeOffThread = (body: Uint8Array<ArrayBuffer>, encoding: Encoding): Promise<Uint8Array | undefined> =>
  run<Uint8Array>({ kind: "encode", body, encoding });

/** Test seam: the live workers. */
export const workersForTest = (): readonly Worker[] => pool;
