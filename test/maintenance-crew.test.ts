/** While the forge is in maintenance the real dispatcher starts nothing and says why. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { serve } from "../src/http/server.ts";
import { writeState } from "../src/maintenance/state.ts";
import { heldRuns } from "../src/runs/held.ts";

let dataDir: string;
let app: App;
let repoId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-maint-crew-"));
  app = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 100, totalBytes: 100 }) });
  const owner = await createUser(app.db, { origin: "seed", trusted: true, username: "holder", email: "h@forge.local", password: "a-good-passphrase" });
  if (!owner.ok) throw new Error(String(owner.error));
  repoId = crypto.randomUUID();
  app.db.query("INSERT INTO repo (id, owner_id, name, visibility, created_at) VALUES (?1, ?2, 'm', 'private', ?3)").run(repoId, owner.value.id, new Date().toISOString());
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("queued runs stay queued, held by maintenance", async () => {
  writeState(dataDir, { current: { since: new Date().toISOString(), by: "a", reason: "", holdId: 1, backup: { ok: true, says: "x" } } });
  const run = createRun(app.db, { repoId, kind: "agent" });
  const servers = await serve(app);
  const fake = join(dataDir, "fake-claude");
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nexit 1\n`);
  chmodSync(fake, 0o755);
  const crew = await startCrew(app, { forgeUrl: servers.url, localUrl: servers.url, binary: fake, concurrency: 2, budgetUsd: 1, runTimeoutMs: 60_000, tickMs: 20 });
  try {
    const deadline = Date.now() + 10_000;
    while (heldRuns(app.db).get(run.id) !== "maintenance" && Date.now() < deadline) await Bun.sleep(20);
    expect(heldRuns(app.db).get(run.id)).toBe("maintenance");
    expect(getRun(app.db, run.id)?.state).toBe("queued");
  } finally {
    await crew.stop();
    servers.stop();
  }
});
