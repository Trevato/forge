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
import { claudeSettings } from "../src/crew/claude.ts";
import {
  SandboxListingError,
  sandboxAvailable,
  sandboxPolicy,
  sweepRunTmp,
} from "../src/crew/sandbox.ts";

describe("the shell sandbox", () => {
  const input = {
    dataDir: "/tmp/forge-sandbox-test",
    agentName: "scout",
    urls: ["http://localhost:3000"],
  };

  test("is enforced unless the host says it cannot", () => {
    expect(sandboxPolicy(input).enforced).toBe(true);
    expect(sandboxPolicy({ ...input, enforced: false }).enforced).toBe(false);
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

    const on = agentRun();
    noteRunProgress(app.db, on.id, { sandbox: { enforced: true, note: "" } });
    const onRun = getRun(app.db, on.id)!;
    expect(onRun.sandboxEnforced).toBe(true);
    expect(String(sandboxLine(onRun))).not.toContain("Unsandboxed");
    expect(String(sandboxLine(onRun))).toContain("Sandboxed");
  });

  test("a later progress note does not erase it", () => {
    const run = agentRun();
    noteRunProgress(app.db, run.id, { sandbox: { enforced: false, note: "x" } });
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
    for (const file of ["forge.db", "secret.key", "steward-direction-parked.txt", "checks/01check/src/a.ts"])
      writeFileSync(join(dataDir, file), "x");
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(join(tmpdir(), "fc-forge-sandbox-neighbour"), { recursive: true, force: true });
    await rm(join(dataDir, "..", `forge-sandbox-locked-${process.pid}`), { recursive: true, force: true });
  });

  const policy = () =>
    sandboxPolicy({ dataDir, agentName: "scout", urls: [], runId });
  const denied = (path: string, deny: readonly string[]) =>
    deny.some((d) => path === d || path.startsWith(`${d}/`));

  test("every entry of the data directory is denied but crew/, known or not", () => {
    const { denyRead } = policy();
    for (const entry of ["checks", "looks", "repos", "apps", "forge.db", "secret.key", "steward-direction-parked.txt"])
      expect(denied(join(dataDir, entry), denyRead)).toBe(true);
    expect(denyRead).not.toContain(join(dataDir, "crew"));
  });

  test("inside crew/, every agent but this one is denied, and this one's other runs' temp", () => {
    const { denyRead } = policy();
    expect(denied(join(dataDir, "crew/mason"), denyRead)).toBe(true);
    expect(denied(join(dataDir, "crew/torque"), denyRead)).toBe(true);
    expect(denied(join(dataDir, "crew/scout/.t/older-run"), denyRead)).toBe(true);
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
    mkdirSync(join(tmpdir(), "fc-forge-sandbox-neighbour"), { recursive: true });
    expect(denied(join(tmpdir(), "fc-forge-sandbox-neighbour"), policy().denyRead)).toBe(true);
    expect(policy().denyRead).toContain(join(tmpdir(), `claude-${process.getuid?.() ?? 0}`));
    const elsewhere = sandboxPolicy({ dataDir: "/srv/forge-data-nowhere", agentName: "scout", urls: [] });
    expect(elsewhere.denyRead).toContain(tmpdir());
  });

  test("the paths that must never be read are denied by name, listed or not", () => {
    const { denyRead } = sandboxPolicy({ dataDir: "/srv/forge-data-nowhere", agentName: "scout", urls: [] });
    for (const name of ["forge.db", "secret.key", "repos", "checks", "looks", "ssh"])
      expect(denyRead).toContain(join("/srv/forge-data-nowhere", name));
  });

  test("a data directory that cannot be listed refuses the run, never denies nothing", () => {
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
