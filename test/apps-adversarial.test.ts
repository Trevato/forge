/**
 * Adversarial coverage for apps, runs, and the crew (docs/APPS.md): trying
 * to break each of the eight mechanical rules, host routing, grants, the
 * proxy, manifests, concurrency, logs, and the migration that introduced
 * the schema. Where the existing suites (apps.test.ts, apps-api.test.ts,
 * crew.test.ts) already drive a rule end to end, this file goes for the
 * edges: stale state, races, forged input, and the boundary of a bound.
 *
 * The teardown races, the grants and the proxy, and rules 1 and 4 driven
 * through a live apps runtime are their own files
 * (apps-adversarial-{teardown,test-step,grants,rules}.test.ts), one
 * runtime each, so no one file sets the gate's floor (#2038).
 */

import {
  appHostSuffix,
  domainHoldsAppHosts,
  resolveAppDomain,
} from "../src/apps/host.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { cloneDir, envDir, isEnvName, type EnvName } from "../src/apps/data.ts";
import { appEnv, childEnv } from "../src/apps/process.ts";
import { parseAppHost, resolveAppHost } from "../src/apps/proxy.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { newApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  activeRunFor,
  automaticRunsSince,
  cancelRun,
  claimRun,
  createRun,
  finishRun,
  listRuns,
  type Run,
} from "../src/core/runs.ts";
import { createToken, listTokens, verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { executeAgentRun } from "../src/crew/runner.ts";
import { openDb } from "../src/kernel/db.ts";
import { migrations } from "../src/core/schema.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  appendRunLog,
  readRunLog,
  readRunLogTail,
  runLogListenerCount,
  subscribeRunLog,
} from "../src/runs/log.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";

const testBySocket = portInsteadOfSocket() ? test.skip : test;

const clientEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@forge.local",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@forge.local",
});

async function sh(args: string[], cwd: string) {
  const proc = Bun.spawn(args, {
    cwd,
    env: clientEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

// ---------------------------------------------------------------------------
// Pure units: no server, no filesystem beyond what the function itself does.
// ---------------------------------------------------------------------------

describe("host routing: a single-label attachment", () => {
  // Where a wildcard covers one label, the attachment is given whole and the
  // same rule builds and reads the hostname.
  const DOM = "--forge.example";

  test("production and preview hang off the forge's own label", () => {
    expect(parseAppHost("notes--forge.example", DOM)).toEqual({
      slug: "notes",
      env: "production",
      nested: false,
    });
    expect(parseAppHost("notes--12--forge.example:443", DOM)).toEqual({
      slug: "notes",
      env: "pull-12",
      nested: false,
    });
  });

  test("the dotted form is not an app under an undotted attachment, and vice versa", () => {
    // A forge hosted here has apps of its own: their hostnames sit in
    // front of ours and pass through for that forge to route.
    expect(parseAppHost("cs--lab--forge.example", DOM)).toEqual({
      slug: "lab",
      env: "production",
      nested: true,
    });
    expect(parseAppHost("cs--3--lab--14--forge.example", DOM)).toEqual({
      slug: "lab",
      env: "pull-14",
      nested: true,
    });
    expect(parseAppHost("--lab--forge.example", DOM)).toBeUndefined();
    expect(parseAppHost("cs----lab--forge.example", DOM)).toBeUndefined();
    expect(parseAppHost("notes.forge.example", DOM)).toBeUndefined();
    expect(
      parseAppHost("notes--forge.example", "forge.example"),
    ).toBeUndefined();
  });

  test("a bare domain attaches with a dot; a separator is taken whole", () => {
    expect(appHostSuffix("forge.example")).toBe(".forge.example");
    expect(appHostSuffix("--forge.example")).toBe("--forge.example");
    expect(appHostSuffix(".forge.example")).toBe(".forge.example");
  });
});

describe("host routing: domainHoldsAppHosts (issue #269)", () => {
  test("the hostnames a person really uses hold an app's slug", () => {
    expect(domainHoldsAppHosts("localhost")).toBe(true);
    expect(domainHoldsAppHosts("forge.example")).toBe(true);
    expect(domainHoldsAppHosts("--forge.example")).toBe(true);
  });

  test("an IPv4 address does not: WHATWG rejects a numeric last label", () => {
    expect(domainHoldsAppHosts("127.0.0.1")).toBe(false);
    expect(domainHoldsAppHosts("--127.0.0.1")).toBe(false);
    expect(domainHoldsAppHosts("203.0.113.5")).toBe(false);
  });
});

describe("resolveAppDomain: what app hostnames attach to (issue #269)", () => {
  test("an explicit FORGE_APP_DOMAIN wins outright, IP forge or not", () => {
    expect(
      resolveAppDomain({
        explicit: "apps.example",
        hosted: false,
        hostname: "203.0.113.5",
      }),
    ).toEqual({ ok: true, domain: "apps.example" });
    expect(
      resolveAppDomain({
        explicit: "apps.example",
        hosted: false,
        hostname: "forge.example",
      }),
    ).toEqual({ ok: true, domain: "apps.example" });
  });

  test("an ordinary hostname is used as-is, nothing changes", () => {
    expect(
      resolveAppDomain({
        explicit: undefined,
        hosted: false,
        hostname: "forge.example",
      }),
    ).toEqual({ ok: true, domain: "forge.example" });
  });

  test("a loopback forge addressed by IP falls back to localhost, not off", () => {
    const resolved = resolveAppDomain({
      explicit: undefined,
      hosted: false,
      hostname: "127.0.0.1",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.domain).toBe("localhost");
    expect(resolved.note).toContain("FORGE_APP_DOMAIN");
    // And it actually holds a slug, unlike what it replaced.
    expect(domainHoldsAppHosts(resolved.domain)).toBe(true);
  });

  test("a forge hosted inside another falls back the same way, nested form", () => {
    const resolved = resolveAppDomain({
      explicit: undefined,
      hosted: true,
      hostname: "127.0.0.1",
    });
    expect(resolved).toEqual({
      ok: true,
      domain: "--localhost",
      note: expect.stringContaining("FORGE_APP_DOMAIN"),
    });
  });

  test("a forge reached by a real, non-loopback IP leaves apps off, message names the fix", () => {
    const resolved = resolveAppDomain({
      explicit: undefined,
      hosted: false,
      hostname: "203.0.113.5",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain("FORGE_APP_DOMAIN");
    expect(resolved.reason).toContain("203.0.113.5");
  });
});

describe("host routing: parseAppHost", () => {
  const DOM = "apps.test";

  test("a port on the host is ignored", () => {
    expect(parseAppHost("hello.apps.test:3000", DOM)).toEqual({
      slug: "hello",
      env: "production",
      nested: false,
    });
  });

  test("upper case is folded", () => {
    expect(parseAppHost("HELLO.APPS.TEST", DOM)).toEqual({
      slug: "hello",
      env: "production",
      nested: false,
    });
  });

  test("a trailing dot (FQDN form) does not match the domain", () => {
    // Not a match rather than a mismatch: the request falls through to the
    // forge, never to the wrong app.
    expect(parseAppHost("hello.apps.test.", DOM)).toBeUndefined();
  });

  test("an IPv6 literal host is never an app", () => {
    expect(parseAppHost("[::1]:3000", DOM)).toBeUndefined();
    expect(parseAppHost("[::1]", "apps.test")).toBeUndefined();
  });

  test("what stands in front of our app's label is the guest's, passed through", () => {
    // `a` is a hostname inside app `b`'s own world — a hosted forge's app —
    // not a slug of ours split cleverly.
    expect(parseAppHost("a--b--12.apps.test", DOM)).toEqual({
      slug: "b",
      env: "pull-12",
      nested: true,
    });
    expect(parseAppHost("a--b.apps.test", DOM)).toEqual({
      slug: "b",
      env: "production",
      nested: true,
    });
  });

  test("pull number 0 and a leading zero are refused", () => {
    expect(parseAppHost("hello--0.apps.test", DOM)).toBeUndefined();
    expect(parseAppHost("hello--01.apps.test", DOM)).toBeUndefined();
  });

  test("a bare slug at the domain itself is not an app (missing label)", () => {
    expect(parseAppHost("apps.test", DOM)).toBeUndefined();
  });

  test("a multi-label host in front of the domain is not an app", () => {
    expect(parseAppHost("a.hello.apps.test", DOM)).toBeUndefined();
  });

  test("an empty label before the domain is refused", () => {
    expect(parseAppHost(".apps.test", DOM)).toBeUndefined();
  });

  test("a domain that itself carries a port is stripped the same way", () => {
    expect(parseAppHost("hello.apps.test:3000", "apps.test:3000")).toEqual({
      slug: "hello",
      env: "production",
      nested: false,
    });
  });

  test("resolveAppHost: no Host header at all is not an app host", () => {
    // `resolveAppHost` only ever calls `request.headers.get("host")`, so a
    // minimal stand-in is enough — no real `Request` synthesizes a missing
    // Host header, since `fetch`/`Request` always fill one in from the URL.
    const noHost = { headers: new Headers() } as unknown as Request;
    const result = resolveAppHost({ db: {} } as never, DOM, noHost);
    expect(result).toBeUndefined();
  });
});

describe("manifest: parseManifest edge cases", () => {
  test("malformed JSON fails closed with the parse error named", () => {
    const result = parseManifest("{not json", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "invalid") {
      expect(result.error.message).toContain("forge.json");
    } else {
      throw new Error("expected an 'invalid' manifest error");
    }
  });

  test("`app` as an array is rejected, not silently coerced", () => {
    const result = parseManifest(JSON.stringify({ app: [] }), undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid");
  });

  test("a run command with a newline or NUL is refused", () => {
    const withNewline = parseManifest(
      JSON.stringify({ app: { run: "echo a\necho b" } }),
      undefined,
    );
    expect(withNewline.ok).toBe(false);
    const withNul = parseManifest(
      JSON.stringify({ app: { run: "echo a\u0000b" } }),
      undefined,
    );
    expect(withNul.ok).toBe(false);
  });

  test("ready outside 1..600 or non-integer is refused; a huge number is refused too", () => {
    const huge = parseManifest(
      JSON.stringify({ app: { run: "x", ready: 1e9 } }),
      undefined,
    );
    expect(huge.ok).toBe(false);
    const fractional = parseManifest(
      JSON.stringify({ app: { run: "x", ready: 1.5 } }),
      undefined,
    );
    expect(fractional.ok).toBe(false);
    const zero = parseManifest(
      JSON.stringify({ app: { run: "x", ready: 0 } }),
      undefined,
    );
    expect(zero.ok).toBe(false);
  });

  test("health must be a path starting with /", () => {
    const result = parseManifest(
      JSON.stringify({ app: { run: "x", health: "http://x" } }),
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  test("a 100 KB run command is refused (bounded, not silently truncated)", () => {
    const result = parseManifest(
      JSON.stringify({ app: { run: "x".repeat(100_000) } }),
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid");
  });

  test('install: "" means skip, distinct from unset meaning "use the package default"', () => {
    const pkg = JSON.stringify({ dependencies: { x: "1.0.0" } });
    const unset = parseManifest(JSON.stringify({ app: { run: "x" } }), pkg);
    expect(unset.ok).toBe(true);
    if (unset.ok) expect(unset.value.install).toBe("bun install");
    const skipped = parseManifest(
      JSON.stringify({ app: { run: "x", install: "" } }),
      pkg,
    );
    expect(skipped.ok).toBe(true);
    if (skipped.ok) expect(skipped.value.install).toBeNull();
  });

  test("no forge.json and no package.json start script: not an app", () => {
    const result = parseManifest(undefined, JSON.stringify({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_an_app");
  });

  test("app.looks absent behaves exactly as today: the home page alone", () => {
    const result = parseManifest(JSON.stringify({ app: { run: "x" } }), undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.looks).toEqual(["/"]);
  });

  test("app.looks names up to three pages", () => {
    const result = parseManifest(
      JSON.stringify({ app: { run: "x", looks: ["/", "/board"] } }),
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.looks).toEqual(["/", "/board"]);
  });

  test("app.looks with more than three paths is refused", () => {
    const result = parseManifest(
      JSON.stringify({
        app: { run: "x", looks: ["/", "/a", "/b", "/c"] },
      }),
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid");
  });

  test("app.looks entries must be a path: no scheme, no host, no .., no control bytes", () => {
    for (const bad of [
      "board",
      "//evil.example/board",
      "https://evil.example/board",
      "/../secret",
      "/board\u0000",
      "/board\n",
    ]) {
      const result = parseManifest(
        JSON.stringify({ app: { run: "x", looks: [bad] } }),
        undefined,
      );
      expect(result.ok).toBe(false);
    }
  });

  test("an over-long app.looks entry is refused", () => {
    const result = parseManifest(
      JSON.stringify({ app: { run: "x", looks: [`/${"a".repeat(300)}`] } }),
      undefined,
    );
    expect(result.ok).toBe(false);
  });
});

describe("run log: redaction, truncation, and the listener seam", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-log-"));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a forge_ token and a Basic auth header are redacted on the way in", () => {
    const runId = "test-run-1";
    // Realistic lengths: a real run token is `forge_` + 32 random bytes,
    // base64url — 43 characters, well past the redactor's 20-char floor.
    const token = `forge_${"a1B2c3D4".repeat(6)}`;
    const basic = Buffer.from(`bot:${token}`).toString("base64");
    appendRunLog(dataDir, runId, `authenticated with ${token}`);
    appendRunLog(
      dataDir,
      runId,
      `curl -H "authorization: Basic ${basic}" https://x`,
    );
    const { lines } = readRunLog(dataDir, runId);
    const joined = lines.join("\n");
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(basic);
    expect(joined).toContain("[redacted]");
  });

  test("readRunLog with a small maxBytes drops the partial first line", () => {
    const runId = "test-run-2";
    for (let i = 0; i < 50; i++) appendRunLog(dataDir, runId, `line ${i}`);
    const { lines, truncated } = readRunLog(dataDir, runId, 40);
    expect(truncated).toBe(true);
    // Every remaining line must be whole: none may be a mid-word fragment
    // of "line N" that a byte cut would otherwise leave.
    for (const line of lines) expect(line).toMatch(/^line \d+$/);
  });

  test("readRunLogTail reads a bounded slice and still ends at the true last line", () => {
    const runId = "test-run-tail";
    // Far more lines than fit in a window sized for a handful of them.
    for (let i = 0; i < 20_000; i++) appendRunLog(dataDir, runId, `line ${i}`);
    const { lines, truncated } = readRunLogTail(dataDir, runId, 6);
    expect(truncated).toBe(true);
    expect(lines.length).toBeLessThan(20_000);
    expect(lines.at(-1)).toBe("line 19999");
    expect(lines.slice(-6)).toEqual(
      [19994, 19995, 19996, 19997, 19998, 19999].map((i) => `line ${i}`),
    );
  });

  test("readRunLogTail still returns at least the cap's worth of lines when a line is near the max length", () => {
    const runId = "test-run-tail-long-lines";
    // Lines this long are rare (real logs run 1KB-45KB total) but the cap
    // must not assume otherwise: it is sized from MAX_LINE, not a guess.
    for (let i = 0; i < 8; i++)
      appendRunLog(dataDir, runId, `${i}-`.repeat(8000));
    const { lines, truncated } = readRunLogTail(dataDir, runId, 6);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(truncated).toBe(true);
    // Every line kept must be whole: none may be a mid-repeat fragment left
    // by a byte cut landing inside it.
    for (const line of lines) expect(line).toMatch(/^(\d-)+$/);
    expect(lines.at(-1)).toBe("7-".repeat(8000));
  });

  test("readRunLogTail on a log shorter than the cap returns every line, untruncated", () => {
    const runId = "test-run-tail-short";
    appendRunLog(dataDir, runId, "only line");
    const { lines, truncated } = readRunLogTail(dataDir, runId, 6);
    expect(lines).toEqual(["only line"]);
    expect(truncated).toBe(false);
  });

  test("subscribe/abort a thousand times leaves no listener behind", () => {
    const before = runLogListenerCount();
    const runId = "test-run-leak";
    for (let i = 0; i < 1000; i++) {
      const controller = new AbortController();
      subscribeRunLog(runId, () => {}, controller.signal);
      controller.abort();
    }
    expect(runLogListenerCount()).toBe(before);
  });

  test("an already-aborted signal releases immediately, never registering", () => {
    const before = runLogListenerCount();
    const controller = new AbortController();
    controller.abort();
    subscribeRunLog("test-run-preaborted", () => {}, controller.signal);
    expect(runLogListenerCount()).toBe(before);
  });
});

describe("rule 8: a child inherits nothing it was not handed", () => {
  const SECRETS = {
    ANTHROPIC_API_KEY: "sk-leak-me-not",
    FORGE_GITHUB_CLIENT_SECRET: "also-secret",
    SOME_RANDOM_FORGE_INTERNAL: "should-not-leak",
  };

  test("childEnv never carries secrets that were not explicitly named", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, SECRETS);
      const env = childEnv({ PORT: "1234" });
      for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
      expect(env["PORT"]).toBe("1234");
      expect(env["PATH"]).toBeDefined();
    } finally {
      for (const key of Object.keys(SECRETS)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  test("appEnv (what an app process gets) never carries the operator's secrets", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, SECRETS);
      const env = appEnv({
        port: 4321,
        dataDir: "/data/apps/x/production/data",
        env: "production",
        url: "http://hello.apps.test",
        commitOid: "abc123",
        forgeUrl: "http://forge.test",
        identityKey: "test-identity-key",
      });
      for (const key of Object.keys(SECRETS)) expect(env[key]).toBeUndefined();
      expect(env["FORGE_APP_DATA"]).toBe("/data/apps/x/production/data");
    } finally {
      for (const key of Object.keys(SECRETS)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  test("an actual child process sees none of the operator's environment beyond what childEnv names", async () => {
    const saved = process.env["SUPER_SECRET_FORGE_VAR"];
    process.env["SUPER_SECRET_FORGE_VAR"] = "leak-if-you-can";
    try {
      const proc = Bun.spawn(["/bin/sh", "-c", "env"], {
        env: childEnv({ MARKER: "1" }),
        stdout: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).not.toContain("SUPER_SECRET_FORGE_VAR");
      expect(out).toContain("MARKER=1");
    } finally {
      if (saved === undefined) delete process.env["SUPER_SECRET_FORGE_VAR"];
      else process.env["SUPER_SECRET_FORGE_VAR"] = saved;
    }
  });
});

describe("ensureEnvData path safety", () => {
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-envdata-"));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("isEnvName rejects traversal-shaped and otherwise malformed names", () => {
    expect(isEnvName("../../etc")).toBe(false);
    expect(isEnvName("pull-../1")).toBe(false);
    expect(isEnvName("production/../../etc")).toBe(false);
    expect(isEnvName("pull-1.5")).toBe(false);
    expect(isEnvName("pull-")).toBe(false);
    expect(isEnvName("PRODUCTION")).toBe(false);
    expect(isEnvName("production")).toBe(true);
    expect(isEnvName("pull-12")).toBe(true);
  });

  test("envDir refuses a name that is not an environment, whatever the caller believed", () => {
    // Every caller (actions/apps.ts, apps/runtime.ts) checks `isEnvName`
    // first; `envDir` checks again so a future caller that skips it gets a
    // defect, not a path outside `<data>/apps`.
    const hostile = "../../../../../../tmp/forge-escape-test" as EnvName;
    expect(() => envDir(dataDir, "someappid", hostile)).toThrow(
      /refusing to build a path/,
    );
    expect(() => envDir(dataDir, "../escape", "production")).toThrow(
      /refusing to build a path/,
    );
    expect(envDir(dataDir, "someappid", "pull-12").startsWith(dataDir)).toBe(
      true,
    );
  });

  // Binds a unix socket itself; the check runs it where a sandbox refuses.
  testBySocket("a copy of an app's data leaves its sockets behind", async () => {
    // An app that keeps a socket in its data — a forge does — must not
    // make a preview impossible, let alone take the forge down with it.
    const source = join(dataDir, "with-socket");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "app.db"), "state");
    writeFileSync(join(source, "nested", "note.txt"), "kept");
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(join(source, "app.sock"), resolve),
    );
    try {
      const target = join(dataDir, "copied");
      cloneDir(source, target);
      expect(readFileSync(join(target, "app.db"), "utf8")).toBe("state");
      expect(readFileSync(join(target, "nested", "note.txt"), "utf8")).toBe(
        "kept",
      );
      expect(existsSync(join(target, "app.sock"))).toBe(false);
      expect(existsSync(`${target}.copying`)).toBe(false);
    } finally {
      server.close();
    }
  });

  test("a copy that fails part-way leaves no half a data directory", () => {
    // Root reads anything, so there is no unreadable file to trip on there.
    if (process.getuid?.() === 0) return;
    const source = join(dataDir, "with-locked");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "a.db"), "state");
    writeFileSync(join(source, "locked"), "secret", { mode: 0o000 });
    const target = join(dataDir, "half");
    expect(() => cloneDir(source, target)).toThrow();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.copying`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runs: tokens, bounds, checks — pure core/db, no HTTP.
// ---------------------------------------------------------------------------

describe("rule 6: a run token dies with the run, and only with the run", () => {
  let dataDir: string;
  let app: App;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tokens-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a token past its expires_at is refused, even though the row still exists", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const minted = createToken(app.db, alice.id, "expired", "rw", {
      expiresAt: past,
    });
    const verified = verifyToken(app.db, minted.token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error).toBe("invalid_token");
  });

  test("a token with no expiry keeps working", () => {
    const minted = createToken(app.db, alice.id, "forever", "rw");
    const verified = verifyToken(app.db, minted.token);
    expect(verified.ok).toBe(true);
  });

  test("a token expiring one millisecond from now is refused once that instant passes", async () => {
    // Half a second, not a few milliseconds: on a loaded test shard the
    // first verify could otherwise land after the instant and read red.
    const soon = new Date(Date.now() + 500).toISOString();
    const minted = createToken(app.db, alice.id, "soon", "rw", {
      expiresAt: soon,
    });
    expect(verifyToken(app.db, minted.token).ok).toBe(true);
    await Bun.sleep(600);
    expect(verifyToken(app.db, minted.token).ok).toBe(false);
  });
});

describe("rule 6, end to end: the crew's per-run token", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let bot: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-token-"));
    work = await mkdtemp(join(tmpdir(), "forge-crew-token-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const madeRepo = await createRepo(app, alice, { name: "tok-repo" });
    if (!madeRepo.ok) throw new Error(String(madeRepo.error));
    repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    const madeAgent = await createAgent(app, alice, {
      username: "bot",
      model: "",
      brief: "",
    });
    if (!madeAgent.ok) throw new Error(String(madeAgent.error));
    bot = madeAgent.value.user;
    addToCrew(app, alice, repo, "bot");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the token minted for a run is gone the instant the run finishes, win or lose", async () => {
    const issue = openIssue(app, alice, repo, { title: "Do a thing" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    const assigned = assignIssue(app, alice, repo, issue.value, bot);
    expect(assigned.ok).toBe(true);
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.value.id,
      actorId: bot.id,
      reason: "assigned",
    });
    // A binary that cannot possibly exist: the clone succeeds (a real
    // repo), and the run fails invoking Claude Code — the failure path a
    // real "the operator hasn't set FORGE_CLAUDE up yet" run also takes.
    await executeAgentRun(app, run, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude-binary"),
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 20_000,
    });
    const finished = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.id === run.id,
    );
    expect(finished?.state).toBe("failed");
    const tokens = listTokens(app.db, bot.id);
    expect(tokens.find((t) => t.name === `run:${run.id}`)).toBeUndefined();
  }, 30_000);

  test("a token is not double-minted across a resumed session; each run gets its own name", async () => {
    // Two runs about the same issue must each carry their own token name
    // (`run:<id>`), so cancelling or finishing one never touches another
    // run's credential.
    const issue = openIssue(app, alice, repo, { title: "Another thing" });
    if (!issue.ok) throw new Error("setup failed");
    const runA = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.value.id,
      actorId: bot.id,
      reason: "assigned",
    });
    const runB = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.value.id,
      actorId: bot.id,
      reason: "feedback",
    });
    await executeAgentRun(app, runA, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude-binary"),
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 20_000,
    });
    // runA's token must be gone; runB was never claimed, so nothing was
    // minted for it yet — proving the two are independent.
    expect(
      listTokens(app.db, bot.id).find((t) => t.name === `run:${runA.id}`),
    ).toBeUndefined();
    expect(
      listTokens(app.db, bot.id).find((t) => t.name === `run:${runB.id}`),
    ).toBeUndefined();
    cancelRun(app.db, runB.id, "cleanup");
  }, 30_000);
});

describe("rule 7: CHECK_FAILED_LIMIT bounds automatic follow-ups", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let repo: Repo;
  let bot: User;
  let pull: Pull;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-bound-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const madeRepo = await createRepo(app, alice, { name: "bound-repo" });
    if (!madeRepo.ok) throw new Error(String(madeRepo.error));
    repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    const madeAgent = await createAgent(app, alice, {
      username: "bot",
      model: "",
      brief: "",
    });
    if (!madeAgent.ok) throw new Error(String(madeAgent.error));
    bot = madeAgent.value.user;
    addToCrew(app, alice, repo, "bot");
    await commitToBranch(app, alice, repo, {
      branch: "bot/1-thing",
      base: repo.defaultBranch,
      message: "bot work",
      files: [{ path: "BOT.md", content: "work\n" }],
    });
    const opened = await openPull(app, bot, repo, {
      title: "Bot work",
      baseBranch: repo.defaultBranch,
      headBranch: "bot/1-thing",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
    // Started so dispatch.ts's `route` is subscribed to the bus; the
    // binary never runs because every queued run is resolved by hand
    // below, deterministically, with no dependence on the pump's tick.
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude-binary"),
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 20_000,
    });
    // Opening a pull as the agent assigns it to that agent, so the sweep
    // `startCrew` just ran queued its own "assigned" run for it. Drain
    // that before the test starts, or it sits "queued"/"running" and
    // `queueAgentRun`'s own single-flight guard silently swallows the
    // first `check_failed` announcement below.
    resolveAllActiveAgentRuns();
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Fabricate and announce a failed deploy for the pull's current head. */
  function announceFailedDeploy(): void {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "push",
    });
    const claimed = claimRun(app.db, run.id)!;
    const finished = finishRun(app.db, claimed.id, {
      state: "failed",
      summary: "the tests failed",
    })!;
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      payload: {
        runId: finished.id,
        kind: "deploy",
        state: "failed",
        issueId: pull.id,
      },
    });
  }

  /**
   * Resolve every agent run currently active on the pull — not just the
   * newest one — so a leftover from the sweep's own "assigned" run (or
   * anything else queued alongside it) never masquerades as the
   * `check_failed` follow-up this test is trying to isolate.
   */
  function resolveAllActiveAgentRuns(): void {
    for (;;) {
      const active = activeRunFor(app.db, "agent", pull.id);
      if (active === undefined) return;
      const claimed = claimRun(app.db, active.id) ?? active;
      finishRun(app.db, claimed.id, {
        state: "ok",
        summary: "resolved by test",
      });
    }
  }

  test("the third automatic follow-up in a row is refused; a person's word resets the count", () => {
    const before = () =>
      listRuns(app.db, repo.id, { kind: "agent" }).filter(
        (r) => r.issueId === pull.id && r.reason === "check_failed",
      ).length;

    expect(before()).toBe(0);
    announceFailedDeploy();
    expect(before()).toBe(1); // first follow-up: allowed
    resolveAllActiveAgentRuns();

    announceFailedDeploy();
    expect(before()).toBe(2); // second follow-up: allowed (at the limit)
    resolveAllActiveAgentRuns();

    announceFailedDeploy();
    expect(before()).toBe(2); // third: refused — the bound held

    // A person speaks on the pull.
    addComment(app, alice, repo, pull, "please look into this");
    resolveAllActiveAgentRuns(); // the feedback run the comment itself queued

    // The count is measured since the last human word, so it is zero again.
    expect(automaticRunsSince(app.db, pull.id, new Date().toISOString())).toBe(
      0,
    );
    announceFailedDeploy();
    expect(before()).toBe(3); // allowed again after a person spoke
  });
});

// ---------------------------------------------------------------------------
// Migration 14 on a database that predates it.
// ---------------------------------------------------------------------------

describe("migration 14 on an existing database", () => {
  test("an existing user survives the upgrade with kind 'user' and is_agent 0; the new tables exist", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-migration-"));
    try {
      const dbPath = join(dataDir, "forge.db");
      // Schema 13: apps/runs/crew (migration 14, index 13) not yet applied.
      // `createUser` always writes `is_agent` — the *current* schema's
      // shape — so a pre-migration insert has to speak schema 13 directly,
      // the way an actual row from that era would look on disk.
      const before = migrations.slice(0, 13);
      const early = openDb(dbPath, before);
      const userId = "pioneer-user-id";
      early
        .query(
          "INSERT INTO user (id, username, email, password_hash, display_name, is_admin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .run(
          userId,
          "pioneer",
          "pioneer@forge.local",
          "not-a-real-hash",
          "Pioneer",
          0,
        );
      early.close();

      const upgraded = openDb(dbPath, migrations);
      const row = upgraded
        .query<
          { kind: string; is_agent: number },
          [string]
        >("SELECT kind, is_agent FROM user WHERE id = ?1")
        .get(userId);
      expect(row?.kind).toBe("user");
      expect(row?.is_agent).toBe(0);

      // The new tables exist and are queryable.
      for (const table of ["app", "run", "agent", "repo_crew"]) {
        expect(() =>
          upgraded.query(`SELECT COUNT(*) FROM ${table}`).get(),
        ).not.toThrow();
      }
      upgraded.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The full stack: a booted forge, a runtime, host routing, grants, the
// proxy, and the mechanical rules that only show themselves under load.
// ---------------------------------------------------------------------------

describe("boot: a forge addressed by IP hands every app a host that works (issue #269)", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let domain: string;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
      redirect: "manual",
    });

  async function settled(
    repoId: string,
    where: (run: Run) => boolean,
    timeoutMs = 60_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repoId, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(50);
    }
    throw new Error("run did not settle in time");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ip-"));
    work = await mkdtemp(join(tmpdir(), "forge-ip-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // The exact computation main.ts does at boot, for a forge reached at
    // `http://127.0.0.1:<port>` with no FORGE_APP_DOMAIN set — the report in
    // the issue. Before this fix, the domain below was `127.0.0.1` and every
    // app's FORGE_APP_URL failed `new URL()` before it ever answered.
    const resolved = resolveAppDomain({
      explicit: undefined,
      hosted: false,
      hostname: "127.0.0.1",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.reason);
    domain = resolved.domain;
    runtime = new AppsRuntime(app, {
      domain,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the scaffolded app deploys and answers — never the FORGE_APP_URL crash loop", async () => {
    const made = await newApp(app, alice, {
      name: "ip-forge",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    const record = made.value.app;
    const run = await settled(repo.id, (r) => r.env === "production");
    // Before this fix: "start: exited with code 1 before answering" — the
    // scaffold's own src/env.ts throwing on `new URL(FORGE_APP_URL)`.
    expect(run.state).toBe("ok");
    const url = runtime.urlFor(record, "production");
    // The exact check the scaffold makes at import time on FORGE_APP_URL.
    expect(() => new URL(url)).not.toThrow();
    const host = new URL(url).host;
    const page = await viaHost(host);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>ip-forge</h1>");
  }, 90_000);
});

describe("manifest: service kind", () => {
  const svc = (app: object) =>
    parseManifest(
      JSON.stringify({ app: { kind: "service", run: "x", ...app } }),
      undefined,
    );
  test("a service declares ports, placement and volumes", () => {
    const r = svc({
      ports: [25565],
      placement: "metal",
      volumes: [{ path: "world", sync: 60 }],
    });
    expect(r.ok && r.value.service).toEqual({
      ports: [{ port: 25565, protocol: "tcp" }],
      alwaysOn: true,
      placement: "metal",
      volumes: [{ path: "world", sync: 60 }],
    });
  });
  test("a web app has no service", () => {
    const r = parseManifest(JSON.stringify({ app: { run: "x" } }), undefined);
    expect(r.ok && r.value.service).toBeNull();
  });
  test("bad declarations fail closed", () => {
    for (const bad of [
      {},
      { ports: [] },
      { ports: [80] },
      { ports: [25565, 25565] },
      { ports: ["25565"] },
      { ports: [25565], always_on: false },
      { ports: [25565], placement: "moon" },
      { ports: [25565], volumes: [{ path: "../etc" }] },
      { ports: [25565], volumes: [{ path: "/abs" }] },
      { ports: [25565], volumes: [{ path: "w", sync: 1 }] },
    ])
      expect(svc(bad).ok).toBe(false);
    expect(
      parseManifest(JSON.stringify({ app: { run: "x", kind: "vm" } }), undefined)
        .ok,
    ).toBe(false);
  });
});
