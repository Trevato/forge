/**
 * A proxied answer keeps the app's Server-Timing and appends the forge's own
 * phases, `forge-` named: where a slow request spent its time.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { deploySettled } from "./helpers/apps-forge.ts";

const DOMAIN = "apps.test";
// node:http, not Bun.serve: Bun drops a streamed Response's content-length,
// and /slowbody needs one so the forge reads the page whole however slow.
const SLOW = `import { createServer } from "node:http";
createServer((request, res) => {
  const path = new URL(request.url, "http://app").pathname;
  if (path === "/healthz") {
    setTimeout(() => {
      res.writeHead(200, { "server-timing": "db;dur=0.1, app;dur=1.1" });
      res.end("ok");
    }, 300);
  } else if (path === "/ttfb") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("late");
    }, 30);
  } else if (path === "/slowbody") {
    // Headers at once, the page's end 300 ms later: the wait is the body's.
    const head = "<html><body><h1>slow";
    const tail = " body</h1></body></html>";
    res.writeHead(200, { "content-type": "text/html", "content-length": String(head.length + tail.length) });
    res.write(head);
    setTimeout(() => res.end(tail), 300);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><h1>hello</h1></body></html>");
  }
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const dur = (header: string, name: string): number | undefined => {
  const m = new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(header);
  return m ? Number(m[1]) : undefined;
};

describe("a proxied answer's Server-Timing", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;

  const viaHost = (path = "/") =>
    fetch(`${servers.url}${path}`, { headers: { host: `hello.${DOMAIN}`, accept: "text/html" }, redirect: "manual" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ptiming-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await newApp(app, alice, { name: "hello", description: "d", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    const first = await deploySettled(app, repo.id, (r) => r.env === "production");
    expect(first.state).toBe("ok");
    const committed = await commitToBranch(app, alice, repo, {
      branch: repo.defaultBranch,
      base: repo.defaultBranch,
      message: "Slow healthz",
      files: [
        { path: "src/slow.ts", content: SLOW },
        {
          path: "forge.json",
          content: JSON.stringify({ app: { run: "bun run src/slow.ts", health: "/" } }),
        },
      ],
    });
    expect(committed.ok).toBe(true);
    const second = await deploySettled(app, repo.id, (r) => r.env === "production" && r.id !== first.id);
    expect(second.state).toBe("ok");
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a slow upstream shows in forge-upstream, beside the app's own entries", async () => {
    const res = await viaHost("/healthz");
    expect(res.status).toBe(200);
    const header = res.headers.get("server-timing")!;
    expect(header.startsWith("db;dur=0.1, app;dur=1.1, ")).toBe(true);
    expect(dur(header, "forge-upstream")!).toBeGreaterThanOrEqual(250);
    expect(dur(header, "forge-route")).toBeDefined();
    expect(dur(header, "forge-wake")).toBe(0);
    // Durations only: nothing of the host or the app's name.
    expect(header).toMatch(/^[a-z0-9.;=, -]+$/);
    expect(header).not.toContain("hello");
  });

  test("an app slow to its headers shows in forge-ttfb, which is forge-upstream", async () => {
    const res = await viaHost("/ttfb");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("late");
    const header = res.headers.get("server-timing")!;
    expect(dur(header, "forge-ttfb")!).toBeGreaterThanOrEqual(30);
    expect(dur(header, "forge-ttfb")).toBe(dur(header, "forge-upstream")!);
    // No probe socket: the connect is inside ttfb, never named apart.
    expect(dur(header, "forge-connect")).toBeUndefined();
    expect(header).toMatch(/^[a-z0-9.;=, -]+$/);
  });

  test("forge-route splits into forge-lookup, forge-state and forge-session", async () => {
    const header = (await viaHost("/healthz")).headers.get("server-timing")!;
    const parts = ["forge-lookup", "forge-state", "forge-session"].map((name) => dur(header, name));
    for (const ms of parts) expect(ms).toBeGreaterThanOrEqual(0);
    const sum = parts.reduce((a, b) => a! + b!, 0)!;
    expect(Math.abs(sum - dur(header, "forge-route")!)).toBeLessThanOrEqual(0.2);
  });

  test("a page read whole for the pill names the wait for its body, forge-body", async () => {
    const header = (await viaHost("/")).headers.get("server-timing")!;
    expect(dur(header, "forge-body")).toBeGreaterThanOrEqual(0);
    expect(dur(header, "forge-body")!).toBeLessThanOrEqual(dur(header, "forge-rewrite")!);
  });

  test("a page whose body comes late puts the wait in forge-body, not forge-ttfb", async () => {
    const res = await viaHost("/slowbody");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("slow body");
    const header = res.headers.get("server-timing")!;
    expect(dur(header, "forge-body")!).toBeGreaterThanOrEqual(250);
    expect(dur(header, "forge-ttfb")!).toBeLessThan(dur(header, "forge-body")!);
    expect(dur(header, "forge-upstream")!).toBeLessThan(dur(header, "forge-body")!);
  });

  test("a page the pill is written into names forge-rewrite", async () => {
    const res = await viaHost("/");
    const header = res.headers.get("server-timing")!;
    expect(dur(header, "forge-rewrite")).toBeDefined();
  });

  /** Make the next request find the environment asleep, and its wake take `ms`. */
  const asleepOnce = (ms: number, after: "awake" | "asleep") => {
    const status = runtime.envStatus.bind(runtime);
    const wake = runtime.wake.bind(runtime);
    let woke = false;
    runtime.envStatus = (record, env) =>
      woke && after === "awake" ? status(record, env) : ({ ...status(record, env)!, state: "asleep", port: undefined } as EnvStatus);
    runtime.wake = async () => {
      await Bun.sleep(ms);
      woke = true;
      return undefined;
    };
    return () => {
      runtime.envStatus = status;
      runtime.wake = wake;
    };
  };

  test("a request that wakes the environment names the wait in forge-wake", async () => {
    const restore = asleepOnce(150, "awake");
    try {
      const res = await viaHost("/healthz");
      expect(res.status).toBe(200);
      const header = res.headers.get("server-timing")!;
      expect(dur(header, "forge-wake")!).toBeGreaterThanOrEqual(140);
      expect(dur(header, "forge-upstream")!).toBeGreaterThanOrEqual(250);
    } finally {
      restore();
    }
  });

  test("a refused answer after a wake names no phases: the wait would say it was asleep", async () => {
    const restore = asleepOnce(50, "asleep");
    try {
      const res = await viaHost("/healthz");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("server-timing") ?? "").not.toContain("forge-");
    } finally {
      restore();
    }
  });

  /**
   * Point the next requests at a fake upstream on a raw socket that answers
   * `reply` to whatever it is sent and closes.
   */
  const fakeUpstream = (reply: string) => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          if (reply !== "") socket.write(reply);
          socket.end();
        },
      },
    });
    const status = runtime.envStatus.bind(runtime);
    runtime.envStatus = (record, env) => ({ ...status(record, env)!, port: listener.port }) as EnvStatus;
    return () => {
      runtime.envStatus = status;
      listener.stop(true);
    };
  };

  const stoppedAnswering = async (res: Response) => {
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).toContain("stopped answering");
    const header = res.headers.get("server-timing")!;
    for (const name of ["forge-route", "forge-wake", "forge-upstream"]) expect(dur(header, name)).toBeDefined();
  };

  test("an upstream that closes without answering: 'stopped answering' with the forge's phases", async () => {
    const restore = fakeUpstream("");
    try {
      await stoppedAnswering(await viaHost("/"));
    } finally {
      restore();
    }
  });

  test("a page that breaks off mid-body: 'stopped answering' with the forge's phases", async () => {
    const restore = fakeUpstream(
      "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 1000\r\n\r\n<html><body>",
    );
    try {
      await stoppedAnswering(await viaHost("/"));
    } finally {
      restore();
    }
  });
});
