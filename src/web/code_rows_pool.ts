/**
 * Cold code pages highlight and lay out their rows on worker threads, so the
 * main loop keeps serving while a crawl asks for pages nobody has kept (#9630).
 * `poolSize()` workers (two; `FORGE_CODE_ROWS_WORKERS` sets a number or `auto`),
 * started on first use; a job that fails or runs past `JOB_MS` answers
 * undefined and the caller does the work inline.
 */
import { availableParallelism } from "node:os";
import type { Encoding } from "../http/compress.ts";
import type { CodeRows } from "./code_rows.ts";
import type { Gcode } from "./render/gcode.ts";
import type { Job } from "./code_rows_worker.ts";

/** The floor: one worker busy on a long file must not stall every cold page. */
const MIN_WORKERS = 2;
/**
 * The cap: each worker is its own JS heap, about 8 MB idle (measured, #9671)
 * and more while it holds a page's bytes to encode. Eight bounds that near
 * 100 MB on any machine and leaves cores for git, which a cold page also waits on.
 */
const MAX_WORKERS = 8;

/**
 * The default, kept at the floor: sizing from the machine (8 here, on 80 cores)
 * did not cut a cold 500/s crawl's refusals beyond noise, and served/s still
 * levelled near 400 (bench/results/cold-forge-500.md, "After the pool", #9671).
 */
const DEFAULT_WORKERS = MIN_WORKERS;

/** The machine's share: its available parallelism clamped to [MIN_WORKERS, MAX_WORKERS]. */
export const machineWorkers = (cores: number = availableParallelism()): number =>
  Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, Math.floor(cores)));

/**
 * Workers in the pool, read like the git pool's `FORGE_GIT_CONCURRENCY`:
 * `FORGE_CODE_ROWS_WORKERS` as a positive number (floored, capped at
 * MAX_WORKERS), or `auto` for `machineWorkers()`; unset or anything else is
 * DEFAULT_WORKERS.
 */
export function poolSize(
  override: string | undefined = process.env.FORGE_CODE_ROWS_WORKERS,
  cores: number = availableParallelism(),
): number {
  const text = override?.trim() ?? "";
  if (text === "auto") return machineWorkers(cores);
  const asked = Number(text);
  if (text !== "" && Number.isFinite(asked) && asked >= 1) return Math.min(MAX_WORKERS, Math.floor(asked));
  return DEFAULT_WORKERS;
}

const WORKERS = poolSize();
const JOB_MS = 5_000;
/** A 50 MB sliced file takes longer than a page of code. */
const GCODE_JOB_MS = 30_000;
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

function run<T>(job: Spec, ms: number = JOB_MS): Promise<T | undefined> {
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
    }, ms);
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

/** A G-code file parsed on a worker (up to `GCODE_JOB_MS`): a parse, null for none, undefined when the caller should not wait. */
export const gcodeOffThread = async (body: Uint8Array): Promise<{ parsed: Gcode | null } | undefined> =>
  run<{ parsed: Gcode | null }>({ kind: "gcode", body }, GCODE_JOB_MS);
