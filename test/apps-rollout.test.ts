/**
 * An app through a rollout (#4496): its own redeploy and the forge's.
 *
 * - Its own deploy: the new version serves before the old one is let go
 *   of; a socket held to the old one closes with 1012 Service Restart and
 *   reconnects at once, a request it was still answering is answered, and
 *   a request loop across it sees no 502.
 * - The forge's: a new forge on the same data is not ready (`/readyz`)
 *   until the app it started serves; the old forge, leaving, closes its
 *   sockets with 1012 so they reconnect to the new one in under a second,
 *   and a request loop that follows readiness from the old forge to the
 *   new sees no 502.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp, redeployEnv } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { health } from "../src/http/health.ts";
import { takePresence, warmBehind, type Presence } from "../src/apps/presence.ts";
import { runQuery } from "../src/boards/query.ts";

/** A fixed CPU workload, in ms; the `x < 0` is never true and only keeps the loop alive. */
const spin = (): number => {
  const t = performance.now();
  let x = 0;
  for (let n = 0; n < 3e6; n++) x = (x + Math.sqrt(n)) % 1e9;
  return x < 0 ? 0 : performance.now() - t;
};
const fastest = (n: number) => Math.min(...Array.from({ length: n }, spin));
/** This machine's speed at module load, idle: the reference (scale 1.0 beside itself). */
const idle = (spin(), fastest(5));
/** How much slower the machine is now than at load, 1 to 8: a busy check machine stretches the bound. */
const loadScale = () => Math.max(1, Math.min(fastest(3) / idle, 8));
/** The reconnect bound, in ms, on an idle machine. */
const RECONNECT_MS = 1000;

/** `/` answers, `/slow` answers after a second and a half, `/ws` echoes. */
const SERVER = `export const server = Bun.serve({
  port: Number(process.env.PORT ?? "0"),
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws")
      return server.upgrade(request) ? undefined : new Response("no", { status: 400 });
    if (url.pathname === "/slow") {
      await Bun.sleep(1500);
      return new Response("slow and answered");
    }
    return new Response("up " + process.pid);
  },
  websocket: { message(ws, message) { ws.send(message); } },
});
`;

const SERVER_TEST = `import { expect, test } from "bun:test";
process.env.PORT = "0";
const { server } = await import("./server.ts");
test("serves the page", async () => {
  expect((await fetch(\`http://\${server.hostname}:\${server.port}/\`)).status).toBe(200);
});
`;

const DOMAIN = "apps.test";
const HOST = `rollme.${DOMAIN}`;

interface Forge {
  app: App;
  servers: Servers;
  runtime: AppsRuntime;
  presence: Presence;
}

async function bootForge(dataDir: string): Promise<Forge> {
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  const runtime = new AppsRuntime(app, {
    domain: DOMAIN,
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 2,
  });
  // As `main.ts` does: who else serves this data is read before the apps start.
  const presence = takePresence(dataDir);
  await runtime.start();
  warmBehind(app.log, presence, () => runtime.startingCount());
  return { app, servers, runtime, presence };
}

const get = (forge: Forge, path: string) =>
  fetch(`${forge.servers.url}${path}`, { headers: { host: HOST }, redirect: "manual" });

/** A socket through `forge`, and when and how it closed. */
function connect(forge: Forge) {
  const ws = new WebSocket(`ws://localhost:${forge.servers.port}/ws`, { headers: { host: HOST } });
  ws.addEventListener("error", () => {});
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("close", () => resolve(false));
  });
  const closed = new Promise<{ code: number; reason: string; at: number }>((resolve) =>
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason, at: Date.now() })),
  );
  const echo = (text: string) =>
    new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true });
      ws.send(text);
    });
  return { ws, opened, closed, echo };
}

/**
 * Ask `/` until `stop` is set, from whichever forge `target` names; every
 * status seen. `stop.asking` is the request in flight, so a test can let it
 * land before it stops the forge it went to.
 */
function loop(target: () => Forge, stop: { done: boolean; asking?: Promise<unknown> }): Promise<number[]> {
  return (async () => {
    const seen: number[] = [];
    while (!stop.done) {
      const asking = get(target(), "/").then(async (res) => {
        await res.arrayBuffer();
        return res.status;
      });
      stop.asking = asking;
      seen.push(await asking);
      await Bun.sleep(20);
    }
    return seen;
  })();
}

describe("apps: through a rollout", () => {
  let dataDir: string;
  let a: Forge;
  let b: Forge | undefined;
  let c: Forge | undefined;
  let alice: User;
  let repo: Repo;

  async function settled(forge: Forge, where: (run: Run) => boolean, timeoutMs = 90_000): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(forge.app.db, repo.id, { kind: "deploy", limit: 50 }).find(where);
      if (run && (run.state === "ok" || run.state === "failed" || run.state === "cancelled")) return run;
      await Bun.sleep(100);
    }
    throw new Error("run did not settle in time");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-rollout-"));
    a = await bootForge(dataDir);
    const created = await createUser(a.app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await newApp(a.app, alice, { name: "rollme", description: "Rolls", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    repo = made.value.repo;
    await settled(a, (run) => run.env === "production");
    const committed = await commitToBranch(a.app, alice, repo, {
      message: "Echo, slowly",
      files: [
        { path: "src/server.ts", content: SERVER },
        { path: "src/server.test.ts", content: SERVER_TEST },
        { path: "src/audit.test.ts", content: null },
        { path: "src/openapi.test.ts", content: null },
        { path: "src/security.test.ts", content: null },
        { path: "src/site.test.ts", content: null },
      ],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const run = await settled(a, (r) => r.env === "production" && r.commitOid === committed.value.commitOid);
    if (run.state !== "ok") throw new Error(`deploy failed: ${run.summary}`);
  }, 180_000);

  afterAll(async () => {
    for (const forge of [c, b, a]) {
      if (forge === undefined) continue;
      await forge.runtime.stop();
      forge.presence.stop();
      forge.servers.stop();
      forge.app.close();
    }
    health.starting = undefined;
    health.startingSince = undefined;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("its own redeploy: the old version's socket is told to reconnect, its slow answer arrives, and no request sees a 502", async () => {
    const socket = connect(a);
    expect(await socket.opened).toBe(true);
    expect(await socket.echo("before")).toBe("before");
    const before = await (await get(a, "/")).text();

    const stop = { done: false };
    const statuses = loop(() => a, stop);
    const slow = get(a, "/slow");
    // The slow request is with the old version before the new one is asked for.
    await Bun.sleep(200);
    const asked = await redeployEnv(a.app, alice, repo, "production");
    expect(asked.ok).toBe(true);
    const runId = asked.ok ? asked.value?.id : undefined;
    expect(runId).toBeDefined();

    const closed = await socket.closed;
    expect(closed.code).toBe(1012);
    expect(closed.reason).toBe("service restart");
    const again = connect(a);
    expect(await again.opened).toBe(true);
    expect(Date.now() - closed.at).toBeLessThan(RECONNECT_MS * loadScale());
    expect(await again.echo("after")).toBe("after");
    again.ws.close();

    const answered = await slow;
    expect(answered.status).toBe(200);
    expect(await answered.text()).toBe("slow and answered");

    await settled(a, (r) => r.id === runId);
    stop.done = true;
    const seen = await statuses;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((s) => s !== 200)).toEqual([]);
    expect(await (await get(a, "/")).text()).not.toBe(before);
  }, 120_000);

  test("the forge's rollout: the new forge is ready only once the app serves, and a socket reconnects to it in under a second with no 502", async () => {
    const socket = connect(a);
    expect(await socket.opened).toBe(true);
    expect(await socket.echo("held")).toBe("held");

    const stop: { done: boolean; asking?: Promise<unknown> } = { done: false };
    let current: Forge = a;
    const statuses = loop(() => current, stop);

    // The new forge comes up on the same data, as the surge pod does.
    b = await bootForge(dataDir);
    const next = b;
    expect(next.runtime.startingCount()).toBe(1);
    const notYet = await fetch(`${next.servers.url}/readyz`);
    expect(notYet.status).toBe(503);
    expect(await notYet.text()).toBe("starting 1 app");

    const deadline = Date.now() + 90_000;
    while ((await fetch(`${next.servers.url}/readyz`)).status !== 200 && Date.now() < deadline)
      await Bun.sleep(100);
    expect(next.runtime.startingCount()).toBe(0);
    expect((await fetch(`${next.servers.url}/readyz`)).status).toBe(200);
    // Ready means its own copy already answers.
    expect((await get(next, "/")).status).toBe(200);

    // The platform routes to the new forge; the old one stops its apps.
    current = next;
    // The request already sent to the old forge lands first, as the
    // SIGTERM linger in `main.ts` lets it in production (#4496).
    await stop.asking;
    await a.runtime.stop();
    a.presence.stop();
    const closed = await socket.closed;
    expect(closed.code).toBe(1012);
    expect(closed.reason).toBe("service restart");
    const again = connect(next);
    expect(await again.opened).toBe(true);
    expect(Date.now() - closed.at).toBeLessThan(RECONNECT_MS * loadScale());
    expect(await again.echo("reconnected")).toBe("reconnected");
    again.ws.close();

    await Bun.sleep(200);
    stop.done = true;
    const seen = await statuses;
    expect(seen.filter((s) => s !== 200)).toEqual([]);

    // And the restarts board names both causes.
    const ran = runQuery(next.app.db, { source: "restarts", aggregate: "count", groupBy: "cause" }, { repoIds: "all" });
    expect(ran.ok).toBe(true);
    const causes = ran.ok ? ran.rows.map((r) => String(r.group)) : [];
    expect(causes).toContain("forge roll");
    expect(causes).toContain("own deploy");
  }, 180_000);

  test("a cold start, with no forge serving in its place, is ready at once while its app still starts", async () => {
    // The forge before it is gone and said so: nobody serves these apps now.
    const before = b!;
    await before.runtime.stop();
    before.presence.stop();
    before.servers.stop();
    before.app.close();
    b = undefined;

    c = await bootForge(dataDir);
    expect(c.runtime.startingCount()).toBe(1);
    const ready = await fetch(`${c.servers.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.text()).toBe("ok");
  }, 60_000);
});
