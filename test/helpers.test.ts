/**
 * The helpers the suite's own health rests on: the environment a git client
 * under test runs in, whether a tool this machine would need is here, and
 * the process globals a file borrows. Each exists because of a run that
 * failed for the machine's reasons, or another file's, and was read as the
 * change's fault (#233, #302).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitClientEnv } from "./helpers/git-client.ts";
import { logLevel, setLogLevel, type LogLevel } from "../src/kernel/log.ts";
import { firstFetchRetry } from "../src/origins/mirror.ts";
import {
  mirrorOutboundForTest,
  provideMirrorOutboundForTest,
} from "../src/origins/git-mirror.ts";
import type { OutboundOptions } from "../src/kernel/outbound.ts";
import {
  fastFirstFetch,
  mirrorOutbound,
  quietLogs,
  withoutEnv,
} from "./helpers/globals.ts";
import { missing } from "./helpers/tools.ts";

describe("a git client's environment under test", () => {
  test("carries no ambient git configuration, whatever the host sets", () => {
    const env = gitClientEnv();
    // The crew's own shell sets exactly this: configuration in variables,
    // which `GIT_CONFIG_GLOBAL=/dev/null` cannot switch off, carrying an
    // Authorization header for *its* forge. None of it comes through.
    expect(env["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(env["GIT_CONFIG_KEY_0"]).toBeUndefined();
    expect(env["GIT_CONFIG_VALUE_0"]).toBeUndefined();
    expect(env["GIT_CONFIG_PARAMETERS"]).toBeUndefined();
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["PATH"]).toBe(process.env["PATH"] ?? "/usr/bin:/bin");
    // The test's own additions win.
    expect(gitClientEnv({ GIT_AUTHOR_NAME: "Ada" })["GIT_AUTHOR_NAME"]).toBe(
      "Ada",
    );
  });

  test("a push to a URL that names its credentials is the one git sends", async () => {
    // The end of the story above, without a server: a config header set the
    // way the crew's shell sets it would reach the remote instead of the
    // URL's credentials. `git config --list` is what git would obey.
    const dir = await mkdtemp(join(tmpdir(), "forge-git-env-"));
    try {
      const listed = async (env: Record<string, string>): Promise<string> => {
        const proc = Bun.spawn(["git", "config", "--list"], {
          cwd: dir,
          env,
          stdout: "pipe",
          stderr: "ignore",
        });
        const [out] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        return out;
      };
      const ambient = {
        ...gitClientEnv(),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: "Authorization: Basic c29tZWJvZHk6ZWxzZQ==",
      };
      expect(await listed(ambient)).toContain("http.extraheader=");
      expect(await listed(gitClientEnv())).not.toContain("http.extraheader=");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("whether a tool is on this machine", () => {
  test("a tool that is here is never skipped; one that is not, is", () => {
    expect(missing("/bin/sh")).toBe(false);
    expect(missing("sh")).toBe(false);
    expect(missing("no-such-tool-on-any-machine")).toBe(true);
    expect(missing("/usr/bin/no-such-tool")).toBe(true);
    // Any one absent is enough to skip.
    expect(missing("sh", "no-such-tool-on-any-machine")).toBe(true);
  });
});

describe("a global a file borrows is given back", () => {
  // Values nobody else would pick, so reading them back proves the restore
  // rather than a coincidence with the defaults.
  const ASIDE = "https://machine.example.test";
  const WAITS: readonly number[] = [1, 2, 3];
  const VET: OutboundOptions = { allow: ["192.0.2.7"] };
  let found: {
    level: LogLevel;
    waits: readonly number[];
    url: string | undefined;
    vet: OutboundOptions;
  };
  beforeAll(() => {
    found = {
      level: logLevel(),
      waits: firstFetchRetry.ms,
      url: process.env.FORGE_URL,
      vet: mirrorOutboundForTest(),
    };
    setLogLevel("warn");
    firstFetchRetry.ms = WAITS;
    process.env.FORGE_URL = ASIDE;
    provideMirrorOutboundForTest(VET);
  });
  afterAll(() => {
    provideMirrorOutboundForTest(found.vet);
    setLogLevel(found.level);
    firstFetchRetry.ms = found.waits;
    if (found.url === undefined) delete process.env.FORGE_URL;
    else process.env.FORGE_URL = found.url;
  });

  describe("while a file borrows them", () => {
    quietLogs();
    fastFirstFetch([50]);
    withoutEnv("FORGE_URL");
    mirrorOutbound({});

    test("they hold what it asked for", () => {
      expect(logLevel()).toBe("error");
      expect(firstFetchRetry.ms).toEqual([50]);
      expect(process.env.FORGE_URL).toBeUndefined();
      expect(mirrorOutboundForTest()).toEqual({});
      // What the file sets under a cleared name goes when it does.
      process.env.FORGE_URL = "https://set.inside.test";
    });
  });

  test("afterwards they read back what they were", () => {
    expect(logLevel()).toBe("warn");
    expect(firstFetchRetry.ms).toBe(WAITS);
    expect(process.env.FORGE_URL).toBe(ASIDE);
    expect(mirrorOutboundForTest()).toBe(VET);
  });
});
