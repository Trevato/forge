/**
 * The shell sandbox is policy the host may or may not be able to hold a
 * run to. Where it cannot, the settings handed to Claude Code say so
 * plainly, so a run reads "unsandboxed" once instead of warning on every
 * command and running anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun, getRun, noteRunProgress } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { sandboxLine } from "../src/web/studio/sandbox.ts";
import {
  fetchInternal,
  internalRequest,
  tcpAddress,
} from "../src/git/hook-address.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { listRuns } from "../src/core/runs.ts";
import { serve } from "../src/http/server.ts";
import { readFileSync } from "node:fs";
import { claudeSettings } from "../src/crew/claude.ts";
import {
  SANDBOX_LINES,
  systemPrompt,
  type BriefInput,
} from "../src/crew/brief.ts";
import { LOOPBACK, probe } from "../scripts/sandbox-probe.ts";
import {
  dataInTemp,
  SandboxListingError,
  sandboxAvailable,
  runTmpDir,
  sandboxPolicy,
  sweepRunTmp,
} from "../src/crew/sandbox.ts";

describe("the shell sandbox", () => {
  const input = {
    dataDir: "/tmp/forge-sandbox-test",
    agentName: "scout",
    urls: ["http://localhost:3000"],
  };

  test("allows loopback by the forge's port, never whole", () => {
    const hosts = sandboxPolicy({
      ...input,
      urls: ["http://127.0.0.1:3000", "https://forge.example.com"],
    }).allowHosts;
    expect(hosts).toContain("127.0.0.1:3000");
    expect(hosts).toContain("forge.example.com");
    expect(hosts).not.toContain("127.0.0.1");
    expect(hosts).not.toContain("localhost");
    expect(sandboxPolicy(input).allowHosts).toContain("localhost:3000");
  });

  test("is enforced unless the host says it cannot", () => {
    expect(sandboxPolicy(input).enforced).toBe(true);
    expect(sandboxPolicy({ ...input, enforced: false }).enforced).toBe(false);
  });

  test("allows loopback as the forge's host:port alone", () => {
    const hosts = sandboxPolicy({
      ...input,
      urls: ["http://localhost:3000", "https://forge.example.org"],
    }).allowHosts;
    expect(hosts).toContain("localhost:3000");
    expect(hosts).toContain("forge.example.org");
    expect(hosts).not.toContain("localhost");
    expect(hosts).not.toContain("127.0.0.1");
  });

  test("is switched off in Claude Code's settings where it cannot be held", () => {
    const on = claudeSettings(sandboxPolicy(input)).sandbox as {
      enabled: boolean;
    };
    const off = claudeSettings(sandboxPolicy({ ...input, enforced: false }))
      .sandbox as { enabled: boolean };
    expect(on.enabled).toBe(true);
    expect(off.enabled).toBe(false);
  });

  test("is a boundary: no command runs outside it on request, and a host that would enforce it fails rather than runs open", () => {
    type Sandbox = {
      allowUnsandboxedCommands: boolean;
      failIfUnavailable: boolean;
    };
    const on = claudeSettings(sandboxPolicy(input)).sandbox as Sandbox;
    const off = claudeSettings(sandboxPolicy({ ...input, enforced: false }))
      .sandbox as Sandbox;
    expect(on.allowUnsandboxedCommands).toBe(false);
    expect(off.allowUnsandboxedCommands).toBe(false);
    expect(on.failIfUnavailable).toBe(true);
    expect(off.failIfUnavailable).toBe(false);
  });

  test("the probe reports each listener and a server answers on loopback", async () => {
    // What `test/checks.test.ts` does to boot the forge. A sandboxed run
    // refuses the unix sockets and takes the port (FORGE_TEST_SOCKET=port);
    // in a crew run, `bun scripts/sandbox-probe.ts` prints these verdicts.
    const verdicts = await probe();
    expect(verdicts.map((v) => v.name)).toEqual([
      "unix socket under $TMPDIR",
      "unix socket under the clone",
      LOOPBACK,
    ]);
    expect(verdicts.find((v) => v.name === LOOPBACK)?.ok).toBe(true);
  });

  test("the brief says in two lines what the shell can and cannot run", () => {
    expect(SANDBOX_LINES).toHaveLength(2);
    const [can, cannot] = SANDBOX_LINES;
    expect(can).toContain("bun install");
    expect(can).toContain("bun x tsc --noEmit");
    expect(can).toContain("FORGE_TEST_SOCKET=port");
    expect(can).toContain("loopback");
    expect(cannot).toContain("It cannot:");
    expect(cannot).toContain("bind a unix socket");
    expect(cannot).toContain("Never leave the sandbox");
    const prompt = systemPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
      issue: { number: 1 },
      branch: "bot/1",
      forgeUrl: "http://forge.test",
      isApp: false,
    } as unknown as BriefInput);
    expect(prompt).toContain(`${can}\n${cannot}`);
  });

  test("a builder is told the steps before a push; a planner is not", () => {
    const input = (role: "builder" | "planner") =>
      ({
        agent: { user: { username: "bot", displayName: "" }, brief: "" },
        repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
        issue: { number: 1 },
        branch: "bot/1",
        forgeUrl: "http://forge.test",
        isApp: false,
        role,
      }) as unknown as BriefInput;
    const builder = systemPrompt(input("builder"));
    expect(builder).toContain("bun install");
    expect(builder).toContain("bun x tsc --noEmit");
    expect(builder).toContain("bun scripts/gate.ts");
    expect(builder).toContain("Do not push while any of them is red");
    expect(builder).toContain("say which and why");
    expect(builder.indexOf("bun scripts/gate.ts")).toBeLessThan(
      builder.indexOf("bun x tsc --noEmit"),
    );
    expect(builder).toContain(
      "files=$(bun scripts/fast.ts) && bun test $files",
    );
    expect(builder).toContain("exit 3");
    expect(builder).toContain("exit 2");
    expect(builder).not.toContain("bun test $(");
    expect(builder).toContain("the forge runs the full check once");
    expect(systemPrompt(input("planner"))).not.toContain("scripts/fast.ts");
  });

  test("the probe answers with a reason when it cannot", async () => {
    const probe = await sandboxAvailable();
    if (process.platform === "darwin") expect(probe).toEqual({ ok: true });
    else if (!probe.ok) expect(probe.reason.length).toBeGreaterThan(0);
  });
});

describe("the sandbox on a run's record", () => {
  let dataDir: string;
  let app: App;
  let repoId: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sandbox-run-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(app, a.value, { name: "r" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const agentRun = () => createRun(app.db, { repoId, kind: "agent" });

  test("a run starts unrecorded and says nothing", () => {
    const run = agentRun();
    expect(run.sandboxEnforced).toBeNull();
    expect(sandboxLine(run)).toBeNull();
  });

  test("keeps enforced, and says unsandboxed with an escaped reason", () => {
    const off = agentRun();
    noteRunProgress(app.db, off.id, {
      sandbox: { enforced: false, note: "<b>bwrap</b> is not installed" },
    });
    const offRun = getRun(app.db, off.id)!;
    expect(offRun.sandboxEnforced).toBe(false);
    const text = String(sandboxLine(offRun));
    expect(text).toContain("Unsandboxed");
    expect(text).toContain("&lt;b&gt;bwrap&lt;/b&gt; is not installed");
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("error-note");
    expect(text).toContain('data-variant="danger"');

    const on = agentRun();
    noteRunProgress(app.db, on.id, { sandbox: { enforced: true, note: "" } });
    const onRun = getRun(app.db, on.id)!;
    expect(onRun.sandboxEnforced).toBe(true);
    expect(String(sandboxLine(onRun))).not.toContain("Unsandboxed");
    expect(String(sandboxLine(onRun))).toContain("Sandboxed");
  });

  test("a later progress note does not erase it", () => {
    const run = agentRun();
    noteRunProgress(app.db, run.id, {
      sandbox: { enforced: false, note: "x" },
    });
    noteRunProgress(app.db, run.id, { costUsd: 1 });
    expect(getRun(app.db, run.id)!.sandboxEnforced).toBe(false);
  });
});

describe("the shell sandbox denies the whole data directory but the agent's own (#560)", () => {
  let dataDir: string;
  const runId = "01m46abcdefghjkmnpqrstvwxy";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sandbox-allow-"));
    for (const dir of [
      "checks/01check/src",
      "looks/01app/production",
      "repos/alice",
      "apps/01app/production",
      "crew/scout/01repo/7",
      "crew/scout/.t/older-run",
      "crew/mason/01repo/3",
      "crew/torque/01repo/9",
    ])
      mkdirSync(join(dataDir, dir), { recursive: true });
    for (const file of [
      "forge.db",
      "secret.key",
      "steward-direction-parked.txt",
      "checks/01check/src/a.ts",
    ])
      writeFileSync(join(dataDir, file), "x");
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(join(tmpdir(), "fc-forge-sandbox-neighbour"), {
      recursive: true,
      force: true,
    });
    await rm(join(dataDir, "..", `forge-sandbox-locked-${process.pid}`), {
      recursive: true,
      force: true,
    });
  });

  const policy = () =>
    sandboxPolicy({ dataDir, agentName: "scout", urls: [], runId });
  const denied = (path: string, deny: readonly string[]) =>
    deny.some((d) => path === d || path.startsWith(`${d}/`));

  test("every entry of the data directory is denied but crew/, known or not", () => {
    const { denyRead } = policy();
    for (const entry of [
      "checks",
      "looks",
      "repos",
      "apps",
      "forge.db",
      "secret.key",
      "steward-direction-parked.txt",
    ])
      expect(denied(join(dataDir, entry), denyRead)).toBe(true);
    expect(denyRead).not.toContain(join(dataDir, "crew"));
  });

  test("inside crew/, every agent but this one is denied, and this one's other runs' temp", () => {
    const { denyRead } = policy();
    expect(denied(join(dataDir, "crew/mason"), denyRead)).toBe(true);
    expect(denied(join(dataDir, "crew/torque"), denyRead)).toBe(true);
    expect(denied(join(dataDir, "crew/scout/.t/older-run"), denyRead)).toBe(
      true,
    );
  });

  test("the agent still reaches its own working directory and its own run's temp", () => {
    const { denyRead, tmpDir } = policy();
    expect(denied(join(dataDir, "crew/scout/01repo/7"), denyRead)).toBe(false);
    expect(tmpDir).toBeDefined();
    expect(tmpDir!.startsWith(join(dataDir, "crew/scout/.t/"))).toBe(true);
    expect(denied(tmpDir!, denyRead)).toBe(false);
  });

  test("the machine's temp directory and ~/.claude.json are denied", () => {
    const { denyRead } = policy();
    expect(denyRead).toContain(join(homedir(), ".claude.json"));
    // This data directory lives in the temp directory, so the forge's own
    // pieces of it are denied: the shared Claude Code directory and a cell's.
    mkdirSync(join(tmpdir(), "fc-forge-sandbox-neighbour"), {
      recursive: true,
    });
    expect(
      denied(join(tmpdir(), "fc-forge-sandbox-neighbour"), policy().denyRead),
    ).toBe(true);
    expect(policy().denyRead).toContain(
      join(tmpdir(), `claude-${process.getuid?.() ?? 0}`),
    );
    expect(dataInTemp(dataDir)).toBe(true);
    expect(dataInTemp("/srv/forge-data-nowhere")).toBe(false);
    const elsewhere = sandboxPolicy({
      dataDir: "/srv/forge-data-nowhere",
      agentName: "scout",
      urls: [],
    });
    expect(elsewhere.denyRead).toContain(tmpdir());
  });

  test("the paths that must never be read are denied by name, listed or not", () => {
    const { denyRead } = sandboxPolicy({
      dataDir: "/srv/forge-data-nowhere",
      agentName: "scout",
      urls: [],
    });
    for (const name of [
      "forge.db",
      "secret.key",
      "repos",
      "checks",
      "looks",
      "ssh",
    ])
      expect(denyRead).toContain(join("/srv/forge-data-nowhere", name));
  });

  test("a data directory that cannot be listed refuses the run, never denies nothing", () => {
    // Root can readdir chmod 0o000 directories, so the listing never fails on
    // the isolated Actions runner (uid 0). Same skip as apps-adversarial.
    if (process.getuid?.() === 0) return;
    const locked = join(dataDir, "..", `forge-sandbox-locked-${process.pid}`);
    mkdirSync(join(locked, "crew"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(() =>
        sandboxPolicy({ dataDir: locked, agentName: "scout", urls: [], runId }),
      ).toThrow(SandboxListingError);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("a stopped forge's run temp directories are swept once they are old, not before", () => {
    const old = join(dataDir, "crew/mason/.t/old-run");
    const fresh = join(dataDir, "crew/mason/.t/fresh-run");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(old, longAgo, longAgo);
    expect(sweepRunTmp(dataDir, 60 * 60_000)).toBeGreaterThanOrEqual(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("asked again, the policy denies an agent that appeared since", () => {
    expect(denied(join(dataDir, "crew/quill"), policy().denyRead)).toBe(false);
    mkdirSync(join(dataDir, "crew/quill"), { recursive: true });
    expect(denied(join(dataDir, "crew/quill"), policy().denyRead)).toBe(true);
  });
});

describe("a sandboxed run can run this repository's tests (#1107)", () => {
  test("the settings keep the boundary: no unix socket is let through", () => {
    const settings = claudeSettings(
      sandboxPolicy({
        dataDir: "/tmp/forge-sandbox-test",
        agentName: "scout",
        urls: [],
        runId: "01abcdefghijklmnop",
      }),
    ).sandbox as { network: Record<string, unknown> };
    expect(settings.network["allowAllUnixSockets"]).toBeUndefined();
    expect(settings.network["allowUnixSockets"]).toBeUndefined();
  });

  test("in port mode no cell is offered: its proxy socket cannot be bound", async () => {
    const script = `import { cellsAvailable } from "./src/apps/contain.ts"; console.log(JSON.stringify(await cellsAvailable()))`;
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, FORGE_TEST_SOCKET: "port", FORGE_CELLS: "" },
      cwd: join(import.meta.dir, ".."),
    });
    const answer = JSON.parse(run.stdout.toString());
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain("FORGE_TEST_SOCKET=port");
  });

  test("the internal listener takes a loopback port where the socket cannot be bound, and gates it", async () => {
    const was = process.env["FORGE_TEST_SOCKET"];
    process.env["FORGE_TEST_SOCKET"] = "port";
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sandbox-port-"));
    const app = createApp({ dataDir, port: 0 });
    const { serve } = await import("../src/http/server.ts");
    const servers = await serve(app);
    try {
      const address = app.hookAddress.current;
      expect(address).toMatch(/^tcp:127\.0\.0\.1:\d+$/);
      expect(existsSync(app.socketPath)).toBe(false);
      const post = (headers: Record<string, string>) =>
        fetchInternal(address, "/internal/hook", {
          method: "POST",
          headers,
          body: JSON.stringify({ hook: "pre-receive", repoId: "nope", actorId: "", updates: [], gitEnv: {} }),
        });
      expect((await post({})).status).toBe(403);
      expect((await post({ "x-forge-hook-secret": "wrong" })).status).toBe(403);
      expect((await fetchInternal(address, "/internal/nothing")).status).toBe(403);
      // With the secret the hook is answered (an unknown repository: 400).
      const ok = await post({ "x-forge-hook-secret": app.hookSecret });
      expect(ok.status).toBe(400);
      expect(await ok.text()).toBe("unknown repository");
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
      if (was === undefined) delete process.env["FORGE_TEST_SOCKET"];
      else process.env["FORGE_TEST_SOCKET"] = was;
    }
  });

  test("a hook's git environment is cut to the quarantine variables", async () => {
    const { forwardedGitEnv } = await import("../src/git/hook-protocol.ts");
    expect(
      forwardedGitEnv({
        GIT_OBJECT_DIRECTORY: "/q",
        GIT_DIR: "/etc",
        GIT_CONFIG_COUNT: "1",
        GIT_QUARANTINE_PATH: 5,
      }),
    ).toEqual({ GIT_OBJECT_DIRECTORY: "/q" });
    expect(forwardedGitEnv(null)).toEqual({});
  });

  test("addresses are a socket path or loopback only", () => {
    expect(internalRequest("/d/forge-x.sock", "/p")).toEqual({
      url: "http://forge/p",
      init: { unix: "/d/forge-x.sock" },
    });
    expect(internalRequest(tcpAddress(4321), "/p").url).toBe(
      "http://127.0.0.1:4321/p",
    );
    // Not loopback: treated as a path, never as a host to dial.
    expect(internalRequest("tcp:10.0.0.1:80", "/p").url).toBe("http://forge/p");
  });

  test("the brief tells the agent what it can run and never to leave the sandbox", async () => {
    const { systemPrompt } = await import("../src/crew/brief.ts");
    const prompt = systemPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { ownerName: "alice", name: "square", defaultBranch: "main" },
      issue: { number: 1 },
      branch: "bot/1",
      forgeUrl: "http://forge.test",
      isApp: false,
    } as never);
    expect(prompt).toContain("Never leave the sandbox");
    expect(prompt).toContain("FORGE_TEST_SOCKET=port");
    expect(prompt).not.toMatch(/sandbox (off|disabled)|outside the sandbox/i);
  });
});

describe("a sandboxed run pushes through a port-mode forge (#1107)", () => {
  async function runWith() {
    const was = process.env["FORGE_TEST_SOCKET"];
    process.env["FORGE_TEST_SOCKET"] = "port";
    const dataDir = await mkdtemp(join(tmpdir(), "forge-sandbox-push-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    // Bound; from here only the runner may put it in a run's environment.
    delete process.env["FORGE_TEST_SOCKET"];
    const seen = join(dataDir, "seen");
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo "\${FORGE_TEST_SOCKET:-unset}" > "${seen}.env"
echo "x" >> W.md; git add -A; git commit -qm w
git push origin HEAD:refs/pull/9 > "${seen}.pull" 2>&1
git push -q -u origin HEAD > "${seen}.branch" 2>&1
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1,"session_id":"s","terminal_reason":"completed"}'
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
      const alice = await createUser(app.db, { origin: "seed", trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!alice.ok) throw new Error(alice.error);
      const made = await createAgent(app, alice.value, { username: "bot", brief: "b" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = await createRepo(app, alice.value, { name: "garden" });
      if (!repo.ok) throw new Error(String(repo.error));
      const seeded = await commitToBranch(app, alice.value, repo.value, {
        message: "Start",
        files: [{ path: "README.md", content: "# g\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      addToCrew(app, alice.value, repo.value, "bot");
      const issue = openIssue(app, alice.value, repo.value, { title: "Plant", body: "x" });
      if (!issue.ok) throw new Error(String(issue.error));
      assignIssue(app, alice.value, repo.value, issue.value, made.value.user);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const run = listRuns(app.db, repo.value.id, { kind: "agent" })[0];
        if (run && ["ok", "failed", "cancelled"].includes(run.state)) break;
        await Bun.sleep(100);
      }
      const read = (n: string) => (existsSync(`${seen}.${n}`) ? readFileSync(`${seen}.${n}`, "utf8") : "");
      return { env: read("env").trim(), pull: read("pull"), branch: read("branch"), address: app.hookAddress.current };
    } finally {
      await crew.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
      if (was === undefined) delete process.env["FORGE_TEST_SOCKET"];
      else process.env["FORGE_TEST_SOCKET"] = was;
    }
  }

  // `startCrew` probes the host itself, so the run is sandboxed exactly
  // where this host can hold it to one; the env must follow that.
  test("a sandboxed run carries FORGE_TEST_SOCKET=port, an unsandboxed one does not; a real push meets the pre-receive verdict over the port", async () => {
    const enforced = (await sandboxAvailable()).ok;
    const r = await runWith();
    expect(r.env).toBe(enforced ? "port" : "unset");
    expect(r.address).toMatch(/^tcp:/);
    expect(r.pull).toContain("refs/pull/* is reserved");
    // The ordinary branch push went through the same door.
    expect(r.branch).not.toContain("hook relay failed");
    expect(r.branch).not.toContain("forbidden");
  }, 60_000);
});

describe("a run's temp directory leaves Claude Code's sockets room to bind", () => {
  const child = "/data/children/cell-3ea623d0-14ce-43f3-a6fd-10385eb629a6";
  const linux = { linux: true, temp: "/tmp" };

  test("a forge's own data keeps it under the agent", () => {
    expect(runTmpDir("/data", "mason", "01m71kw4dfp4z8arr359fkygy5", linux)).toBe("/data/crew/mason/.t/arr359fkygy5");
  });

  test("a child forge's long data path moves it to the temp directory, short enough for a socket", () => {
    // scottishbob, 2026-11-10: "Failed to create bridge sockets after 5 attempts".
    const dir = runTmpDir(child, "scottishbot", "01m71kw4dfp4z8arr359fkygy5", linux);
    expect(dir).toBe("/tmp/fr-arr359fkygy5");
    expect(`${dir}/claude-socks-0123456789abcdef.sock`.length).toBeLessThanOrEqual(107);
    expect(join(child, "crew/scottishbot/.t/arr359fkygy5/claude-socks-0123456789abcdef.sock").length).toBeGreaterThan(107);
  });

  test("off Linux the socket rule does not apply and the place does not move", () => {
    expect(runTmpDir(child, "scottishbot", "01m71kw4dfp4z8arr359fkygy5", { linux: false, temp: "/tmp" }).startsWith(join(child, "crew/scottishbot/.t/"))).toBe(true);
  });
});

test.skipIf(process.platform !== "linux")("a child forge's run reads and writes its own temp directory in the machine's, and nothing else there", () => {
  const data = join(tmpdir(), `forge-long-${Date.now()}`, "children", "cell-3ea623d0-14ce-43f3-a6fd-10385eb629a6");
  mkdirSync(join(data, "crew", "scottishbot"), { recursive: true });
  const neighbour = join(tmpdir(), `fc-neighbour-${Date.now()}`);
  mkdirSync(neighbour, { recursive: true });
  const p = sandboxPolicy({ dataDir: data, agentName: "scottishbot", urls: [], runId: "01m71kw4dfp4z8arr359fkygy5" });
  expect(p.tmpDir).toBe(join(tmpdir(), "fr-arr359fkygy5"));
  expect(p.denyRead).not.toContain(p.tmpDir);
  expect(p.denyRead).toContain(neighbour);
  expect(p.denyRead).toContain(join(data, "forge.db"));
});
