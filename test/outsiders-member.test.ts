/**
 * The outsider suite's member actor (#2305, the last part of #673). A member
 * is trusted to build, not to take over: each takeover path is tried as one
 * and each is refused — the forge's data, secret key and environment from an
 * app, a check and a crew shell; the forge's own model credential; a token
 * wider than the member's own; another account's repository.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { cellsAvailable } from "../src/apps/contain.ts";
import { envDir } from "../src/apps/data.ts";
import { childEnv } from "../src/apps/process.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { ADMIN_TOKEN_WORDS, createToken } from "../src/core/tokens.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { getUsage } from "../src/core/usage.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { readRunLog } from "../src/runs/log.ts";
import { expectContained, probeSource } from "./helpers/cell-probe.ts";
import { agentRunSettled, startStandInCrew, stopStandInCrew } from "./helpers/crew-standin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { missing } from "./helpers/tools.ts";

quietLogs();

const PASS = "a-long-member-passphrase";
const CANARY = `forge-canary-${crypto.randomUUID()}`;

// Cells bind unix sockets, which a port-mode sandbox refuses; the forge's check runs them.
const noCells =
  process.env["FORGE_CELLS"] === "off" ||
  missing("bwrap", "socat") ||
  process.platform !== "linux" ||
  portInsteadOfSocket();

describe("the member actor", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let olive: User;
  let mallory: User;
  let malloryToken = "";
  let ledger: Repo;
  let listener: ReturnType<typeof Bun.serve>;
  let runtime: AppsRuntime;
  let checks: ChecksHandle;

  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${malloryToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    });

  beforeAll(async () => {
    process.env["FORGE_TEST_CANARY"] = CANARY;
    dataDir = await mkdtemp(join(tmpdir(), "forge-outsiders-member-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const seeded = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: PASS });
    if (!seeded.ok) throw new Error(seeded.error);
    olive = seeded.value;
    const made = await signUp(app, { username: "mallory", email: "mallory@f.dev", password: PASS }, { slot: fixtureSlot(app) });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    mallory = getUserByName(app.db, "mallory")!;
    malloryToken = createToken(app.db, mallory.id, "t", "rw").token;
    const theirs = await createRepo(app, olive, { name: "ledger", visibility: "public" });
    if (!theirs.ok) throw new Error(String(theirs.error));
    ledger = theirs.value;
    const seed = await commitToBranch(app, olive, ledger, {
      message: "Start",
      files: [{ path: "README.md", content: "# ledger\n" }],
    });
    if (!seed.ok) throw new Error(JSON.stringify(seed.error));
    if (!noCells) {
      runtime = new AppsRuntime(app, {
        domain: "member.test",
        scheme: "http",
        publicPort: servers.port,
        forgeUrl: servers.url,
        concurrency: 2,
      });
      await runtime.start();
      checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
      listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("inside") });
    }
  }, 60_000);

  afterAll(async () => {
    delete process.env["FORGE_TEST_CANARY"];
    await checks?.stop();
    await runtime?.stop();
    listener?.stop(true);
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("reads the forge's data, key and environment", () => {
    test("from a crew shell: every entry of the data directory but crew/ is denied, and the environment is cut", () => {
      for (const dir of ["repos/olive", "apps/01app/production", "checks/01c", "crew/scout/01r/1"])
        mkdirSync(join(dataDir, dir), { recursive: true });
      writeFileSync(join(dataDir, "secret.key"), "x");
      const { denyRead } = sandboxPolicy({ dataDir, agentName: "scout", urls: [], runId: "01m46abcdefghjkmnpqrstvwxy" });
      const denied = (p: string) => denyRead.some((d) => p === d || p.startsWith(`${d}/`));
      for (const entry of ["forge.db", "secret.key", "repos", "apps", "checks"])
        expect([entry, denied(join(dataDir, entry))]).toEqual([entry, true]);
      expect(denied(join(dataDir, "crew/scout/01r/1"))).toBe(false);
      // What a shell, a check or an app starts from names no forge secret.
      const env = childEnv({});
      expect(JSON.stringify(env)).not.toContain(CANARY);
      expect(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/.test(k))).toEqual([]);
    });

    test.skipIf(noCells)("from an app, its preview and a check: each is refused, the forge still answers", async () => {
      expect(await cellsAvailable()).toEqual({ ok: true });
      const made = await createRepo(app, mallory, { name: "probe", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;
      // Another tenant's app data: there is something to steal.
      const theirs = join(envDir(dataDir, "01other", "production"), "data");
      mkdirSync(theirs, { recursive: true });
      writeFileSync(join(theirs, "books.txt"), "private");
      const committed = await commitToBranch(app, mallory, repo, {
        message: "A probe",
        files: [
          {
            path: "forge.json",
            content: JSON.stringify({
              egress: ["localhost"],
              app: { run: "bun probe.ts serve", health: "/" },
              check: { run: "bun probe.ts check", timeout: 120 },
            }),
          },
          {
            path: "probe.ts",
            content: probeSource({
              dataDir,
              otherAppDir: envDir(dataDir, "01other", "production"),
              canary: CANARY,
              listenerPort: listener.port ?? 0,
              forgePid: process.pid,
            }),
          },
        ],
      });
      if (!committed.ok) throw new Error(JSON.stringify(committed.error));
      const record = enableApp(app, mallory, repo, { slug: "probe" });
      if (!record.ok) throw new Error(String(record.error));

      const settled = async (kind: "deploy" | "check"): Promise<Run> => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const run = listRuns(app.db, repo.id, { kind, limit: 50 }).find((r) => r.commitOid === committed.value.commitOid);
          if (run && ["ok", "failed", "cancelled"].includes(run.state)) return run;
          await Bun.sleep(100);
        }
        throw new Error(`${kind} did not settle`);
      };
      const deploy = await settled("deploy");
      expect(deploy.state).toBe("ok");
      expect(deploy.sandboxEnforced).toBe(true);
      const fromApp = await fetch(`${servers.url}/probe`, {
        headers: { host: new URL(runtime.urlFor(record.value, "production")).host },
      });
      expectContained((await fromApp.json()) as Record<string, string>);

      const check = await settled("check");
      expect(check.state).toBe("ok");
      expect(check.sandboxEnforced).toBe(true);
      const line = readRunLog(dataDir, check.id).lines.find((l) => l.startsWith("PROBE "));
      expect(line).toBeDefined();
      expectContained(JSON.parse(line!.slice(6)) as Record<string, string>);
    }, 240_000);
  });

  describe("widens a token", () => {
    test("minting admin scope is a 403 in one sentence; an rw token reaches no admin door", async () => {
      const minted = (scope: string) =>
        fetch(`${servers.url}/api/v1/tokens`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "mallory", password: PASS, name: "w", scope, adminConfirm: true }),
        });
      const denied = await minted("admin");
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { message: string }).message).toBe(ADMIN_TOKEN_WORDS);
      expect((await call("/api/v1/admin/accounts")).status).toBe(403);
      expect((await call("/api/v1/admin/accounts/olive/suspend", { method: "POST" })).status).toBe(403);
      expect(getUserByName(app.db, "olive")!.suspendedAt).toBeFalsy();
    });
  });

  describe("pushes to or administers another account's repository", () => {
    test("a push, a commit over the API, a settings change and a delete are all refused, and the repository is as it was", async () => {
      const before = JSON.stringify(getRepo(app.db, "olive", "ledger"));
      const basic = `Basic ${btoa(`mallory:${malloryToken}`)}`;
      const adv = await fetch(`${servers.url}/olive/ledger.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: basic },
      });
      expect(adv.status).toBeGreaterThanOrEqual(401);
      expect(adv.status).toBeLessThan(500);
      const tries: [string, string, unknown?][] = [
        ["POST", "/api/v1/repos/olive/ledger/contents", { message: "mine", files: [{ path: "README.md", content: "owned\n" }] }],
        ["PATCH", "/api/v1/repos/olive/ledger", { description: "owned", visibility: "private" }],
        ["DELETE", "/api/v1/repos/olive/ledger"],
      ];
      for (const [method, path, json] of tries) {
        const res = await call(path, { method, ...(json === undefined ? {} : { json }) });
        expect([method, path, [403, 404].includes(res.status)]).toEqual([method, path, true]);
      }
      expect(JSON.stringify(getRepo(app.db, "olive", "ledger"))).toBe(before);
    });
  });
});

describe("the member actor and the forge's own model credential", () => {
  test("a member's repository run never starts an agent with it, and spends nothing", async () => {
    const standIn = await startStandInCrew();
    process.env["ANTHROPIC_API_KEY"] = "sk-forge-own-token";
    try {
      const { app, alice, bot, repo } = standIn;
      app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(alice.id);
      promote(app.db, alice);
      const issue = openIssue(app, alice, repo, { title: "Prune the roses", body: "Before spring." });
      if (!issue.ok) throw new Error(String(issue.error));
      expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
      const run = await agentRunSettled(app, repo, (r) => r.issueId === issue.value.id);
      expect(run.state).toBe("failed");
      expect(run.summary).toContain("This repository has no model account: ask an admin to grant one");
      expect(existsSync(standIn.argsFile)).toBe(false);
      expect(getUsage(app.db, run.id)?.costUsd ?? 0).toBe(0);
      expect(run.costUsd).toBe(0);
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
      await stopStandInCrew(standIn);
    }
  }, 90_000);
});
