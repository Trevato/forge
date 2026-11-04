/**
 * The dials at work through the crew itself (#2680): queued runs start in the
 * order the dials give (a zero-dial team's labelled work is not starved), and
 * a planning run receives the teams section in its task.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { createLabel, getIssueById, setIssueLabels, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let crew: CrewHandle | undefined;
let alice: User;
let repo: Repo;

const fresh = (): Repo => getRepoById(app.db, repo.id)!;
const prompts = (): string[] =>
  (existsSync(join(dataDir, "prompts")) ? readdirSync(join(dataDir, "prompts")) : []).map((f) => readFileSync(join(dataDir, "prompts", f), "utf8"));

async function until<T>(what: string, probe: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const got = probe();
    if (got !== undefined && got !== false) return got;
    await Bun.sleep(50);
  }
  throw new Error(`never: ${what}`);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-team-dispatch-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice",
    email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "README.md", content: "# engine\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  for (const name of ["atlas", "mason"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  seatAs(app.db, repo.id, getUserByName(app.db, "atlas")!.id, "planner");
  // The stand-in agent keeps the first line it is told and ends at once.
  const fake = join(dataDir, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
mkdir -p "${dataDir}/prompts"
IFS= read -r first; printf '%s\\n' "$first" > "${dataDir}/prompts/p.$$"
echo '{"type":"system","subtype":"init","session_id":"s9","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
`,
  );
  chmodSync(fake, 0o755);
}, 30_000);

afterAll(async () => {
  await crew?.stop();
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe("dispatch by dials", () => {
  test("queued runs start in the order the dials give; a zero-dial team is not starved", async () => {
    expect(saveTeam(app.db, "design", { charter: "Owns looks.", dial: 60, members: [] }).ok).toBe(true);
    const design = createLabel(app.db, repo.id, "design", "7c3aed");
    const security = createLabel(app.db, repo.id, "security", "ef4444");
    if (!design.ok || !security.ok) throw new Error("labels");
    // Opened in this order, so oldest first would be u1, s1, u2, d1, d2.
    const open = (title: string, label?: string): Issue => {
      const o = openIssue(app, alice, fresh(), { title });
      if (!o.ok) throw new Error(String(o.error));
      if (label) setIssueLabels(app.db, o.value.id, [label]);
      return o.value;
    };
    const u1 = open("Unlabelled one");
    const s1 = open("Security work", security.value.id);
    const u2 = open("Unlabelled two");
    const d1 = open("Design one", design.value.id);
    const d2 = open("Design two", design.value.id);
    const mason = getUserByName(app.db, "mason")!;
    for (const i of [u1, s1, u2, d1, d2]) {
      const assigned = assignIssue(app, alice, fresh(), getIssueById(app.db, i.id)!, mason);
      if (!assigned.ok) throw new Error(String(assigned.error));
    }
    // One slot, and the crew starts only now: the sweep queues all five
    // oldest first, and the pump alone decides who goes first.
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "fake-claude"),
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const started = await until("five runs started", () => {
      const runs = listRuns(app.db, repo.id, { kind: "agent" })
        .filter((r) => r.startedAt !== null && [u1, s1, u2, d1, d2].some((i) => i.id === r.issueId))
        .sort((a, b) => a.startedAt!.localeCompare(b.startedAt!) || a.id.localeCompare(b.id));
      return runs.length >= 5 ? runs : undefined;
    });
    const order = started.slice(0, 5).map((r) => [u1, s1, u2, d1, d2].find((i) => i.id === r.issueId)!.title);
    // Design takes 60%: first, then the rest's turn, then design again;
    // security (dial 0) keeps its place among unlabelled work.
    expect(order).toEqual(["Design one", "Unlabelled one", "Design two", "Security work", "Unlabelled two"]);
  }, 60_000);
});

describe("the planner's task", () => {
  test("a planning run on the direction receives the teams section", async () => {
    const atlas = getUserByName(app.db, "atlas")!;
    const o = openIssue(app, alice, fresh(), { title: "Direction", body: "Keep the engine small." });
    if (!o.ok) throw new Error(String(o.error));
    app.db.query("UPDATE repo SET direction_issue_id = ?2 WHERE id = ?1").run(repo.id, o.value.id);
    const before = prompts().length;
    const assigned = assignIssue(app, alice, fresh(), getIssueById(app.db, o.value.id)!, atlas);
    if (!assigned.ok) throw new Error(String(assigned.error));
    const told = await until("the planner's prompt", () =>
      prompts().find((p) => p.includes("builder starts")),
    );
    expect(prompts().length).toBeGreaterThan(before);
    expect(told).toContain("design (60% of builder starts)");
    expect(told).toContain("Owns looks.");
    expect(existsSync(join(dataDir, "prompts"))).toBe(true);
  }, 60_000);
});
