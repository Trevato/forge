/** A run stores the provider's measure against the subscription it ran on, or `platform` (#8960). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { measureFor } from "../src/core/measure.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { addSubscription, PLATFORM, setGrants } from "../src/core/subscriptions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let crew: CrewHandle;
let alice: User;
let bot: User;
let repo: Repo;

async function runOnce(title: string): Promise<void> {
  const issue = openIssue(app, alice, repo, { title, body: "x" });
  if (!issue.ok) throw new Error(String(issue.error));
  expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = listRuns(app.db, repo.id, { kind: "agent" }).find((r) => r.issueId === issue.value.id);
    if (run && ["ok", "failed", "cancelled"].includes(run.state)) return;
    await Bun.sleep(100);
  }
  throw new Error("agent run did not settle");
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-runmeasure-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const fake = join(dataDir, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
at=$(($(date +%s) + 86400))
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":'$at',"rateLimitType":"seven_day","utilization":0.5}}'
echo "work" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-1","terminal_reason":"completed"}'
`,
  );
  chmodSync(fake, 0o755);
  crew = await startCrew(app, { forgeUrl: servers.url, localUrl: servers.url, binary: fake, concurrency: 1, budgetUsd: 2, runTimeoutMs: 60_000 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createAgent(app, alice, { username: "bot" });
  if (!made.ok) throw new Error(String(made.error));
  bot = made.value.user;
  const created = await createRepo(app, alice, { name: "garden", visibility: "private" });
  if (!created.ok) throw new Error(String(created.error));
  repo = created.value;
  const seeded = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# garden\n" }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
}, 30_000);

afterAll(async () => {
  await crew.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a run with no grant stores the measure against platform; with a grant, against that subscription", async () => {
  const added = addSubscription(app.db, dataDir, { name: "main", token: "sk-ant-oat01-runner-1" });
  if (!added.ok) throw new Error(added.error);
  const sub = added.value.id;
  const now = new Date();
  await runOnce("first");
  expect(measureFor(app.db, PLATFORM, "week", now)?.usedPct).toBe(50);
  expect(measureFor(app.db, sub, "week", now)).toBeNull();

  setGrants(app.db, repo.id, "", [sub]);
  await runOnce("second");
  expect(measureFor(app.db, sub, "week", now)?.usedPct).toBe(50);
}, 90_000);
