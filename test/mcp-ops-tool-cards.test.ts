/** restore_drill, reports and usage, called through `tools/call`, carry the card: the tool's `card` extras are what give it its When row and its links. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { fileReport } from "../src/actions/reports.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let svc: SnapshotsHandle;
let token: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ops-tool-cards-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const alice = getUserByName(app.db, "alice")!;
  token = createToken(app.db, alice.id, "admin", "admin").token;
  svc = startSnapshots(app, dirStore(join(dataDir, "store")), {
    version: "t",
    nightly: false,
    drill: async (): Promise<DrillResult> => ({
      at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      snapshotId: "snap-1",
      ms: 5,
      counts: { repositories: 1, issues: 0, users: 1, pulls: 0, apps: 0 },
      health: "unreached",
      verdict: "red",
      failedStep: "unseal",
      phases: [],
      budgetMs: 0,
      reason: "a sealed value does not open",
    }),
  });
  servers = await serve(app);
  const repo = await createRepo(app, alice, { name: "engine", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const [i, title] of ["First", "Second"].entries()) {
    const filed = fileReport(app, repo.value, { title, body: "", page: "" }, `src-${i}`);
    if (!filed.ok) throw new Error(JSON.stringify(filed.error));
  }
});

afterAll(async () => {
  servers.stop();
  await svc.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return ((await res.json()) as any).result;
};

test("restore_drill: the card has the verdict, the failed step and the When row", async () => {
  const r = await call("restore_drill", {});
  expect(r.structuredContent.card.title).toBe("Restore drill");
  expect(r.structuredContent.card.rows).toEqual([
    { label: "Verdict", value: "red" },
    { label: "Failed step", value: "unseal" },
    { label: "When", value: "3h ago" },
  ]);
});

test("reports: each row links to the repo's reports page", async () => {
  const r = await call("reports", { repo: "alice/engine" });
  const rows = r.structuredContent.card.rows;
  expect(rows.length).toBe(2);
  for (const row of rows) expect(row.link).toBe(`${servers.url}/alice/engine/reports`);
});

test("usage: a card for the repo answer and for the forge answer", async () => {
  const repo = await call("usage", { repo: "alice/engine" });
  expect(repo.structuredContent.card.title).toBe("Spend");
  expect(repo.structuredContent.card.rows[0].label).toBe("Total");
  const forge = await call("usage", {});
  expect(forge.structuredContent.card.title).toBe("Spend");
  expect(forge.structuredContent.card.rows.map((x: any) => x.label).slice(0, 2)).toEqual(["Today", "Last 24 hours"]);
});
