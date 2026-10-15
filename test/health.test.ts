import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  health,
  liveResponse,
  readyResponse,
  startDraining,
} from "../src/http/health.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Log, LogFields } from "../src/kernel/log.ts";

/** A log that keeps its lines, so a test can read what was said. */
function recordingLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  const say = (level: string) => (message: string, fields?: LogFields) =>
    lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, debug: say("debug"), info: say("info"), warn: say("warn"), error: say("error") };
}

function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // a query that holds the thread, as a busy SQLite does
  }
}

afterEach(() => {
  health.draining = false;
});

describe("liveness: /healthz", () => {
  test("a slow database query is still alive", () => {
    const log = recordingLog();
    const started = Date.now();
    const res = liveResponse(() => blockFor(200), log);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(res.status).toBe(200);
    expect(log.lines).toEqual([]);
  });

  test("a database that does not answer is 503, said once, and its return said once", async () => {
    const log = recordingLog();
    const broken = () => {
      throw new Error("database is locked");
    };
    const first = liveResponse(broken, log);
    expect(first.status).toBe(503);
    expect(await first.text()).toBe("database");
    expect(liveResponse(broken, log).status).toBe(503);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("/healthz answers 503");
    expect(log.lines[0]).toContain("database is locked");
    expect(liveResponse(() => 1, log).status).toBe(200);
    expect(log.lines).toHaveLength(2);
    expect(log.lines[1]).toContain("alive again");
  });

  test("draining is not dead: liveness stays 200 through a drain", () => {
    startDraining(recordingLog(), "SIGTERM");
    expect(liveResponse(() => 1, recordingLog()).status).toBe(200);
  });
});

describe("readiness: /readyz", () => {
  test("ready until a shutdown; then 503, with one log line that says why", async () => {
    expect(readyResponse().status).toBe(200);
    const log = recordingLog();
    startDraining(log, "SIGTERM", { sshSessions: 2 });
    const res = readyResponse();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("draining");
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("/readyz answers 503");
    expect(log.lines[0]).toContain('"why":"SIGTERM"');
    expect(log.lines[0]).toContain('"sshSessions":2');
    // A second signal during the drain says nothing new.
    startDraining(log, "SIGINT");
    expect(log.lines).toHaveLength(1);
  });
});

describe("the served paths", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-health-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a slow database query (fake) does not turn /healthz into 503", async () => {
    const db = app.db as unknown as { query: (sql: string) => unknown };
    const query = db.query;
    db.query = (sql: string) => {
      blockFor(150);
      return query.call(app.db, sql);
    };
    try {
      const res = await fetch(`${servers.url}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      db.query = query;
    }
  });

  test("a drain turns /readyz into 503; /healthz and the landing page stay up", async () => {
    expect((await fetch(`${servers.url}/readyz`)).status).toBe(200);
    startDraining(recordingLog(), "SIGTERM");
    const ready = await fetch(`${servers.url}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.text()).toBe("draining");
    expect((await fetch(`${servers.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${servers.url}/`)).status).toBe(200);
  });

  test("HEAD /readyz is 200 with an empty body", async () => {
    const head = await fetch(`${servers.url}/readyz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
