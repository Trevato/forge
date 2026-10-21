/**
 * A hosted child answered in-process takes a `git push` over HTTPS: its
 * receive-pack hooks reach the child's own internal listener, behind the
 * child's own boot secret. Before, only `serve` (the parent) started an
 * internal listener, so every push to a child failed closed with
 * "forge: hook relay failed".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { fetchInternal } from "../src/git/hook-address.ts";
import { HOOK_SECRET_HEADER } from "../src/git/hook-protocol.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resolveHostedChild } from "../src/spawn/host.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

quietLogs();

const CHILD_HOST = "homie--forge.test";

async function git(args: string[], cwd: string): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err: err.trim() };
}

describe("a hosted child takes a push over HTTPS", () => {
  let dir = "";
  let work = "";
  let parent: App;
  let child: App;
  let servers: Servers;
  let token = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-child-push-"));
    work = await mkdtemp(join(tmpdir(), "forge-child-push-work-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.invalid",
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    const spawned = await spawnForge(
      parent,
      made.value,
      { name: "homie", org: "homie", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/spawn", {
          method: "POST",
          headers: { origin: "https://forge.test" },
        }),
        url: new URL("https://forge.test/spawn"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    servers = await serve(parent);

    const opened = await resolveHostedChild(
      parent,
      new Request("https://forge.test/healthz", { headers: { host: CHILD_HOST } }),
    );
    if (opened === undefined || opened === "unknown") throw new Error("child not found");
    child = opened;
    const bob = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "b@x.invalid",
    });
    if (!bob.ok) throw new Error("child user");
    promote(child.db, bob.value);
    token = tokenFor(child, "bob", "rw");
    const created = await fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        host: CHILD_HOST,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "app" }),
    });
    if (created.status !== 201) throw new Error(`repo: ${created.status} ${await created.text()}`);
  });

  afterAll(async () => {
    servers?.stop();
    parent?.close();
    await rm(work, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  test("a push lands, through pre-receive and post-receive", async () => {
    const remote = `${servers.url.replace("http://", `http://bob:${token}@`)}/bob/app.git`;
    const repo = join(work, "app");
    expect((await git(["init", "-q", "-b", "main", repo], work)).code).toBe(0);
    await Bun.write(join(repo, "README.md"), "# app\n");
    expect((await git(["add", "."], repo)).code).toBe(0);
    expect((await git(["commit", "-qm", "genesis"], repo)).code).toBe(0);
    // The parent's one listener, the child's Host: as the platform routes it.
    const pushed = await git(
      ["-c", `http.extraHeader=Host: ${CHILD_HOST}`, "push", remote, "main"],
      repo,
    );
    expect(pushed.err).not.toContain("hook relay failed");
    expect(pushed.code).toBe(0);

    // The child's index saw it: post-receive reached the child, not the parent.
    const events = await fetch(`${servers.url}/api/v1/repos/bob/app/events`, {
      headers: { host: CHILD_HOST, authorization: `Bearer ${token}` },
    });
    const list = (await events.json()) as { kind: string }[];
    expect(list.some((e) => e.kind === "push")).toBe(true);
  });

  test("the child's listener is its own: the parent's secret is refused there", async () => {
    expect(child.hookAddress.current).not.toBe(parent.hookAddress.current);
    expect(child.hookSecret).not.toBe(parent.hookSecret);
    const asParent = await fetchInternal(child.hookAddress.current, "/internal/hook", {
      method: "POST",
      headers: { "content-type": "application/json", [HOOK_SECRET_HEADER]: parent.hookSecret },
      body: "{}",
    });
    expect(asParent.status).toBe(403);
    const bare = await fetchInternal(child.hookAddress.current, "/internal/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bare.status).toBe(403);
  });
});
