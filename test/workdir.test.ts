import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installDependencies,
  installEnv,
  installNote,
  runBounded,
  removeClone,
  type InstallRunner,
} from "../src/crew/workdir.ts";

describe("removing a clone", () => {
  test("a removal that fails twice is tried again, and the loop turns between tries", async () => {
    let calls = 0;
    let turned = false;
    // Runs on the loop's next turn: only if a retry waits without blocking.
    const turn = new Promise<void>((resolve) =>
      setImmediate(() => {
        turned = true;
        resolve();
      }),
    );
    let turnedBeforeSecondTry = false;
    await removeClone("/x", 5, 5, async () => {
      if (++calls === 2) turnedBeforeSecondTry = turned;
      if (calls < 3) throw new Error("ENOTEMPTY");
    });
    await turn;
    expect(calls).toBe(3);
    expect(turnedBeforeSecondTry).toBe(true);
  });

  test("a clone that will not go rejects with the last error after the tries", async () => {
    let calls = 0;
    const gone = removeClone("/x", 3, 1, async () => {
      calls++;
      throw new Error("ENOTEMPTY");
    });
    await expect(gone).rejects.toThrow("ENOTEMPTY");
    expect(calls).toBe(3);
  });
});

describe("installing dependencies", () => {
  const fixture = (lock: boolean) => {
    const dir = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "wd-"));
    writeFileSync(join(dir, "package.json"), "{}");
    if (lock) writeFileSync(join(dir, "bun.lock"), "lock-a");
    return dir;
  };
  const fake = (counter: { n: number }, code = 0): InstallRunner => async (dir) => {
    counter.n++;
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    return { code, stderr: "boom" };
  };

  test("a workdir with a lockfile gets node_modules, and a second preparation does not reinstall", async () => {
    const dir = fixture(true);
    const count = { n: 0 };
    const cache = join(dir, ".cache");
    expect((await installDependencies(dir, cache, fake(count))).installed).toBe(true);
    expect(existsSync(join(dir, "node_modules"))).toBe(true);
    expect((await installDependencies(dir, cache, fake(count))).installed).toBe(false);
    expect(count.n).toBe(1);
    writeFileSync(join(dir, "bun.lock"), "lock-b");
    await installDependencies(dir, cache, fake(count));
    expect(count.n).toBe(2);
  });

  test("no lockfile means no install; a failed install is reported, not thrown", async () => {
    const count = { n: 0 };
    await installDependencies(fixture(false), "/x", fake(count));
    expect(count.n).toBe(0);
    const dir = fixture(true);
    const result = await installDependencies(dir, join(dir, ".c"), fake(count, 1));
    expect(result.error).toContain("exited 1");
    const thrown = await installDependencies(dir, join(dir, ".c"), async () => {
      throw new Error("spawn");
    });
    expect(thrown.error).toContain("spawn");
  });
});

describe("the install's bounds", () => {
  test("the child env is an allowlist: no FORGE_* variable, no token", () => {
    const env = installEnv("/c/bun", {
      PATH: "/bin",
      TMPDIR: "/t",
      FORGE_TOKEN: "s",
      FORGE_SECRET: "k",
      ANTHROPIC_API_KEY: "a",
    });
    expect(Object.keys(env).sort()).toEqual(["BUN_INSTALL_CACHE_DIR", "HOME", "PATH", "TMPDIR"]);
    expect(Object.keys(installEnv("/c/bun")).some((k) => k.startsWith("FORGE_"))).toBe(false);
  });

  test("the runner is handed that env, not the forge's", async () => {
    process.env["FORGE_TOKEN"] = "secret";
    let seen: Record<string, string> = {};
    try {
      const dir = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "wd-"));
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "bun.lock"), "x");
      await installDependencies(dir, join(dir, "c", "bun"), async (_d, env) => {
        seen = env;
        return { code: 0, stderr: "" };
      });
    } finally {
      delete process.env["FORGE_TOKEN"];
    }
    expect(Object.keys(seen).some((k) => k.startsWith("FORGE_"))).toBe(false);
  });

  test("a hung install is killed and reported", async () => {
    const started = Date.now();
    const result = await runBounded(["sleep", "30"], ".", { PATH: process.env["PATH"] ?? "" }, 100);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("timed out");
  });

  test("the run log's line for each outcome", () => {
    expect(installNote({ installed: true })).toBe("dependencies installed");
    expect(installNote({ installed: false })).toBeUndefined();
    expect(installNote({ installed: false, error: "boom" })).toBe("dependency install failed: boom");
  });
});
