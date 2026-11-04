/**
 * A hosted child runs the apps it was given (#1384): `<app>--<child>--<parent>`
 * is answered by the child's own runtime through the parent's server, on the
 * parent's lanes, with the child's data under the child's directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { childRuntime } from "../src/spawn/child-apps.ts";
import { proxyApp } from "../src/apps/proxy.ts";
import { bootHostedChild, hostedChildApps, resolveHostedChild, resolveHostedChildApp } from "../src/spawn/host.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const author = { name: "a", email: "a@x.invalid" };
const SERVER = `Bun.serve({ port: Number(process.env.PORT), fetch() { return new Response(process.env.FORGE_APP_DATA ?? "") } })\n`;

describe("a hosted child's apps run in the parent", () => {
  let dir = "";
  let parent: App;
  let servers: Servers | undefined;
  let runtime: AppsRuntime;
  let checks: ChecksHandle;
  let childDir = "";
  let numberedDir = "";

  /** One request for `host` through the parent's Host dispatch, as `serve` does it. */
  const ask = async (host: string): Promise<Response> => {
    const request = new Request("http://parent.invalid/", { headers: { host } });
    const hit = await resolveHostedChildApp(parent, request);
    if (hit === undefined) return new Response("not an app host", { status: 418 });
    if (hit === "unknown") return new Response("not found", { status: 404 });
    if ("cell" in hit) throw new Error("this child is hosted");
    // The server is only for a websocket upgrade, which these requests are not.
    return (await proxyApp(hit.runtime, request, hit.target, {} as never))!;
  };

  /** Wait until the child's boot deploys have settled, then say what they came to. */
  const deployed = async (name: string): Promise<void> => {
    const child = childRuntime(parent, name)!;
    const until = Date.now() + 150_000;
    while (child.startingCount() > 0 && Date.now() < until) await Bun.sleep(100);
    if (child.startingCount() > 0) throw new Error(`never came: still waiting while child.startingCount() > 0`);
    const summary = hostedChildApps(parent, name)!;
    if (summary.running !== summary.total) throw new Error(`${name}: ${JSON.stringify(summary.notRunning)}`);
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-child-runs-apps-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
    if (!made.ok) throw new Error("user");
    const repo = await createRepo(parent, made.value, { name: "bakery", visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    // The parent runs `bakery` too: its preview hosts are `bakery--<pull>`.
    const record = createAppRecord(parent.db, { repoId: repo.value.id, slug: "bakery", access: "public" });
    if (!record.ok) throw new Error(record.error);
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [
        { path: "forge.json", content: JSON.stringify({ app: { run: "bun run index.ts", health: "/" } }) },
        { path: "index.ts", content: SERVER },
      ],
      author,
    });
    if (!c.ok) throw new Error("commit");
    runtime = new AppsRuntime(parent, {
      domain: "--forge.test",
      scheme: "https",
      forgeUrl: "https://forge.test",
      concurrency: 2,
    });
    await runtime.start();
    checks = startChecks(parent, { forgeUrl: "https://forge.test" });
    const spawned = await spawnForge(
      parent,
      made.value,
      { name: "maria", org: "marias", apps: ["alice/bakery"], carryBriefs: false, carrySubscriptions: false },
      { catalog: [{ ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 }], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/x", { method: "POST", headers: { origin: "https://forge.test" } }),
        url: new URL("https://forge.test/x"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    childDir = childDirOf(parent, spawned.value.bodyId);
    await bootHostedChild(parent, "maria");
    await deployed("maria");
    // A child named like a pull number, with the same app as the parent's.
    const numbered = await spawnForge(
      parent,
      made.value,
      { name: "12", org: "twelve", apps: ["alice/bakery"], carryBriefs: false, carrySubscriptions: false },
      { catalog: [{ ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 }], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/x", { method: "POST", headers: { origin: "https://forge.test" } }),
        url: new URL("https://forge.test/x"),
      },
    );
    if (!numbered.ok) throw new Error(JSON.stringify(numbered.error));
    numberedDir = childDirOf(parent, numbered.value.bodyId);
    await bootHostedChild(parent, "12");
    await deployed("12");
    servers = await serve(parent);
  }, 200_000);

  afterAll(async () => {
    await checks?.stop();
    servers?.stop();
    await runtime?.stop();
    parent?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("<app>--<child>--<parent> answers from the child's app, on the child's own data", async () => {
    const res = await ask("bakery--maria--forge.test");
    expect(res.status).toBe(200);
    // Says which app answered, so a probe from outside tells it from a platform's standby page (spawn/reach.ts).
    expect(res.headers.get("x-forge-app")).toBe("bakery");
    const data = await res.text();
    // The child's directory, never the parent's or another child's.
    expect(data.startsWith(join(childDir, "apps"))).toBe(true);
    expect(data.startsWith(join(dir, "apps"))).toBe(false);
  });

  test("it is one more tenant of the parent's lanes, and /forges can say it runs", async () => {
    const child = childRuntime(parent, "maria")!;
    expect(child.lane).toBe(runtime.lane);
    const summary = hostedChildApps(parent, "maria")!;
    expect(summary.total).toBe(1);
    expect(summary.running).toBe(1);
    expect(summary.notRunning).toEqual([]);
  });

  test("the child's app has the public URL it has on the parent, and its name is not the parent's", async () => {
    const child = childRuntime(parent, "maria")!;
    expect(child.hostFor("bakery", "production")).toBe("bakery--maria--forge.test");
    // The parent holds no such app: its own label is a stranger's.
    const stranger = new Request("http://parent.invalid/", { headers: { host: "bakery--nobody--forge.test" } });
    expect(await resolveHostedChildApp(parent, stranger)).toBeUndefined();
    expect(await resolveHostedChild(parent, stranger)).toBe("unknown");
  });

  test("an app the child does not have is a 404, and the child's own host still serves its pages", async () => {
    expect((await ask("ghost--maria--forge.test")).status).toBe(404);
    expect((await ask("maria--forge.test")).status).toBe(418);
  });

  test("through the parent's listener the same host answers", async () => {
    if (servers === undefined) throw new Error("the parent's listener did not start");
    const res = await fetch(servers.url + "/", { headers: { host: "bakery--maria--forge.test" } });
    expect(res.status).toBe(200);
    expect((await res.text()).startsWith(join(childDir, "apps"))).toBe(true);
    const home = await fetch(servers.url + "/healthz", { headers: { host: "maria--forge.test" } });
    expect(home.status).toBe(200);
  });

  test("the parent's own preview host wins over a child named like its pull number", async () => {
    if (servers === undefined) throw new Error("the parent's listener did not start");
    // The child's app is up and would answer this very host if it were asked.
    expect((await ask("bakery--12--forge.test")).status).toBe(200);
    const res = await fetch(servers.url + "/", { headers: { host: "bakery--12--forge.test" } });
    expect(res.status).not.toBe(200);
    const body = await res.text();
    expect(body.startsWith(join(numberedDir, "apps"))).toBe(false);
    expect(body.startsWith(join(childDir, "apps"))).toBe(false);
  });
});
