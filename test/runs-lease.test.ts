/**
 * A run's lease: fresh while its process renews it, lapsed when nobody has
 * — and only a lapsed one is treated as abandoned. This is what lets a
 * release's new forge come up beside the old one without failing the work
 * the old one is still finishing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import {
  claimRun,
  createRun,
  failAbandonedRuns,
  getRun,
  heartbeatRuns,
  leaseLapsed,
} from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { holdLease, STALE_AFTER_MS } from "../src/runs/lease.ts";

describe("run leases", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-lease-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "r" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const olden = (runId: string, ageMs: number): void => {
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(runId, new Date(Date.now() - ageMs).toISOString());
  };

  test("claiming a run starts its lease; a held lease is renewed; only a lapsed one is abandoned", () => {
    const fresh = createRun(app.db, { repoId: repo.id, kind: "check" });
    const stale = createRun(app.db, { repoId: repo.id, kind: "check" });
    const queued = createRun(app.db, { repoId: repo.id, kind: "check" });
    expect(claimRun(app.db, fresh.id)?.heartbeatAt).not.toBeNull();
    claimRun(app.db, stale.id);
    olden(stale.id, STALE_AFTER_MS + 1_000);
    expect(leaseLapsed(getRun(app.db, fresh.id)!, STALE_AFTER_MS)).toBe(false);
    expect(leaseLapsed(getRun(app.db, stale.id)!, STALE_AFTER_MS)).toBe(true);

    expect(failAbandonedRuns(app.db, STALE_AFTER_MS)).toBe(1);
    expect(getRun(app.db, fresh.id)?.state).toBe("running");
    expect(getRun(app.db, stale.id)?.state).toBe("failed");
    expect(getRun(app.db, stale.id)?.summary).toContain("went away");
    // A queued run has no lease to lapse.
    expect(getRun(app.db, queued.id)?.state).toBe("queued");

    // Holding renews at once, and renewing an old lease makes it fresh again.
    olden(fresh.id, STALE_AFTER_MS + 1_000);
    const release = holdLease(app.db, fresh.id);
    expect(leaseLapsed(getRun(app.db, fresh.id)!, STALE_AFTER_MS)).toBe(false);
    release();
    olden(fresh.id, STALE_AFTER_MS + 1_000);
    heartbeatRuns(app.db, [fresh.id]);
    expect(leaseLapsed(getRun(app.db, fresh.id)!, STALE_AFTER_MS)).toBe(false);
    // A finished run is not renewed: the lease is for running work only.
    app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(fresh.id);
    olden(fresh.id, STALE_AFTER_MS + 1_000);
    heartbeatRuns(app.db, [fresh.id]);
    expect(leaseLapsed(getRun(app.db, fresh.id)!, STALE_AFTER_MS)).toBe(true);
  });
});
