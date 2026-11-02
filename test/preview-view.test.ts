/**
 * `previewOf`, the answer behind MCP `preview`, called directly: a preview
 * host names its pull, check and first failure; anything else is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { previewOf } from "../src/apps/preview_view.ts";
import { getRepo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getPull } from "../src/core/pulls.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("previewOf", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let redPull = 0;
  const domain = "apps.test";
  const origin = "http://forge.test";
  const host = (label: string) => `http://${label}.${domain}/x`;
  const ask = (user: User, raw: unknown) => previewOf(app, domain, user, origin, raw);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-preview-view-"));
    app = createApp({ dataDir, port: 0 });
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    alice = getUserByName(app.db, "alice")!;
    for (const [name, visibility] of [["hello", "public"], ["vault", "private"]] as const) {
      const made = await newApp(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
    const repo = getRepo(app.db, "alice", "hello")!;
    const committed = await commitToBranch(app, alice, repo, {
      branch: "red",
      base: repo.defaultBranch,
      message: "red",
      files: [{ path: "red.md", content: "x\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, { title: "Make it red", baseBranch: repo.defaultBranch, headBranch: "red" });
    if (!opened.ok) throw new Error(String(opened.error));
    redPull = opened.value.number;
    const pull = getPull(app.db, repo.id, redPull)!;
    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, commitOid: pull.headOid });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "1 failed", checkDetail: { passed: 2, failed: 1, names: ["adds"] } });
    const agent = await createUser(app.db, { origin: "seed", trusted: true, username: "worker", email: "worker@forge.local", password: "a-good-passphrase" });
    if (!agent.ok) throw new Error(agent.error);
    claimRun(app.db, createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pull.id, actorId: agent.value.id }).id);
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a production host answers the app, production, and no pull", () => {
    const r = ask(bob, host("hello"));
    expect(r.ok && r.value.app).toBe("alice/hello");
    expect(r.ok && r.value.environment).toBe("production");
    expect(r.ok && r.value.pull).toBeNull();
    expect(r.ok && r.value.check).toBeNull();
  });

  test("a preview host names its pull, the red check, first failure, log and worker", () => {
    const r = ask(alice, host(`hello--${redPull}`));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.environment).toBe(`pull-${redPull}`);
    expect(r.value.pull).toEqual({ number: redPull, title: "Make it red" });
    expect(r.value.check).toBe("red");
    expect(r.value.firstFailure).toBe("adds");
    expect(r.value.logUrl).toMatch(/^http:\/\/forge\.test\/alice\/hello\/runs\/[^/]+$/);
    expect(r.value.working).toEqual(["worker"]);
  });

  test("each refusal has its own error", () => {
    expect(ask(bob, "https://example.com/")).toEqual({ ok: false, error: "foreign" });
    expect(ask(bob, "not a url")).toEqual({ ok: false, error: "foreign" });
    expect(ask(bob, 42)).toEqual({ ok: false, error: "foreign" });
    expect(ask(bob, "ftp://hello.apps.test/")).toEqual({ ok: false, error: "foreign" });
    expect(previewOf(app, undefined, bob, origin, host("hello"))).toEqual({ ok: false, error: "foreign" });
    expect(ask(bob, host("nothing"))).toEqual({ ok: false, error: "no_such_app" });
    expect(ask(bob, host("hello--999"))).toEqual({ ok: false, error: "no_such_pull", number: 999 });
  });

  test("a private app is refused to one who cannot read it, as an unknown one is", () => {
    expect(ask(alice, host("vault")).ok).toBe(true);
    expect(ask(bob, host("vault"))).toEqual(ask(bob, host("nothing")));
  });
});
