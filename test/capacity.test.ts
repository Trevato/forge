/**
 * The forge's capacity changes live, never by restart (#874): an admin
 * lowers check concurrency on the settings page and the next check honours
 * it; the crew's concurrency and the shard count reach the next pick; the
 * egress mode flips report → enforce for the next cell. Nobody but a forge
 * admin reads or changes any of it — not a member, not an agent, not a
 * read-only token — and every change is kept: who, when, from what to what.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { changeCapacity, listCapacity } from "../src/actions/capacity.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { enableApp } from "../src/actions/apps.ts";
import { meterEgress, NPM_REGISTRY, recordEgress, resetEgressTotals, startEgress } from "../src/apps/egress.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import {
  CAPACITY,
  capacityChanges,
  capacityCount,
  capacityDefault,
  noteBooted,
  capacityEnv,
  capacityValue,
  egressSetting,
} from "../src/core/capacity.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { Gate } from "../src/git/env.ts";
import { readHealth } from "../src/actions/health.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";

describe("capacity: only a forge admin reads or changes it", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let agent: User;
  let aliceAdmin: string;
  let aliceRo: string;
  let bobAdmin: string;
  let agentRw: string;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const api = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
        params: { name: "capacity", arguments: args },
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

  // Module loggers reach every forge in the process: each test starts from a quiet ledger.
  beforeEach(() => {
    app.signals.errors.clear();
    app.signals.refused.clear();
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-"));
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
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await createAgent(app, alice, { username: "scout" });
    if (!made.ok) throw new Error(String(made.error));
    agent = made.value.user;
    aliceAdmin = createToken(app.db, alice.id, "t", "admin").token;
    aliceRo = createToken(app.db, alice.id, "t", "ro").token;
    bobAdmin = createToken(app.db, bob.id, "t", "admin").token;
    agentRw = createToken(app.db, agent.id, "t", "rw").token;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("MCP capacity and the page answer the npm registry's bytes over the last hour (#7546)", async () => {
    resetEgressTotals();
    recordEgress("check:r1", NPM_REGISTRY, 3_000_000, 4_000);
    recordEgress("check:r1", "example.com:443", 10, 0);
    const read = await mcp(aliceRo, {});
    expect(read.error).toBe(false);
    const egress = (JSON.parse(read.text) as { egress: { npmBytesLastHour: number; destinations: { destination: string }[] } }).egress;
    expect(egress.npmBytesLastHour).toBe(3_000_000);
    // Other files' proxies share this process's tally; only the order of ours is asserted.
    const named = egress.destinations.map((d) => d.destination);
    expect(named[0]).toBe(NPM_REGISTRY);
    expect(named).toContain("example.com:443");
    const cookie = await login("alice");
    const page = await (await fetch(`${servers.url}/settings/capacity`, { headers: { cookie } })).text();
    // 3,000,000 B / 1024² = 2.86 MiB.
    expect(page).toMatch(/id="egress-npm"[\s\S]*?2\.9 MiB/);
    resetEgressTotals();
  });

  test("MCP capacity and the page name the repository the registry sent most this hour (#8382)", async () => {
    resetEgressTotals();
    const made = await createRepo(app, alice, { name: "npm-heavy", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const meter = meterEgress("check:heavy", made.value.id);
    recordEgress("check:heavy", NPM_REGISTRY, 5 * 1024 * 1024, 0);
    meter.stop();
    const read = await mcp(aliceRo, {});
    const egress = (JSON.parse(read.text) as { egress: { npmTopRepoLastHour: { repo: string; bytes: number } | null } }).egress;
    expect(egress.npmTopRepoLastHour).toEqual({ repo: "alice/npm-heavy", bytes: 5 * 1024 * 1024 });
    const cookie = await login("alice");
    const page = await (await fetch(`${servers.url}/settings/capacity`, { headers: { cookie } })).text();
    expect(page).toMatch(/id="egress-npm"[\s\S]*?alice\/npm-heavy[\s\S]*?5\.0 MiB/);
    resetEgressTotals();
    const none = await mcp(aliceRo, {});
    expect((JSON.parse(none.text) as { egress: { npmTopRepoLastHour: unknown } }).egress.npmTopRepoLastHour).toBeNull();
  });

  test("a member, an agent and nobody are told it is not there, at every door", async () => {
    expect(listCapacity(app, bob).ok).toBe(false);
    expect(listCapacity(app, agent).ok).toBe(false);
    expect(listCapacity(app, undefined).ok).toBe(false);
    expect(changeCapacity(app, bob, "checks.concurrency", "1")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(changeCapacity(app, agent, "checks.concurrency", "1")).toEqual({
      ok: false,
      error: "not_found",
    });

    const bobCookie = await login("bob");
    expect(
      (
        await fetch(`${servers.url}/settings/capacity`, {
          headers: { cookie: bobCookie },
        })
      ).status,
    ).toBe(404);
    const bobPost = await fetch(`${servers.url}/settings/capacity`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: bobCookie,
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ key: "checks.concurrency", value: "9" }),
    });
    expect(bobPost.status).toBe(404);

    for (const token of [bobAdmin, agentRw]) {
      // A person who is not an admin is refused; an agent is told it is not there.
      const refused = token === bobAdmin ? 403 : 404;
      expect((await api(token, "GET", "/admin/capacity")).status).toBe(refused);
      expect(
        (
          await api(token, "PUT", "/admin/capacity/checks.concurrency", {
            value: "9",
          })
        ).status,
      ).toBe(refused);
      const tool = await mcp(token, {
        key: "checks.concurrency",
        value: "9",
        dryRun: false,
      });
      expect(tool.error).toBe(true);
    }
    expect(capacityValue(app.db, "checks.concurrency")).not.toBe("9");
    expect(capacityChanges(app.db)).toEqual([]);
  });

  test("an admin with a read-only token may read, not change", async () => {
    const read = await api(aliceRo, "GET", "/admin/capacity");
    expect(read.status).toBe(200);
    const body = (await read.json()) as { items: unknown[]; changes: unknown[]; next_cursor: null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.next_cursor).toBeNull();
    expect("settings" in body).toBe(false);
    expect(
      (
        await api(aliceRo, "PUT", "/admin/capacity/checks.concurrency", {
          value: "3",
        })
      ).status,
    ).toBe(403);
    const tool = await mcp(aliceRo, {
      key: "checks.concurrency",
      value: "3",
      dryRun: false,
    });
    expect(tool.error).toBe(true);
    expect(capacityChanges(app.db)).toEqual([]);
  });

  test("an admin changes each one from the page, the API and MCP; a wrong value is refused; every change is kept", async () => {
    const cookie = await login("alice");
    const page = await (
      await fetch(`${servers.url}/settings/capacity`, { headers: { cookie } })
    ).text();
    for (const key of [
      "crew.concurrency",
      "checks.concurrency",
      "checks.shards",
      "cells.egress",
    ])
      expect(page).toContain(key);
    // the board strip's errors and internal links land on these anchors
    expect(page).toContain('id="errors"');
    expect(page).toContain('id="internal"');

    const posted = await fetch(`${servers.url}/settings/capacity`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ key: "checks.shards", value: "3" }),
    });
    expect(posted.status).toBe(303);
    expect(capacityEnv(app.db)).toEqual({ FORGE_CHECK_SHARDS: "3" });

    const put = await api(
      aliceAdmin,
      "PUT",
      "/admin/capacity/crew.concurrency",
      { value: "3" },
    );
    expect(put.status).toBe(200);
    expect(capacityValue(app.db, "crew.concurrency")).toBe("3");

    const dry = await mcp(aliceAdmin, { key: "cells.egress", value: "report" });
    expect(dry.error).toBe(false);
    expect(egressSetting(app.db)).toBe("enforce");
    const made = await mcp(aliceAdmin, {
      key: "cells.egress",
      value: "report",
      dryRun: false,
    });
    expect(made.error).toBe(false);
    expect(egressSetting(app.db)).toBe("report");

    for (const [key, value] of [
      ["checks.concurrency", "0"],
      ["checks.concurrency", "1.5"],
      ["checks.shards", "99"],
      ["cells.egress", "off"],
    ] as const)
      expect(
        (await api(aliceAdmin, "PUT", `/admin/capacity/${key}`, { value }))
          .status,
      ).toBe(422);
    expect(
      (
        await api(aliceAdmin, "PUT", "/admin/capacity/apps.anything", {
          value: "1",
        })
      ).status,
    ).toBe(422);

    // Back to the default: the page's reset, then the API's null.
    const reset = await fetch(`${servers.url}/settings/capacity`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ key: "checks.shards", reset: "1" }),
    });
    expect(reset.status).toBe(303);
    // Back at the default, which is sized from the CPUs it is given (#2549).
    const fromEnv = process.env.FORGE_CHECK_SHARDS;
    delete process.env.FORGE_CHECK_SHARDS;
    try {
      expect(capacityEnv(app.db, 80)).toEqual({ FORGE_CHECK_SHARDS: "4" });
      expect(capacityEnv(app.db, 2)).toEqual({ FORGE_CHECK_SHARDS: "2" });
    } finally {
      if (fromEnv !== undefined) process.env.FORGE_CHECK_SHARDS = fromEnv;
    }
    const shardsDefault = capacityDefault("checks.shards");

    const changes = capacityChanges(app.db);
    expect(changes.map((c) => [c.key, c.from, c.to, c.actorName])).toEqual([
      ["checks.shards", "3", shardsDefault, "alice"],
      ["cells.egress", "enforce", "report", "alice"],
      ["crew.concurrency", capacityDefault("crew.concurrency"), "3", "alice"],
      ["checks.shards", shardsDefault, "3", "alice"],
    ]);
    const after = await (
      await fetch(`${servers.url}/settings/capacity`, { headers: { cookie } })
    ).text();
    expect(after).toContain("alice");
  });
});

describe("report mode is loud to admins, and to nobody else", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  // Module loggers reach every forge in the process: each test starts from a quiet ledger.
  beforeEach(() => {
    app.signals.errors.clear();
    app.signals.refused.clear();
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-loud-"));
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
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const page = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return (await fetch(`${servers.url}/settings/capacity`, { headers: { cookie } })).text();
  };
  const needs = (who: User | undefined): string[] =>
    "needs" in readHealth(app, who) ? (readHealth(app, who) as { needs: string[] }).needs : [];

  const signedIn = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const post = (cookie: string, origin: string, body: Record<string, string>): Promise<Response> =>
    fetch(`${servers.url}/settings/capacity`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams(body),
    });

  test("below its ceiling: a lowered crew concurrency is flagged, a cross-origin reset is refused, one reset clears it", async () => {
    const ceiling = Number(capacityDefault("crew.concurrency"));
    expect(ceiling).toBeGreaterThan(1);
    const cookie = await signedIn();
    expect(changeCapacity(app, alice, "crew.concurrency", String(ceiling)).ok).toBe(true);
    expect(await page()).not.toContain("below ceiling");
    expect(changeCapacity(app, alice, "crew.concurrency", "1").ok).toBe(true);
    expect(await page()).toContain(`below ceiling ${ceiling}`);

    const refused = await post(cookie, "https://evil.example", { key: "crew.concurrency", reset: "1" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(capacityValue(app.db, "crew.concurrency")).toBe("1");

    const before = capacityChanges(app.db, 100).length;
    expect((await post(cookie, servers.url, { key: "crew.concurrency", reset: "1" })).status).toBe(303);
    expect(capacityValue(app.db, "crew.concurrency")).toBe(String(ceiling));
    expect(capacityChanges(app.db, 100).length).toBe(before + 1);
    expect(await page()).not.toContain("below ceiling");
  });

  test("reported: the Capacity page says it once, as a note; vitals do not", async () => {
    expect(changeCapacity(app, alice, "cells.egress", "report").ok).toBe(true);
    expect(needs(alice)).toEqual([]);
    const shown = await page();
    expect(shown).toContain('id="egress-reported"');
    expect(shown).not.toMatch(/error-note[^>]*id="egress-reported"/);
    expect(shown.replace(/\s+/g, " ")).toContain("may reach any public host on ports 80 and 443");
  });

  test("the page shows the egress connections an app holds open, and none once they close", async () => {
    const camera = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const front = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const listen = front.port;
    front.stop(true);
    const egress = startEgress(
      { tcp: listen },
      { hosts: [], origins: [{ host: "127.0.0.1", port: camera.port }], label: "app:cam/main" },
    );
    try {
      let reply = "";
      const client = await Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port: listen,
        socket: { data: (_s, c) => void (reply += new TextDecoder().decode(c)) },
      });
      client.write(`CONNECT 127.0.0.1:${camera.port} HTTP/1.1\r\n\r\n`);
      while (!reply.includes("200")) await Bun.sleep(10);
      const shown = (await page()).replace(/\s+/g, " ");
      expect(shown).toContain("app:cam/main");
      expect(shown).toContain(`127.0.0.1:${camera.port}`);
      expect(shown).toContain("1 open");
      expect(shown).toMatch(/\d+ B in · \d+ B out/);
      expect(shown).not.toContain("→ 127.0.0.1");
      egress.close();
      expect(await page()).toContain("No app holds an egress connection open.");
      client.terminate();
    } finally {
      egress.close();
      camera.stop(true);
    }
  });

  test("reported: the public health check, a member and a stranger hear nothing of it", async () => {
    const health = await fetch(`${servers.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    expect(JSON.stringify(readHealth(app, bob))).not.toContain("gress");
    expect(JSON.stringify(readHealth(app, undefined))).not.toContain("gress");
    const api = await (await fetch(`${servers.url}/api/v1/health`)).text();
    expect(api).not.toContain("gress");
  });

  test("away from its default: one muted line with Put back, escaped; none for a default (#3269)", async () => {
    for (const k of ["checks.shards", "cells.egress", "checks.concurrency"]) changeCapacity(app, alice, k, null);
    changeCapacity(app, alice, "crew.concurrency", null);
    const other = capacityDefault("crew.concurrency") === "5" ? "6" : "5";
    expect(changeCapacity(app, alice, "crew.concurrency", other).ok).toBe(true);
    app.db.query("UPDATE forge_setting SET updated_at = ?1 WHERE key = 'crew.concurrency'").run(new Date(Date.now() - 3 * 86_400_000).toISOString());
    app.db.query("UPDATE forge_setting SET updated_by = ?1 WHERE key = 'crew.concurrency'").run(bob.id);
    app.db.query("UPDATE user SET username = ?2 WHERE id = ?1").run(bob.id, "bo<b>b");
    const shown = (await page()).replace(/\s+/g, " ");
    expect(shown).toContain(`changed from <span class="mono">${capacityDefault("crew.concurrency")}</span> 3 days ago by bo&lt;b&gt;b`);
    expect(shown).not.toContain("bo<b>b");
    expect(shown.match(/changed from/g)).toHaveLength(1);
    expect(shown).toContain('<span class="muted small">changed from');
    expect(shown).not.toContain('class="away"');
    expect(shown).toContain(`Put ${CAPACITY["crew.concurrency"].label} back to the default`);
    app.db.query("UPDATE user SET username = 'bob' WHERE id = ?1").run(bob.id);
    expect(changeCapacity(app, alice, "crew.concurrency", null).ok).toBe(true);
    expect(await page()).not.toContain("changed from");
  });

  test("enforced: no warning anywhere", async () => {
    expect(changeCapacity(app, alice, "cells.egress", "enforce").ok).toBe(true);
    expect(await page()).not.toContain('id="egress-reported"');
  });
});

describe("the default shown, and gone back to, is the one the service booted with", () => {
  test("a crew booted at one shows one, and a reset returns it there", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-boot-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const a = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      // What startCrew says for a hosted forge, booted at one.
      noteBooted(app.db, "crew.concurrency", "1");
      const row = () => {
        const listed = listCapacity(app, a.value);
        if (!listed.ok) throw new Error("not listed");
        return listed.value.settings.find((s) => s.key === "crew.concurrency")!;
      };
      expect(row()).toMatchObject({ value: "1", default: "1", source: "default" });
      expect(capacityCount(app.db, "crew.concurrency", 1)).toBe(1);
      const raised = changeCapacity(app, a.value, "crew.concurrency", "3");
      expect(raised.ok && raised.value.from).toBe("1");
      expect(capacityCount(app.db, "crew.concurrency", 1)).toBe(3);
      const reset = changeCapacity(app, a.value, "crew.concurrency", null);
      expect(reset.ok && reset.value.to).toBe("1");
      expect(row()).toMatchObject({ value: "1", source: "default" });
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("a gate takes a new limit while permits are held", () => {
  test("lowered: holders keep theirs, the next waits until the count is under it; raised: waiters go at once", async () => {
    const gate = new Gate(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    gate.resize(1);
    let third = false;
    const c = gate.acquire().then((release) => {
      third = true;
      return release;
    });
    a();
    await Bun.sleep(10);
    expect(third).toBe(false);
    b();
    await Bun.sleep(10);
    expect(third).toBe(true);
    const held = await c;
    let fourth = false;
    const d = gate.acquire().then((release) => {
      fourth = true;
      return release;
    });
    await Bun.sleep(10);
    expect(fourth).toBe(false);
    gate.resize(2);
    await Bun.sleep(10);
    expect(fourth).toBe(true);
    held();
    (await d)();
    expect(gate.stats().active).toBe(0);
  });
});

describe("the next check honours a concurrency the admin lowered, and gets the shard count", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-checks-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // Booted at three at once.
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 3 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
  });

  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lowered to one, three repositories' checks run one at a time; each sees FORGE_CHECK_SHARDS", async () => {
    expect(changeCapacity(app, alice, "checks.concurrency", "1").ok).toBe(true);
    expect(changeCapacity(app, alice, "checks.shards", "2").ok).toBe(true);
    const repos: Repo[] = [];
    for (const name of ["one", "two", "three"]) {
      const made = await createRepo(app, alice, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      repos.push(made.value);
    }
    let most = 0;
    const watch = setInterval(() => {
      const running = repos
        .flatMap((r) => listRuns(app.db, r.id, { kind: "check", limit: 10 }))
        .filter((r) => r.state === "running").length;
      most = Math.max(most, running);
    }, 20);
    try {
      await Promise.all(
        repos.map((repo) =>
          commitToBranch(app, alice, repo, {
            message: "A slow check",
            files: [
              {
                path: "forge.json",
                content: JSON.stringify({
                  check: { run: 'echo "shards=$FORGE_CHECK_SHARDS"; sleep 1' },
                }),
              },
            ],
          }),
        ),
      );
      const deadline = Date.now() + 60_000;
      let done: Run[] = [];
      while (Date.now() < deadline) {
        done = repos
          .flatMap((r) => listRuns(app.db, r.id, { kind: "check", limit: 10 }))
          .filter((r) => r.state === "ok" || r.state === "failed");
        if (done.length === 3) break;
        await Bun.sleep(50);
      }
      expect(done.map((r) => r.state)).toEqual(["ok", "ok", "ok"]);
      expect(most).toBe(1);
      for (const run of done)
        expect(readRunLog(dataDir, run.id).lines).toContain("shards=2");
    } finally {
      clearInterval(watch);
    }
  }, 90_000);
});

describe("the crew's concurrency and shard count reach the next pick", () => {
  test("raised from one to two at boot's one, two agents run at once; each shell is told the shards", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-crew-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s","model":"fake"}'
echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"shards=$FORGE_CHECK_SHARDS\\"}]}}"
sleep 2
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
`,
    );
    chmodSync(fake, 0o755);
    const crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    try {
      const a = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      const alice = a.value;
      expect(changeCapacity(app, alice, "crew.concurrency", "2").ok).toBe(true);
      expect(changeCapacity(app, alice, "checks.shards", "4").ok).toBe(true);
      const created = await createRepo(app, alice, {
        name: "garden",
        visibility: "private",
      });
      if (!created.ok) throw new Error(String(created.error));
      const repo = created.value;
      const seeded = await commitToBranch(app, alice, repo, {
        message: "Start",
        files: [{ path: "README.md", content: "# garden\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      for (const name of ["bot", "bee"]) {
        const made = await createAgent(app, alice, {
          username: name,
          brief: "Be brief.",
        });
        if (!made.ok) throw new Error(String(made.error));
        expect(addToCrew(app, alice, repo, name).ok).toBe(true);
        const issue = openIssue(app, alice, repo, {
          title: `Plant ${name}`,
          body: "Along the fence.",
        });
        if (!issue.ok) throw new Error(String(issue.error));
        expect(
          assignIssue(app, alice, repo, issue.value, made.value.user).ok,
        ).toBe(true);
      }
      let most = 0;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const runs = listRuns(app.db, repo.id, { kind: "agent" });
        most = Math.max(most, runs.filter((r) => r.state === "running").length);
        if (
          runs.length === 2 &&
          runs.every((r) => r.state !== "running" && r.state !== "queued")
        )
          break;
        await Bun.sleep(25);
      }
      expect(most).toBe(2);
      for (const run of listRuns(app.db, repo.id, { kind: "agent" }))
        expect(readRunLog(dataDir, run.id).lines.join("\n")).toContain(
          "shards=4",
        );
    } finally {
      await crew.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the egress mode is the emergency lever: the next cell starts with what the admin set", () => {
  test("report → enforce reaches the next start's cell without a restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-egress-"));
    const app = createApp({ dataDir, port: 0 });
    const runtime = new AppsRuntime(app, {
      domain: "cap.test",
      scheme: "http",
      publicPort: 80,
      forgeUrl: "http://127.0.0.1:1",
      concurrency: 1,
    });
    try {
      const a = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      const alice = a.value;
      const made = await createRepo(app, alice, {
        name: "notes",
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      const record = enableApp(app, alice, made.value, { slug: "notes" });
      if (!record.ok) throw new Error(String(record.error));
      // A runtime that can hold cells is asked; one that cannot has none to start.
      (runtime as unknown as { cells: { ok: true } }).cells = { ok: true };
      expect(changeCapacity(app, alice, "cells.egress", "report").ok).toBe(
        true,
      );
      expect(runtime.cellFor(record.value, "production")?.egressMode).toBe(
        "report",
      );
      expect(changeCapacity(app, alice, "cells.egress", "enforce").ok).toBe(
        true,
      );
      expect(runtime.cellFor(record.value, "production")?.egressMode).toBe(
        "enforce",
      );
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
