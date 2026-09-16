/**
 * The shell sandbox is policy the host may or may not be able to hold a
 * run to. Where it cannot, the settings handed to Claude Code say so
 * plainly, so a run reads "unsandboxed" once instead of warning on every
 * command and running anyway.
 */
import { describe, expect, test } from "bun:test";
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
