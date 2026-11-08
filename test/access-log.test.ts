/**
 * What outside agents tried (#1061): one compact line per request that is
 * not a static asset, with no token, cookie, query string or address in it,
 * kept 14 days and size-capped, and readable only by a forge admin through
 * Settings → Access and the `access` MCP tool (write scope).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import {
  accessDir,
  clientHash,
  DAY_BYTES,
  unwrittenFor,
  SILENT_AFTER_S,
  flushAccess,
  keptPath,
  prune,
  readAccess,
  recordAccess,
} from "../src/http/access_log.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { serve, type Servers } from "../src/http/server.ts";

const logText = (dir: string): string => {
  flushAccess();
  return readdirSync(accessDir(dir))
    .map((f) => readFileSync(join(accessDir(dir), f), "utf8"))
    .join("");
};

describe("the access log", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let adminRw: string;
  let adminRo: string;
  let bobRw: string;

  const mcp = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "access", arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return {
      error: body.result.isError === true,
      text: body.result.content[0]!.text,
    };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-access-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("users");
    adminRw = createToken(app.db, a.value.id, "t", "rw").token;
    adminRo = createToken(app.db, a.value.id, "t", "ro").token;
    bobRw = createToken(app.db, b.value.id, "t", "rw").token;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a replayed agent request is kept, redacted, and read back", async () => {
    const secret = "forge_SECRETTOKENVALUE0123456789abcdef";
    await fetch(`${servers.url}/api/v1/nothing-here?token=${secret}&q=hunter2`, {
      headers: {
        "user-agent": "ExampleAgent/1.0 (+https://example.test)",
        authorization: `Bearer ${secret}`,
        cookie: "forge_session=COOKIEVALUE123; other=zzz",
      },
    });
    await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "user-agent": "ExampleAgent/1.0" },
      body: "{}",
    });
    // A browser and a static asset are not what this reads.
    await fetch(`${servers.url}/issues`, {
      headers: { "user-agent": "Mozilla/5.0 (X11) Firefox/130" },
    });
    await fetch(`${servers.url}/assets/missing.css`);

    const raw = logText(dataDir);
    for (const leak of [secret, "SECRETTOKENVALUE", "hunter2", "COOKIEVALUE", "zzz", "q=", "127.0.0.1"])
      expect(raw).not.toContain(leak);
    expect(raw).not.toContain("assets");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const hit = lines.find((l) => l.path === "/api/v1/nothing-here");
    expect(hit).toMatchObject({
      method: "GET",
      status: 404,
      auth: true,
      ua: "ExampleAgent/1.0 (+https://example.test)",
    });
    expect(hit.who).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof hit.ms).toBe("number");

    const read = await mcp(adminRw, { ua: "exampleagent" });
    expect(read.error).toBe(false);
    const rows = JSON.parse(read.text).requests as { path: string; ua: string }[];
    expect(rows.map((r) => r.path)).toContain("/api/v1/nothing-here");
    expect(rows.every((r) => !r.ua.includes("Mozilla"))).toBe(true);
    const narrow = JSON.parse((await mcp(adminRw, { path: "/mcp" })).text).requests;
    expect(narrow.every((r: { path: string }) => r.path.startsWith("/mcp"))).toBe(true);
    expect(narrow.length).toBeGreaterThan(0);
  });

  test("a path never carries a secret-looking segment or a long line", () => {
    expect(keptPath("/claim/abcdefghijklmnopqrstuvwxyz0123")).toBe("/claim/:redacted");
    expect(keptPath("/x/forge_abc")).toBe("/x/:redacted");
    expect(keptPath("/issues/12")).toBe("/issues/12");
    expect(keptPath("/a\n/b" + "c".repeat(500)).length).toBeLessThanOrEqual(200);
    expect(keptPath("/a\nb")).not.toContain("\n");
  });

  test("only an admin with write scope reads it, on the page and by MCP", async () => {
    expect((await mcp(adminRo, {})).error).toBe(true);
    expect((await mcp(adminRo, {})).text).toContain("forbidden");
    const bob = await mcp(bobRw, {});
    expect(bob.error).toBe(true);
    expect(bob.text).toContain("not_found");
    const anon = await fetch(`${servers.url}/settings/access`, { redirect: "manual" });
    expect(anon.status).not.toBe(200);
  });

  test("the settings page lists what was tried, escaped", async () => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await fetch(`${servers.url}/api/v1/x`, {
      headers: { "user-agent": "<script>alert(1)</script>-bot" },
    });
    const page = await fetch(`${servers.url}/settings/access`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Outside requests");
    expect(html).toContain("/api/v1/nothing-here");
    expect(html).not.toContain("<script>alert(1)</script>-bot");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the access log's keeping", () => {
  test("files older than 14 days go, and the directory stays under its cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-access-rot-"));
    try {
      const keep = accessDir(dir);
      mkdirSync(keep, { recursive: true });
      writeFileSync(join(keep, "access-2026-09-01.log"), "old\n");
      writeFileSync(join(keep, "access-2026-09-30.log"), "recent\n");
      const now = new Date("2026-10-13T12:00:00Z");
      prune(dir, now);
      expect(readdirSync(keep)).toEqual(["access-2026-09-30.log"]);
      // Over the cap: the oldest goes first, today's file always stays.
      const cap = 1024;
      const big = "x".repeat(cap / 2 + 1);
      writeFileSync(join(keep, "access-2026-10-10.log"), big);
      writeFileSync(join(keep, "access-2026-10-11.log"), big);
      writeFileSync(join(keep, "access-2026-10-13.log"), "today\n");
      prune(dir, now, cap);
      expect(readdirSync(keep).sort()).toEqual([
        "access-2026-10-11.log",
        "access-2026-10-13.log",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recording prunes on a new day, and the hash changes with the day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-access-day-"));
    try {
      const seen = (path: string) => ({
        request: new Request(`http://forge.test${path}?k=v`, {
          headers: { "user-agent": "bot" },
        }),
        status: 200,
        ms: 3.4,
        client: "203.0.113.9",
      });
      mkdirSync(accessDir(dir), { recursive: true });
      writeFileSync(join(accessDir(dir), "access-2026-09-01.log"), "old\n");
      recordAccess(dir, seen("/llms.txt"), new Date("2026-10-13T01:00:00Z"));
      recordAccess(dir, seen("/llms.txt"), new Date("2026-10-14T01:00:00Z"));
      // Batched: a request has only queued its line.
      expect(readdirSync(accessDir(dir))).toEqual(["access-2026-09-01.log"]);
      flushAccess(new Date("2026-10-14T01:00:00Z"));
      expect(readdirSync(accessDir(dir)).sort()).toEqual([
        "access-2026-10-13.log",
        "access-2026-10-14.log",
      ]);
      const [a, b] = readdirSync(accessDir(dir))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(accessDir(dir), f), "utf8")));
      expect(a.who).not.toBe(b.who);
      expect(logText(dir)).not.toContain("203.0.113.9");
      const rows = readAccess(dir, { since: "2026-10-13T00:00:00Z" }, new Date("2026-10-14T02:00:00Z"));
      expect(rows.map((r) => r.path)).toEqual(["/llms.txt", "/llms.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the access log and app hostnames", () => {
  test("an app's own traffic, and a name nobody holds, are not the forge's access", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-access-apps-"));
    const app = createApp({ dataDir, port: 0, host: "forge.test" });
    const servers = await serve(app);
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    try {
      await runtime.start();
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      const made = await newApp(app, u.value, {
        name: "notes",
        description: "",
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      const ask = (host: string, path: string) =>
        fetch(`${servers.url}${path}`, {
          headers: { host, "user-agent": "VisitorBot/1.0" },
        });
      await ask("notes.apps.test", "/api/visitor-of-the-app");
      await ask("nosuch.apps.test", "/api/nobody-home");
      await ask("forge.test", "/api/the-forge-itself");
      const lines = logText(dataDir)
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => l.path)).toEqual(["/api/the-forge-itself"]);
      expect(lines[0].who).not.toBe(clientHash(dataDir, "unknown", new Date()));
    } finally {
      await runtime.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("the access log never goes silent (#6841)", () => {
  const seen = (path: string) => ({
    request: new Request(`http://forge.test${path}`),
    status: 200,
    ms: 1,
    client: "1.2.3.4",
  });

  test("two writers append to one day's file, and a day rollover keeps writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "access-silent-"));
    try {
      const day1 = new Date("2026-10-27T23:59:59Z");
      const day2 = new Date("2026-10-28T00:00:01Z");
      recordAccess(dir, seen("/issues/a"), day1);
      flushAccess(day1);
      // a new pod: same directory, its own first request
      recordAccess(dir, seen("/issues/b"), day1);
      flushAccess(day1);
      recordAccess(dir, seen("/issues/c"), day2);
      flushAccess(day2);
      const files = readdirSync(accessDir(dir)).sort();
      expect(files).toEqual(["access-2026-10-27.log", "access-2026-10-28.log"]);
      const first = readFileSync(join(accessDir(dir), files[0]!), "utf8");
      expect(first.trim().split("\n")).toHaveLength(2);
      expect(readFileSync(join(accessDir(dir), files[1]!), "utf8")).toContain("/issues/c");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a day's file at its cap sheds its older half and keeps appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "access-cap-"));
    try {
      const at = new Date("2026-10-27T10:00:00Z");
      mkdirSync(accessDir(dir), { recursive: true });
      const file = join(accessDir(dir), "access-2026-10-27.log");
      const filler = `${JSON.stringify({ t: "x", path: "/old" })}\n`;
      writeFileSync(file, filler.repeat(Math.ceil(DAY_BYTES / filler.length) + 1));
      recordAccess(dir, seen("/issues/new"), at);
      flushAccess(at);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("/issues/new");
      expect(text.length).toBeLessThan(DAY_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a line that cannot land is kept as unwritten until one does; an idle forge has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "access-ago-"));
    try {
      flushAccess();
      expect(unwrittenFor()).toBeUndefined();
      // the access dir is a file: every append fails
      writeFileSync(accessDir(dir), "not a directory");
      const at = new Date();
      recordAccess(dir, seen("/issues/x"), at);
      flushAccess(at);
      expect(unwrittenFor(at.getTime() + 600_000)).toBeGreaterThan(SILENT_AFTER_S);
      await rm(accessDir(dir));
      recordAccess(dir, seen("/issues/y"), at);
      flushAccess(at);
      expect(unwrittenFor()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
