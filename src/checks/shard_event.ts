/**
 * A check's shard finishing, said on the outbox. The shard runner
 * (`scripts/test-shards.ts`) writes a line when a shard ends; this reads that
 * line and announces it as `run.shard`, so a pull's checks line, which listens
 * to `run.*`, patches itself instead of beating on a timer. One line, one
 * event: the live form ends at `done`, the batched form at its `(exit` header,
 * and neither line is the other's.
 */
import type { App } from "../app.ts";
import type { Run } from "../core/runs.ts";

const LIVE_DONE = /^── shard (\d+)\/(\d+) done \(exit \d+, [0-9.]+s\)$/;
const BATCHED = /^── shard (\d+)\/(\d+) \(exit \d+, [0-9.]+s\): /;

/** Which shard a log line says has finished, or nothing. */
export function finishedShard(line: string): { shard: number; of: number } | undefined {
  const m = LIVE_DONE.exec(line) ?? BATCHED.exec(line);
  return m === null ? undefined : { shard: Number(m[1]), of: Number(m[2]) };
}

/** Announce the shard `line` finishes, if it finishes one. */
export function announceShard(app: App, run: Run, line: string): void {
  const done = finishedShard(line);
  if (done === undefined) return;
  app.bus.append({
    kind: "run.shard",
    repoId: run.repoId,
    payload: {
      runId: run.id,
      kind: run.kind,
      env: run.env,
      commitOid: run.commitOid,
      shard: done.shard,
      of: done.of,
    },
  });
}
