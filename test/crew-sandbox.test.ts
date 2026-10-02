/**
 * The shell sandbox is policy the host may or may not be able to hold a
 * run to. Where it cannot, the settings handed to Claude Code say so
 * plainly, so a run reads "unsandboxed" once instead of warning on every
 * command and running anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun, getRun, noteRunProgress } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { sandboxLine } from "../src/web/studio/sandbox.ts";
import { claudeSettings } from "../src/crew/claude.ts";
import { sandboxAvailable, sandboxPolicy } from "../src/crew/sandbox.ts";

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
