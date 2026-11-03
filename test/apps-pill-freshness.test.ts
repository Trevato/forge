/**
 * The pill says whether its preview is the pull as it stands (#9111): the
 * pull's state and `behind`, for a reader of the pull only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { pillWhere, proxyApp, signGrant, type AppSocket, type AppTarget } from "../src/apps/proxy.ts";
import { toolbarJs, toolbarTag } from "../src/apps/toolbar.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the pill's freshness", () => {
  let dataDir: string;
  let app: App;
  let aliceId: string;
  let target: AppTarget;
  let repoId: string;
  const live = { state: "running", commitOid: "a".repeat(40) } as { state: string; commitOid: string };
  const numbers: number[] = [];
  const runtime = () =>
    ({ app, envStatus: () => live }) as unknown as AppsRuntime;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pill-fresh-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    aliceId = a.value.id;
    const made = await newApp(app, a.value, { name: "site", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.repo.id;
    target = { app: getAppByRepo(app.db, repoId)!, env: "production" } as AppTarget;
    for (let i = 0; i < 3; i++) {
      const p = createIssue(app.db, { repoId, authorId: aliceId, title: `p${i}`, kind: "pull" });
      if (!p.ok) throw new Error(p.error);
      numbers.push(p.value.number);
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'topic', ?2, ?2)", [p.value.id, "a".repeat(40)]);
    }
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const at = (n: number): AppTarget => ({ ...target, env: `pull-${n}` }) as AppTarget;
  const alice = () => ({ id: aliceId }) as never;

  test("an open pull whose preview runs its head says nothing extra", () => {
    live.state = "running"; live.commitOid = "a".repeat(40);
    const w = pillWhere(runtime(), at(numbers[0]!), alice());
    expect(w.state).toBe("open");
    expect(w.behind).toBe(false);
    expect(w.deploying).toBeUndefined();
  });

  test("a merged pull's preview says merged; a closed one, closed", () => {
    const id = (n: number) => app.db.query<{ id: string }, [string, number]>("SELECT id FROM issue WHERE repo_id=?1 AND number=?2").get(repoId, n)!.id;
    app.db.run("UPDATE pull SET merged_at='2026-01-01T00:00:00Z' WHERE issue_id=?1", [id(numbers[1]!)]);
    app.db.run("UPDATE issue SET state='closed' WHERE id=?1", [id(numbers[1]!)]);
    expect(pillWhere(runtime(), at(numbers[1]!), alice()).state).toBe("merged");
    app.db.run("UPDATE issue SET state='closed' WHERE id=?1", [id(numbers[2]!)]);
    expect(pillWhere(runtime(), at(numbers[2]!), alice()).state).toBe("closed");
  });

  test("a live commit that is not the head is behind; a deploy in flight is deploying instead", () => {
    live.state = "running"; live.commitOid = "b".repeat(40);
    expect(pillWhere(runtime(), at(numbers[0]!), alice()).behind).toBe(true);
    live.state = "deploying";
    const w = pillWhere(runtime(), at(numbers[0]!), alice());
    expect(w.behind).toBe(false);
    expect(w.deploying).toBe(true);
  });

  test("an anonymous viewer gets neither field", () => {
    live.state = "running"; live.commitOid = "b".repeat(40);
    const w = pillWhere(runtime(), at(numbers[0]!), undefined);
    expect(w.state).toBeUndefined();
    expect(w.behind).toBeUndefined();
    expect(w.deploying).toBeUndefined();
  });

  test("the tag carries the fields and the script holds the words", () => {
    const tag = toolbarTag("http://f.test", { app: "a", env: "pull-3", pull: 3, state: "merged", behind: true });
    expect(tag).toContain('data-state="merged"');
    expect(tag).toContain('data-behind="1"');
    for (const words of [
      "Merged: this preview shows the pull as it landed",
      "Closed without landing",
      "A newer push is deploying",
      "Shows an older push than the pull's newest",
    ]) expect(toolbarJs).toContain(words);
  });
});

describe("the pill's freshness, through the proxy", () => {
  const HEAD = "a".repeat(40);
  const NO_SOCKETS = { upgrade: () => false } as unknown as Bun.Server<AppSocket>;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let status: ReturnType<typeof spyOn>;
  let live = HEAD;
  let target: AppTarget;
  let alice: { id: string; name: string; role: "admin" };
  const pulls: Record<"open" | "merged", number> = { open: 0, merged: 0 };

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch: () => new Response("<!doctype html><html><head></head><body><p>hi</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    dataDir = await mkdtemp(join(tmpdir(), "forge-pill-fresh-proxy-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
    await runtime.start();
    status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      () => ({ env: "x", state: "running", port: backend.port, commitOid: live }) as unknown as EnvStatus,
    );
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = { id: a.value.id, name: "alice", role: "admin" };
    const made = await newApp(app, a.value, { name: "site", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repoId = made.value.repo.id;
    target = { app: getAppByRepo(app.db, repoId)!, env: "production" } as AppTarget;
    for (const kind of ["open", "merged"] as const) {
      const p = createIssue(app.db, { repoId, authorId: alice.id, title: kind, kind: "pull" });
      if (!p.ok) throw new Error(p.error);
      pulls[kind] = p.value.number;
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'topic', ?2, ?2)", [p.value.id, HEAD]);
      if (kind === "merged") {
        app.db.run("UPDATE pull SET merged_at='2026-01-01T00:00:00Z' WHERE issue_id=?1", [p.value.id]);
        app.db.run("UPDATE issue SET state='closed' WHERE id=?1", [p.value.id]);
      }
    }
  }, 120_000);

  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    servers.stop();
    backend.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** The pill's injected script tag, as one served preview page carries it. */
  async function tagFor(n: number, signedIn: boolean): Promise<string> {
    const at = { ...target, env: `pull-${n}` } as AppTarget;
    const headers: Record<string, string> = { host: "site.apps.test", accept: "text/html" };
    if (signedIn)
      headers.cookie = `forge_grant_${at.app.id.slice(-8)}=${signGrant(dataDir, at, 60_000, Date.now(), alice)}`;
    const res = await proxyApp(runtime, new Request(`${servers.url}/`, { headers }), at, NO_SOCKETS);
    const html = await res!.text();
    const tag = html.match(/<script[^>]*data-app=[^>]*>/)?.[0];
    if (tag === undefined) throw new Error(`no pill tag in: ${html}`);
    return tag;
  }

  test("a signed-in reader's open preview at its head says open, not behind", async () => {
    live = HEAD;
    const tag = await tagFor(pulls.open, true);
    expect(tag).toContain('data-state="open"');
    expect(tag).not.toContain("data-behind");
    expect(tag).not.toContain("data-deploying");
  });

  test("a merged pull's preview says merged", async () => {
    expect(await tagFor(pulls.merged, true)).toContain('data-state="merged"');
  });

  test("a live commit that is not the head says behind", async () => {
    live = "b".repeat(40);
    expect(await tagFor(pulls.open, true)).toContain('data-behind="1"');
    live = HEAD;
  });

  test("an anonymous viewer's page carries none of the three", async () => {
    live = "b".repeat(40);
    const tag = await tagFor(pulls.open, false);
    expect(tag).toContain("data-pull=");
    for (const a of ["data-state", "data-behind", "data-deploying"]) expect(tag).not.toContain(a);
    live = HEAD;
  });
});
