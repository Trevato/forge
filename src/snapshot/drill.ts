/**
 * The restore drill: a backup nobody has restored is a hope. `runDrill`
 * takes the newest snapshot, restores it into a fresh directory, opens the
 * database read-only, counts what is in it, opens one sealed value with the
 * restored key, and removes the directory whatever happened.
 *
 * Plain data out: when it ran, which snapshot, how long, what it counted,
 * and a verdict. A red verdict names the step that failed; a step that
 * hangs past the timeout is red too, naming the step it hung in.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { forgetKey, open } from "../kernel/secret.ts";
import { restoreSnapshot } from "./restore.ts";
import { listSnapshots } from "./snapshot.ts";
import type { Store } from "./store.ts";

export const DRILL_TIMEOUT_MS = 10 * 60_000;

export type DrillStep = "fetch" | "restore" | "open" | "count" | "unseal";

export interface DrillDeps {
  readonly store: Store;
  /** The forge's data directory; the drill's scratch lives under it. */
  readonly dataDir: string;
  readonly passphrase?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Test seam: the restore itself. */
  readonly restore?: typeof restoreSnapshot | undefined;
}

export interface DrillResult {
  readonly at: string;
  readonly snapshotId: string | null;
  readonly ms: number;
  readonly counts: { readonly repositories: number; readonly issues: number };
  readonly verdict: "green" | "red";
  readonly failedStep: DrillStep | null;
  /** Why it is red, for the person reading; never a value. */
  readonly reason: string | null;
}

class StepTimeout extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function runDrill(deps: DrillDeps): Promise<DrillResult> {
  const clock = deps.now ?? (() => new Date());
  const started = performance.now();
  const at = clock().toISOString();
  const timeoutMs = deps.timeoutMs ?? DRILL_TIMEOUT_MS;
  const restore = deps.restore ?? restoreSnapshot;
  const counts = { repositories: 0, issues: 0 };
  let snapshotId: string | null = null;
  let step: DrillStep = "fetch";
  let scratch: string | undefined;
  let reason: string | null = null;
  try {
    // One clock for the whole drill, so a hang in any step ends it red.
    const deadline = started + timeoutMs;
    const left = (): number => Math.max(1, deadline - performance.now());
    const newest = (await within(listSnapshots(deps.store), left()))[0];
    if (newest === undefined) throw new Error("the store holds no snapshot");
    snapshotId = newest.name;

    step = "restore";
    const parent = join(deps.dataDir, "drill");
    mkdirSync(parent, { recursive: true });
    scratch = mkdtempSync(join(parent, "restore-"));
    const target = join(scratch, "data");
    await within(
      restore(deps.store, newest.name, target, { passphrase: deps.passphrase }),
      left(),
    );

    step = "open";
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(target, "forge.db"), { readonly: true });
    try {
      // The constructor is lazy; reading the header is what proves a database.
      db.query("PRAGMA schema_version").get();
      step = "count";
      const n = (sql: string): number =>
        db.query<{ n: number }, []>(sql).get()?.n ?? 0;
      counts.repositories = n("SELECT count(*) AS n FROM repo");
      counts.issues = n("SELECT count(*) AS n FROM issue");

      step = "unseal";
      const secret = db
        .query<{ name: string; scope: string; value_enc: string }, []>(
          "SELECT name, scope, value_enc FROM secret ORDER BY scope, name LIMIT 1",
        )
        .get();
      const env = secret
        ? undefined
        : db
            .query<{ app_id: string; name: string; value_enc: string }, []>(
              "SELECT app_id, name, value_enc FROM app_env ORDER BY app_id, name LIMIT 1",
            )
            .get();
      // A forge with nothing sealed has nothing to open; that is not red.
      const sealed = secret
        ? { value: secret.value_enc, aad: `secret:${secret.scope}:${secret.name}` }
        : env
          ? { value: env.value_enc, aad: `${env.app_id}:${env.name}` }
          : undefined;
      if (sealed !== undefined) {
        const opened = open(target, sealed.value, sealed.aad);
        if (!opened.ok)
          throw new Error(
            "a sealed value does not open with the restored key",
          );
      }
    } finally {
      db.close();
    }
  } catch (error) {
    reason =
      error instanceof StepTimeout
        ? `${step} timed out: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return finish(step);
  } finally {
    if (scratch !== undefined) {
      forgetKey(join(scratch, "data"));
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return finish(null);

  function finish(failedStep: DrillStep | null): DrillResult {
    return {
      at,
      snapshotId,
      ms: Math.round(performance.now() - started),
      counts,
      verdict: failedStep === null ? "green" : "red",
      failedStep,
      reason,
    };
  }
}
