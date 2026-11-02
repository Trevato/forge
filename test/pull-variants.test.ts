import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { listPulls } from "../src/core/pulls.ts";
import { chmodSync } from "node:fs";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { cancelRun, listRuns } from "../src/core/runs.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getIssueById } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { queueAgentRun, startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

const gitEnv = gitClientEnv();

describe("a pull says its variant group and siblings", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  let dir: string;

  async function gitOk(args: string[]): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      env: gitEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  }
  const auth = { authorization: "" };
  const api = async (path: string, init: RequestInit = {}) =>
    (await fetch(`${base}/api/v1/repos/dev/app${path}`, {
      ...init,
      headers: { ...auth, "content-type": "application/json" },
    })).json() as Promise<any>;
  const write = async (text: string, message: string) => {
    await Bun.write(join(dir, "code.txt"), text);
    await gitOk(["commit", "-am", message]);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pv-"));
    work = await mkdtemp(join(tmpdir(), "forge-pv-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, {
      username: "dev",
      email: "dev@f.dev",
      password: "pull-variants-pass",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "dev",
        password: "pull-variants-pass",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    auth.authorization = `Bearer ${token}`;
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    const remote = `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`;
    dir = work;
    await gitOk(["clone", remote, "app"]);
    dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nbeta\ngamma\n");
    await gitOk(["add", "."]);
    await gitOk(["commit", "-m", "base"]);
    await gitOk(["push", "origin", "main"]);
    // The branches are cut here, in one push, so the test below spends its
    // own time on the pulls it is about, not on git processes (a loaded
    // machine ran its dozen spawns past the 5 s test timeout).
    for (const name of ["a", "b", "c"]) {
      await gitOk(["checkout", "-B", name, "main"]);
      await write(`alpha\n${name}\ngamma\n`, `try ${name}`);
    }
    await gitOk(["push", "origin", "a", "b", "c"]);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("pulls sharing a group name each other; an ordinary pull has null and []", async () => {
    for (const name of ["a", "b", "c"]) {
      const made = await api("/pulls", {
        method: "POST",
        body: JSON.stringify({ base: "main", head: name, title: name }),
      });
      expect(made.variantGroup).toBeNull();
      expect(made.variantSiblings).toEqual([]);
    }
    app.db.run(
      `UPDATE pull SET variant_group = 'try-it'
        WHERE issue_id IN (SELECT id FROM issue WHERE number IN (1, 2))`,
    );
    const one = await api("/pulls/1");
    expect(one.variantGroup).toBe("try-it");
    expect(one.variantSiblings).toEqual([2]);
    const two = await api("/pulls/2");
    expect(two.variantGroup).toBe("try-it");
    expect(two.variantSiblings).toEqual([1]);
    const three = await api("/pulls/3");
    expect(three.variantGroup).toBeNull();
    expect(three.variantSiblings).toEqual([]);

    const list = (await api("/pulls")) as { items: any[] };
    const byNumber = new Map(list.items.map((p) => [p.number, p]));
    expect(byNumber.get(1).variantSiblings).toEqual([2]);
    expect(byNumber.get(3).variantGroup).toBeNull();
    expect(byNumber.get(3).variantSiblings).toEqual([]);
  });

  test("runs carry a nullable variant_group", () => {
    const cols = app.db
      .query<{ name: string }, []>("PRAGMA table_info(run)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("variant_group");
  });
});

describe("a tell asks for variants", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let auth: Record<string, string>;

  // Each tell has its own words: the same words twice are one job (`crew/twin.ts`).
  let told = 0;
  const tellOver = (body: Record<string, unknown>) =>
    fetch(`${servers.url}/api/v1/feed/tells`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ app: "alice/square", text: `Make it purple ${++told}`, ...body }),
    });
  const runs = () => listRuns(app.db, repo.id, { kind: "agent" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tellvar-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    auth = {
      authorization: `Bearer ${createToken(app.db, alice.id, "tells", "rw").token}`,
    };
    const agent = await createAgent(app, alice, { username: "bot", brief: "Be brief." });
    if (!agent.ok) throw new Error(String(agent.error));
    const created = await createRepo(app, alice, { name: "square", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# square\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    // A crew whose runs wait: nothing here starts a process.
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: "/nonexistent-agent",
      concurrency: 0,
      budgetUsd: 1,
      runTimeoutMs: 5_000,
    });
  }, 30_000);

  let crew: CrewHandle;
  afterAll(async () => {
    await crew?.stop();
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a plain tell has no group", async () => {
    const res = await tellOver({});
    expect(res.status).toBe(201);
    const got = (await res.json()) as any;
    expect(got.variantGroup).toBeUndefined();
    const run = await until(() => runs().find((r) => r.reason === "assigned"));
    expect(run.variantGroup).toBeNull();
  });

  test("variants: 0, 9, \"2\" and 2.5 are a 400 and open nothing", async () => {
    const before = runs().length;
    for (const variants of [0, 9, "2", 2.5, null, true]) {
      const res = await tellOver({ variants });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).message).toContain("1 to 4");
    }
    expect((await tellOver({ variants: 1 })).status).toBe(201);
    await Bun.sleep(100);
    expect(runs().length).toBe(before + 1);
  });

  test("variants: 2 makes two runs in one fresh group", async () => {
    const before = new Set(runs().map((r) => r.id));
    const res = await tellOver({ variants: 2 });
    expect(res.status).toBe(201);
    const got = (await res.json()) as any;
    expect(got.issues).toHaveLength(2);
    const fresh = await until(() => {
      const f = runs().filter((r) => !before.has(r.id));
      return f.length === 2 ? f : undefined;
    });
    expect(fresh[0]!.variantGroup).toBe(got.variantGroup);
    expect(fresh[1]!.variantGroup).toBe(got.variantGroup);
    expect(new Set(fresh.map((r) => r.issueId)).size).toBe(2);
  });

  test("a variant run queued again keeps its group, paused or swept", async () => {
    const got = (await (await tellOver({ variants: 2 })).json()) as any;
    const mine = await until(() => {
      const f = runs().filter((r) => r.variantGroup === got.variantGroup && r.state === "queued");
      return f.length === 2 ? f : undefined;
    });
    const first = mine[0]!;
    cancelRun(app.db, first.id, "paused");
    const issue = getIssueById(app.db, first.issueId!)!;
    const agent = getAgentByName(app.db, "bot")!;
    const again = queueAgentRun(app, repo, issue, agent, "assigned", undefined, {
      notBefore: new Date().toISOString(),
      attempt: 2,
      summary: "carries on",
    });
    expect(again?.variantGroup).toBe(got.variantGroup);
    cancelRun(app.db, again!.id, "swept");
    const swept = queueAgentRun(app, repo, issue, agent, "assigned");
    expect(swept?.variantGroup).toBe(got.variantGroup);
  });

});

describe("a variant run opens a pull that carries its group", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tellpull-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const fake = join(dataDir, "fake-claude");
    await Bun.write(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
echo "work by the crew" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md.","total_cost_usd":0.01,"num_turns":2,"session_id":"fake-1","terminal_reason":"completed"}'
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
  }, 30_000);

  afterAll(async () => {
    await crew?.stop();
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("two variants open two pulls in the returned group, on different branches", async () => {
    const alice = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!alice.ok) throw new Error(alice.error);
    const agent = await createAgent(app, alice.value, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    const created = await createRepo(app, alice.value, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    const seeded = await commitToBranch(app, alice.value, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice.value, repo, "bot").ok).toBe(true);

    const res = await fetch(`${servers.url}/api/v1/feed/tells`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(app.db, alice.value.id, "tells", "rw").token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ app: "alice/garden", text: "Plant tulips", variants: 2 }),
    });
    expect(res.status).toBe(201);
    const got = (await res.json()) as any;
    expect(got.assigned).toEqual(got.issues);

    const pulls = await until(
      () => {
        const open = listPulls(app.db, repo.id, { state: "open" });
        return open.length === 2 ? open : undefined;
      },
      30_000,
    );
    expect(pulls.map((p) => p.variantGroup)).toEqual([got.variantGroup, got.variantGroup]);
    expect(new Set(pulls.map((p) => p.headBranch)).size).toBe(2);
    const runs = listRuns(app.db, repo.id, { kind: "agent" });
    expect(runs.every((r) => r.variantGroup === got.variantGroup)).toBe(true);
  }, 60_000);
});

async function until<T>(
  probe: () => T | undefined,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = probe();
    if (got !== undefined) return got;
    await Bun.sleep(25);
  }
  throw new Error("never");
}
