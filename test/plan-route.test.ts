/**
 * The planner plans through one route (#1063): `POST …/plan` is the MCP
 * `plan` tool's action. A planning run through the stand-in agent that
 * names no pillar gets `no_pillar` and nothing is opened; the same run with
 * the pillar named opens the issues under the umbrella.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setCrewRole } from "../src/core/agents.ts";
import { listIssues } from "../src/core/issues.ts";
import { pillarsOf } from "../src/core/pillars.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("POST …/plan", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let repo: Repo;
  let rw = "";

  const titles = () => listIssues(app.db, repo.id, {}).map((i) => i.title);
  const post = (token: string, issues: unknown) =>
    fetch(`${servers.url}/api/v1/repos/alice/garden/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ issues }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-planroute-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // The stand-in planner: takes the route from its brief, posts the plan
    // in plan1.json and then the one in plan2.json, and keeps the answers.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first; printf '%s\\n' "$first" > "${dataDir}/prompt"
echo '{"type":"system","subtype":"init","session_id":"p1","model":"fake"}'
if grep -q "this run is a planning run" "${dataDir}/prompt"; then
  path=$(grep -o 'api/v1/repos/[^"\\\\ ]*/plan' "${dataDir}/prompt" | head -1)
  for n in 1 2; do
    curl -sS -X POST -H "authorization: Bearer $FORGE_TOKEN" -H "content-type: application/json" "\${FORGE_URL%/}/$path" -d @"${dataDir}/plan$n.json" > "${dataDir}/out$n"
  done
fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"Planned.","total_cost_usd":0.01,"num_turns":1}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    const made = await createAgent(app, alice, { username: "atlas", brief: "Plan." });
    if (!made.ok) throw new Error(String(made.error));
    const created = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "atlas").ok).toBe(true);
    setCrewRole(app.db, repo.id, made.value.user.id, "planner");
    const umbrella = openIssue(app, alice, repo, { title: "P0 Trust: be trusted", body: "" });
    if (!umbrella.ok) throw new Error(String(umbrella.error));
    expect(pillarsOf(app.db, repo).pillars.length).toBe(1);

    writeFileSync(
      join(dataDir, "plan1.json"),
      JSON.stringify({ issues: [{ key: "a", title: "Water the beds" }] }),
    );
    writeFileSync(
      join(dataDir, "plan2.json"),
      JSON.stringify({
        issues: [
          { key: "a", title: "Water the beds", pillar: "P0" },
          { key: "b", title: "Buy a hose", later: true, why: "Nothing needs it yet." },
        ],
      }),
    );
    const direction = openIssue(app, alice, repo, { title: "Direction: tend the garden", body: "" });
    if (!direction.ok) throw new Error(String(direction.error));
    const gate = openIssue(app, alice, repo, { title: "Later gate: not yet", body: "" });
    if (!gate.ok) throw new Error(String(gate.error));
    // Planning run: the stand-in posts the refused plan, then the good one.
    expect(assignIssue(app, alice, repo, direction.value, made.value.user).ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the planner's run is refused with no_pillar, then opens the issues under the umbrella", async () => {
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(dataDir, "out2")) && Date.now() < deadline) await Bun.sleep(100);
    const first = JSON.parse(readFileSync(join(dataDir, "out1"), "utf8"));
    expect(first.error).toBe("no_pillar");
    const second = JSON.parse(readFileSync(join(dataDir, "out2"), "utf8"));
    expect(second.opened.map((o: { key: string }) => o.key)).toEqual(["a", "b"]);
    expect(titles().filter((t) => t === "Water the beds").length).toBe(1);
    expect(second.later.length).toBe(1);
    const trust = pillarsOf(app.db, repo).pillars[0]!;
    const served = second.opened[0].number;
    expect(
      app.db
        .query("SELECT 1 FROM issue_dependency WHERE issue_id = ?1 AND blocker_id = (SELECT id FROM issue WHERE repo_id = ?2 AND number = ?3)")
        .get(trust.umbrella.id, repo.id, served),
    ).not.toBeNull();
  }, 40_000);

  test("a person's token plans the same way, all or nothing, and a read token is refused", async () => {
    const before = titles().length;
    const refused = await post(rw, [
      { key: "x", title: "Fine", pillar: "P0" },
      { key: "y", title: "No pillar" },
    ]);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("no_pillar");
    expect(titles().length).toBe(before);
    const ro = createToken(app.db, alice.id, "ro", "ro").token;
    expect((await post(ro, [{ key: "x", title: "Fine", pillar: "P0" }])).status).toBe(403);
    expect((await post(rw, "nope")).status).toBe(422);
  });
});
