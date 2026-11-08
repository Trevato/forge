/**
 * A real spawn, end to end (#7959), as `test/spawn-cell-e2e.test.ts` drives
 * it. Its own process, for the reason `real-child-forge.ts` is: a check sets
 * `FORGE_CELLS=off` for the forges its tests boot.
 *
 * A parent with the real server makes a child forge in a real cell from one
 * app, then asks `<app>--<child>--<parent>` through that server until the
 * app's own body comes back. Nothing is faked: not the cell, not the child's
 * runtime, not the route. Printed: one JSON line of what was seen.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../../src/actions/repos.ts";
import { spawnForge } from "../../src/actions/spawn.ts";
import { createApp } from "../../src/app.ts";
import { cellsAvailable } from "../../src/apps/contain.ts";
import { createUser } from "../../src/core/users.ts";
import { repoDir } from "../../src/git/repos.ts";
import { commitFiles } from "../../src/git/write.ts";
import { serve } from "../../src/http/server.ts";
import { cellPlacement, stopCellChildren } from "../../src/spawn/cell.ts";
import { bootHostedChild } from "../../src/spawn/host.ts";
import { memoryBodies } from "../../src/spawn/placement.ts";

const cells = await cellsAvailable();
if (!cells.ok) {
  console.log(JSON.stringify({ skipped: cells.reason }));
  process.exit(0);
}

const BODY = "bakery says hi";
const dataDir = mkdtempSync(join(tmpdir(), "real-spawn-"));
mkdirSync(dataDir, { recursive: true });
const parent = createApp({ dataDir, url: "https://forge.test", port: 0 });
const servers = await serve(parent);
try {
  const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
  if (!alice.ok) throw new Error("user");
  const repo = await createRepo(parent, alice.value, { name: "bakery", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const committed = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
    branch: "main",
    message: "bakery",
    files: [
      { path: "forge.json", content: JSON.stringify({ app: { run: "bun run index.ts", health: "/" } }) },
      { path: "index.ts", content: `Bun.serve({ port: Number(process.env.PORT), fetch() { return new Response(${JSON.stringify(BODY)}) } })\n` },
    ],
    author: { name: "a", email: "a@x.invalid" },
  });
  if (!committed.ok) throw new Error("commit");
  const made = await spawnForge(
    parent,
    alice.value,
    { name: "kid", org: "kids", apps: ["alice/bakery"], carryBriefs: false, carrySubscriptions: false },
    { catalog: [{ ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 }], briefs: [], subscriptions: [] },
    {
      placement: cellPlacement(parent, memoryBodies(), () => 10),
      request: new Request("https://forge.test/x", { method: "POST", headers: { origin: "https://forge.test" } }),
      url: new URL("https://forge.test/x"),
    },
  );
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  await bootHostedChild(parent, "kid");
  let status = 0;
  let body = "";
  let app: string | null = null;
  const until = Date.now() + 150_000;
  while (Date.now() < until) {
    const res = await fetch(`${servers.url}/`, { headers: { host: "bakery--kid--forge.test" }, redirect: "manual" }).catch(() => undefined);
    if (res !== undefined) {
      status = res.status;
      body = await res.text();
      app = res.headers.get("x-forge-app");
      if (status === 200 && app === "bakery") break;
    }
    await Bun.sleep(1000);
  }
  console.log(JSON.stringify({ placement: made.value.placement, status, body: body.slice(0, 200), app }));
} finally {
  servers.stop();
  await stopCellChildren(parent);
  parent.close();
  rmSync(dataDir, { recursive: true, force: true });
}
