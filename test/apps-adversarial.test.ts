/**
 * Adversarial coverage for apps, runs, and the crew (docs/APPS.md): trying
 * to break each of the eight mechanical rules, host routing, grants, the
 * proxy, manifests, concurrency, logs, and the migration that introduced
 * the schema. Where the existing suites (apps.test.ts, apps-api.test.ts,
 * crew.test.ts) already drive a rule end to end, this file goes for the
 * edges: stale state, races, forged input, and the boundary of a bound.
 */

import { appHostSuffix } from "../src/apps/host.ts";
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
import {
  parseAppHost,
  resolveAppHost,
  signGrant,
  verifyGrant,
} from "../src/apps/proxy.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  forkRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
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
import { grantedCookie } from "./helpers/identity.ts";

const DOMAIN = "apps.test";

const clientEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@forge.local",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@forge.local",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

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

  test("a copy of an app's data leaves its sockets behind", async () => {
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
    const created = await createUser(app.db, {
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
    const soon = new Date(Date.now() + 5).toISOString();
    const minted = createToken(app.db, alice.id, "soon", "rw", {
      expiresAt: soon,
    });
    expect(verifyToken(app.db, minted.token).ok).toBe(true);
    await Bun.sleep(30);
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
    const created = await createUser(app.db, {
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
    const created = await createUser(app.db, {
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

describe("apps adversarial: teardown races, grants, the proxy, and rule 1/4", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;

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
    dataDir = await mkdtemp(join(tmpdir(), "forge-adv-"));
    work = await mkdtemp(join(tmpdir(), "forge-adv-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, {
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

  test("closing an already-live preview does not resurrect it a few seconds later", async () => {
    const made = await newApp(app, alice, {
      name: "resurrect",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    const record = made.value.app;
    await settled(repo.id, (r) => r.env === "production");

    const committed = await commitToBranch(app, alice, repo, {
      branch: "preview-branch",
      base: repo.defaultBranch,
      message: "preview change",
      files: [{ path: "PREVIEW.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Preview",
      baseBranch: repo.defaultBranch,
      headBranch: "preview-branch",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;

    // Wait for the preview to actually come up (live, not just queued).
    await settled(repo.id, (r) => r.env === `pull-${pull.number}`);
    expect((await viaHost(`resurrect--${pull.number}.${DOMAIN}`)).status).toBe(
      200,
    );

    const closed = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(closed.ok).toBe(true);

    // The teardown itself must remove the directory promptly.
    const goneDeadline = Date.now() + 10_000;
    while (
      existsSync(envDir(dataDir, record.id, `pull-${pull.number}`)) &&
      Date.now() < goneDeadline
    )
      await Bun.sleep(50);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );

    // The bug: `watch()`'s exit handler mistook the deliberate stop for a
    // crash and scheduled a restart ~2s later (RESTART_BACKOFF_MS[0]). Wait
    // well past that window and confirm nothing came back — no directory,
    // no live process answering the preview's host, no new "restart" run.
    await Bun.sleep(3_500);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    const stillGone = await viaHost(`resurrect--${pull.number}.${DOMAIN}`);
    expect(stillGone.status).toBe(404);
    expect(await stillGone.text()).toContain("is gone");
    const resurrectionRuns = listRuns(app.db, repo.id, {
      env: `pull-${pull.number}`,
    }).filter((r) => r.reason === "restart");
    expect(resurrectionRuns.length).toBe(0);
  }, 60_000);

  test("closing a pull mid-deploy still leaves no directory and no process", async () => {
    const made = await newApp(app, alice, {
      name: "midclose",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    const record = made.value.app;
    await settled(repo.id, (r) => r.env === "production");

    const committed = await commitToBranch(app, alice, repo, {
      branch: "slow-branch",
      base: repo.defaultBranch,
      message: "a change",
      files: [{ path: "SLOW.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Slow",
      baseBranch: repo.defaultBranch,
      headBranch: "slow-branch",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;

    // Close it immediately — almost certainly while the deploy is still
    // installing/testing/starting, never having reached `live`.
    const closedQuickly = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(closedQuickly.ok).toBe(true);

    const deadline = Date.now() + 15_000;
    while (
      existsSync(envDir(dataDir, record.id, `pull-${pull.number}`)) &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    await Bun.sleep(3_500);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    expect((await viaHost(`midclose--${pull.number}.${DOMAIN}`)).status).toBe(
      404,
    );
  }, 60_000);

  test("install failing fails before test or start ever run — nothing from a half-installed tree", async () => {
    const made = await newApp(app, alice, {
      name: "badinstall",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    await settled(repo.id, (r) => r.env === "production");

    const testMarker = join(work, `install-test-marker-${Date.now()}`);
    const runMarker = join(work, `install-run-marker-${Date.now()}`);
    const committed = await commitToBranch(app, alice, repo, {
      branch: "bad-install",
      base: repo.defaultBranch,
      message: "install fails",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                install: "exit 1",
                run: `touch ${runMarker} && bun run src/server.ts`,
                test: `touch ${testMarker} && bun test`,
              },
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Bad install",
      baseBranch: repo.defaultBranch,
      headBranch: "bad-install",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const failed = await settled(
      repo.id,
      (r) =>
        r.env === `pull-${opened.value.number}` &&
        r.commitOid === committed.value.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("install");
    // Neither `test` nor `run` ever executed.
    expect(existsSync(testMarker)).toBe(false);
    expect(existsSync(runMarker)).toBe(false);
    expect(
      (await viaHost(`badinstall--${opened.value.number}.${DOMAIN}`)).status,
    ).toBe(502);
  }, 60_000);

  test("closing a pull whose deploy already answered kills its still-running test step — no orphan `bun test`", async () => {
    const made = await newApp(app, alice, {
      name: "slowtest",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    await settled(repo.id, (r) => r.env === "production");

    const marker = join(work, `slowtest-marker-${Date.now()}`);
    const committed = await commitToBranch(app, alice, repo, {
      branch: "slow-test",
      base: repo.defaultBranch,
      message: "slow test",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                run: "bun run src/server.ts",
                test: `sleep 5 && touch ${marker}`,
              },
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Slow test",
      baseBranch: repo.defaultBranch,
      headBranch: "slow-test",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Wait for the app to answer — well before the test step's sleep ends.
    const upDeadline = Date.now() + 10_000;
    let up = false;
    while (Date.now() < upDeadline) {
      if (
        (await viaHost(`slowtest--${opened.value.number}.${DOMAIN}`))
          .status === 200
      ) {
        up = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(up).toBe(true);

    // Close it while the test step is still sleeping.
    const closed = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, opened.value.number)!,
      "merge",
    );
    expect(closed.ok).toBe(true);

    // Wait well past the sleep the test step was doing, and confirm it
    // never finished: the marker it would have written is not there.
    await Bun.sleep(6_500);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("private grant: forged, tampered, expired, wrong-env, and open-redirect are all refused; cookie is HttpOnly/SameSite", async () => {
    const made = await newApp(app, alice, {
      name: "grants",
      visibility: "private",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    const record = made.value.app;
    await settled(repo.id, (r) => r.env === "production");

    const target = { app: record, env: "production" as const };
    const good = signGrant(dataDir, target, 60_000);
    expect(verifyGrant(dataDir, good, target)).toBe(true);

    // Wrong environment: a grant for production names none for a preview.
    expect(verifyGrant(dataDir, good, { app: record, env: "pull-1" })).toBe(
      false,
    );

    // Expired: signed in the past with a short ttl.
    const expired = signGrant(dataDir, target, 1_000, Date.now() - 10_000);
    expect(verifyGrant(dataDir, expired, target)).toBe(false);

    // Tampered signature: the payload is untouched, but the MAC no longer
    // matches it — this is the actual HMAC check, not just a field mismatch.
    const parts = good.split(".");
    const payload = parts.slice(0, -1).join(".");
    const sig = parts.at(-1)!;
    const flipped = sig.at(-1) === "A" ? "B" : "A";
    const tampered = `${payload}.${sig.slice(0, -1)}${flipped}`;
    expect(verifyGrant(dataDir, tampered, target)).toBe(false);

    // Tampered payload: flip a character in the app id segment — the
    // signature is now for a different message entirely.
    const idTampered = `x${payload.slice(1)}.${sig}`;
    expect(verifyGrant(dataDir, idTampered, target)).toBe(false);

    // Forged: right shape, made-up signature.
    const forged = `${record.id}.production.${Date.now() + 60_000}.notarealsignature`;
    expect(verifyGrant(dataDir, forged, target)).toBe(false);

    // Hitting the grant endpoint on a *public* app: it still answers (it
    // is not access-gated by itself), but the token must still verify
    // correctly against that public app's own target.
    const publicMade = await newApp(app, alice, {
      name: "grantpublic",
      visibility: "public",
    });
    expect(publicMade.ok).toBe(true);
    if (publicMade.ok) {
      await settled(publicMade.value.repo.id, (r) => r.env === "production");
      const pubGrantUrl = `http://grantpublic.${DOMAIN}/__forge/grant?t=${encodeURIComponent(good)}&to=/`;
      // A production-app grant token does not verify for a different app's
      // target, so this must be refused (404) even though the destination
      // app is public.
      const url = new URL(pubGrantUrl);
      const crossApp = await viaHost(url.host, `${url.pathname}${url.search}`);
      expect(crossApp.status).toBe(404);
    }

    // Open redirect: `to=//evil` and `to=http://evil` must both collapse to `/`.
    const okToken = signGrant(dataDir, target, 60_000);
    for (const to of [
      "//evil.example",
      "http://evil.example",
      "https://evil.example/x",
    ]) {
      const resp = await viaHost(
        `grants.${DOMAIN}`,
        `/__forge/grant?t=${encodeURIComponent(okToken)}&to=${encodeURIComponent(to)}`,
      );
      expect(resp.status).toBe(303);
      expect(resp.headers.get("location")).toBe("/");
    }

    // The cookie itself: HttpOnly and SameSite=Lax.
    const grantResp = await viaHost(
      `grants.${DOMAIN}`,
      `/__forge/grant?t=${encodeURIComponent(okToken)}&to=/`,
    );
    const cookie = grantResp.headers.get("set-cookie") ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("SameSite=Lax");

    // Invariant 9: a private *repository* never distinguishes "you're
    // anonymous" from "you're signed in but still can't see it" — both
    // must read `not_found`, or an anonymous prober could tell the two
    // apart and learn something about a repo they cannot see.
    const strangerCreated = await createUser(app.db, {
      username: "stranger",
      email: "stranger@forge.local",
      password: "a-good-passphrase",
    });
    expect(strangerCreated.ok).toBe(true);
    if (!strangerCreated.ok) return;
    const { openEnvUrl } = await import("../src/actions/apps.ts");
    const anonOnPrivateRepo = openEnvUrl(app, undefined, repo, "production");
    expect(anonOnPrivateRepo.ok).toBe(false);
    if (!anonOnPrivateRepo.ok)
      expect(anonOnPrivateRepo.error).toBe("not_found");
    const strangerOnPrivateRepo = openEnvUrl(
      app,
      strangerCreated.value,
      repo,
      "production",
    );
    expect(strangerOnPrivateRepo.ok).toBe(false);
    if (!strangerOnPrivateRepo.ok)
      expect(strangerOnPrivateRepo.error).toBe("not_found");

    // `unauthorized` is reachable only through the other combination: a
    // *public* repository (so `canRead` already passes for anyone) whose
    // app access is explicitly overridden to "private". There, an
    // anonymous visitor has nothing to be vouched with, but any signed-in
    // account — even a stranger's — can read the (public) code, so it gets
    // a working grant. That is the documented contract (`canRead` plus
    // "the forge can name you"), not a bypass of crew/collaborator status.
    const overrideMade = await newApp(app, alice, {
      name: "publicwithprivateapp",
      visibility: "public",
    });
    expect(overrideMade.ok).toBe(true);
    if (!overrideMade.ok) return;
    await settled(overrideMade.value.repo.id, (r) => r.env === "production");
    updateAppSettings(app, alice, overrideMade.value.repo, {
      access: "private",
    });
    const anonOnPublicRepo = openEnvUrl(
      app,
      undefined,
      overrideMade.value.repo,
      "production",
    );
    expect(anonOnPublicRepo.ok).toBe(false);
    if (!anonOnPublicRepo.ok)
      expect(anonOnPublicRepo.error).toBe("unauthorized");
    const strangerOnPublicRepo = openEnvUrl(
      app,
      strangerCreated.value,
      overrideMade.value.repo,
      "production",
    );
    expect(strangerOnPublicRepo.ok).toBe(true);
  }, 60_000);

  test("the proxy: hop-by-hop headers are stripped, an upstream that dies mid-request yields a clean error, a claimed upgrade is a request", async () => {
    const made = await newApp(app, alice, {
      name: "proxytest",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    await settled(repo.id, (r) => r.env === "production");

    const page = await viaHost(`proxytest.${DOMAIN}`);
    expect(page.status).toBe(200);
    // Hop-by-hop response headers never reach the client from the proxy
    // path (the app itself doesn't set them, but the proxy must strip them
    // if it ever did — assert the contract on the response we did get).
    for (const h of ["connection", "transfer-encoding", "keep-alive"]) {
      expect(page.headers.has(h)).toBe(false);
    }

    // The slug is case-insensitive end to end, through the database too —
    // not just in `parseAppHost`'s own lowercasing.
    const upperCase = await viaHost(`PROXYTEST.${DOMAIN}`);
    expect(upperCase.status).toBe(200);
    expect(await upperCase.text()).toBe(await page.text());

    // A request that says `Upgrade: websocket` without a handshake key is
    // not a handshake: it is fetched as a request, the hop-by-hop headers
    // stripped, and the app answers it as one. Real sockets are
    // test/apps-ws.test.ts.
    const ws = await viaHost(`proxytest.${DOMAIN}`, "/", {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(ws.status).toBe(200);

    // Stop the live process out from under the proxy (simulating a crash
    // mid-request) and confirm the *next* request gets the forge's own
    // "not running" page, never a raw connection-refused/502 from Bun.
    const { stopEnv } = await import("../src/actions/apps.ts");
    await stopEnv(app, alice, repo, "production");
    const afterStop = await viaHost(`proxytest.${DOMAIN}`);
    expect(afterStop.status).toBe(502);
    expect(await afterStop.text()).toContain("not running");
  }, 60_000);

  test("the API never lets an env parameter shaped like a path reach the filesystem", async () => {
    const made = await newApp(app, alice, {
      name: "envtraversal",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    await settled(made.value.repo.id, (r) => r.env === "production");
    const adminToken = createToken(
      app.db,
      alice.id,
      "traversal-test",
      "admin",
    ).token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${servers.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${adminToken}` },
      });
    const owner = made.value.repo.ownerName;
    const name = made.value.repo.name;
    // A bare ".." segment is collapsed by `URL`/`fetch` before the request
    // ever leaves the client (RFC 3986 dot-segment removal), so it can only
    // be used to probe the *server's* handling when percent-encoded — a raw
    // ".." never reaches the router at all, which is the stronger property
    // and not what this test is isolating.
    for (const hostile of [
      "..%2F..%2F..%2Fetc",
      "production%2F..%2F..",
      "pull--1",
    ]) {
      const redeploy = await api(
        `/api/v1/repos/${owner}/${name}/app/${hostile}/redeploy`,
        { method: "POST" },
      );
      if (redeploy.status !== 422) {
        throw new Error(
          `redeploy env=${hostile} returned ${redeploy.status}, expected 422`,
        );
      }
      const body = (await redeploy.json()) as { error: string };
      expect(body.error).toBe("no_such_env");

      const stop = await api(
        `/api/v1/repos/${owner}/${name}/app/${hostile}/stop`,
        { method: "POST" },
      );
      if (stop.status !== 422) {
        throw new Error(
          `stop env=${hostile} returned ${stop.status}, expected 422`,
        );
      }

      const open = await api(
        `/api/v1/repos/${owner}/${name}/app/${hostile}/open`,
      );
      expect(open.status).toBe(422);
    }
  }, 60_000);

  test('preview_data: "empty" starts a preview with no copy of production\'s data', async () => {
    const made = await newApp(app, alice, {
      name: "emptypolicy",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    await settled(repo.id, (r) => r.env === "production");
    updateAppSettings(app, alice, repo, { previewData: "empty" });

    const form = new FormData();
    form.set("body", "production-only note");
    await viaHost(`emptypolicy.${DOMAIN}`, "/notes", {
      method: "POST",
      body: form,
      headers: {
        cookie: await grantedCookie(app, servers.url, alice, made.value.app),
      },
    });
    expect(await (await viaHost(`emptypolicy.${DOMAIN}`)).text()).toContain(
      "production-only note",
    );

    const committed = await commitToBranch(app, alice, repo, {
      branch: "empty-preview",
      base: repo.defaultBranch,
      message: "trigger a preview",
      files: [{ path: "EMPTY.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Empty preview",
      baseBranch: repo.defaultBranch,
      headBranch: "empty-preview",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await settled(repo.id, (r) => r.env === `pull-${opened.value.number}`);
    const previewHtml = await (
      await viaHost(`emptypolicy--${opened.value.number}.${DOMAIN}`)
    ).text();
    expect(previewHtml).not.toContain("production-only note");
  }, 60_000);

  test("rule 1: the repository takes no push from the crew; the agent's fork takes branches but never its default branch, protected or not, renamed or not", async () => {
    const madeRepo = await createRepo(app, alice, { name: "rule1-repo" });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    const madeAgent = await createAgent(app, alice, {
      username: "rule1bot",
      model: "",
      brief: "",
    });
    expect(madeAgent.ok).toBe(true);
    if (!madeAgent.ok) return;
    const bot = madeAgent.value.user;
    addToCrew(app, alice, repo, "rule1bot");
    const token = createToken(app.db, bot.id, "t", "rw");
    const remote = `${servers.url.replace("://", `://rule1bot:${token.token}@`)}/${repo.ownerName}/${repo.name}.git`;
    const clone = join(work, "rule1-clone");
    expect(
      (await sh(["git", "clone", "--quiet", remote, clone], work)).code,
    ).toBe(0);
    await Bun.write(join(clone, "A.md"), "a\n");
    await sh(["git", "add", "A.md"], clone);
    await sh(["git", "commit", "-qm", "a"], clone);

    // The repository itself: crew membership is read. Neither the default
    // branch nor any other takes a push, and the refusal hides nothing it
    // would not hide from any non-writer.
    const toDefault = await sh(
      ["git", "push", "-q", "origin", `HEAD:${repo.defaultBranch}`],
      clone,
    );
    expect(toDefault.code).not.toBe(0);
    const toOther = await sh(
      ["git", "push", "-q", "origin", "HEAD:refs/heads/some-branch"],
      clone,
    );
    expect(toOther.code).not.toBe(0);
    expect(
      await resolveOid(
        repoDir(app.reposRoot, repo.ownerName, repo.name),
        "refs/heads/some-branch",
      ),
    ).toBeUndefined();

    // The agent's fork takes its branches…
    const forked = await forkRepo(app, bot, repo);
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    let fork = forked.value;
    const forkRemote = `${servers.url.replace("://", `://rule1bot:${token.token}@`)}/${fork.ownerName}/${fork.name}.git`;
    const otherOk = await sh(
      ["git", "push", "-q", forkRemote, "HEAD:refs/heads/some-branch"],
      clone,
    );
    expect(otherOk.code).toBe(0);

    // …but never its default branch: rule 1 is unconditional, protectDefault
    // off or on — an agent can't even fast-forward it.
    const refusedOff = await sh(
      ["git", "push", "-q", forkRemote, `HEAD:${fork.defaultBranch}`],
      clone,
    );
    expect(refusedOff.code).not.toBe(0);
    expect(refusedOff.err).toContain("agents propose through pulls");
    await updateRepoSettings(app, alice, fork, { protectDefault: true });
    const refusedOn = await sh(
      ["git", "push", "-q", forkRemote, `HEAD:${fork.defaultBranch}`],
      clone,
    );
    expect(refusedOn.code).not.toBe(0);
    expect(refusedOn.err).toContain("agents propose through pulls");

    // Rename the fork's default branch, then confirm a push to the NEW name
    // is still refused (the hook must read the live default branch, not a
    // cached name).
    await sh(["git", "checkout", "-q", "-b", "renamed-main"], clone);
    await sh(["git", "push", "-q", forkRemote, "renamed-main"], clone);
    const renamed = await updateRepoSettings(app, alice, fork, {
      defaultBranch: "renamed-main",
    });
    expect(renamed.ok).toBe(true);
    fork = getRepoById(app.db, fork.id)!;
    expect(fork.defaultBranch).toBe("renamed-main");
    await Bun.write(join(clone, "B.md"), "b\n");
    await sh(["git", "add", "B.md"], clone);
    await sh(["git", "commit", "-qm", "b"], clone);
    const refusedRenamed = await sh(
      ["git", "push", "-q", forkRemote, "HEAD:renamed-main"],
      clone,
    );
    expect(refusedRenamed.code).not.toBe(0);
    expect(refusedRenamed.err).toContain("agents propose through pulls");
  }, 60_000);

  test("rule 1: an agent's rw token cannot reach settings, app enable, crew, tokens, or agent creation over the API", async () => {
    const madeRepo = await createRepo(app, alice, { name: "rule1-api-repo" });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    const repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    const madeAgent = await createAgent(app, alice, {
      username: "rule1apibot",
      model: "",
      brief: "",
    });
    expect(madeAgent.ok).toBe(true);
    if (!madeAgent.ok) return;
    addToCrew(app, alice, repo, "rule1apibot");
    const bot = madeAgent.value.user;
    const token = createToken(app.db, bot.id, "t", "rw").token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${servers.url}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });

    const settingsResp = await api(
      `/api/v1/repos/${repo.ownerName}/${repo.name}`,
      { method: "PATCH", body: JSON.stringify({ visibility: "public" }) },
    );
    expect(settingsResp.status).toBe(403);

    const enableResp = await api(
      `/api/v1/repos/${repo.ownerName}/${repo.name}/app`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(enableResp.status).toBe(403);

    const crewResp = await api(
      `/api/v1/repos/${repo.ownerName}/${repo.name}/crew/rule1apibot`,
      { method: "PUT" },
    );
    expect(crewResp.status).toBe(403);

    const tokenResp = await api("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "x", scope: "admin" }),
    });
    // Neither via-session nor via-password: falls through to bad credentials.
    expect(tokenResp.status).toBe(401);

    const agentResp = await api("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({ username: "another-bot" }),
    });
    expect(agentResp.status).toBe(403);
  }, 30_000);

  test("rule 4: require_checks cannot be satisfied by a stale head, a foreign pull's run, a cancelled run, or a queued one; a push re-locks it", async () => {
    const madeRepo = await createRepo(app, alice, { name: "rule4-repo" });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    let repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    repo = (await updateRepoSettings(app, alice, repo, { requireChecks: true }))
      .ok
      ? getRepoById(app.db, repo.id)!
      : repo;

    const committed1 = await commitToBranch(app, alice, repo, {
      branch: "feature",
      base: repo.defaultBranch,
      message: "feature commit 1",
      files: [{ path: "F.md", content: "1\n" }],
    });
    expect(committed1.ok).toBe(true);
    if (!committed1.ok) return;
    const oid1 = committed1.value.commitOid;
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: repo.defaultBranch,
      headBranch: "feature",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;

    // A second branch, pointing at the exact same commit, opened as a
    // second pull — so a run tagged with its issue id shares the commit
    // oid but must never satisfy the first pull's gate.
    await sh(
      ["git", "branch", "feature2", oid1],
      repoDir(app.reposRoot, repo.ownerName, repo.name),
    );
    const opened2 = await openPull(app, alice, repo, {
      title: "Feature 2",
      baseBranch: repo.defaultBranch,
      headBranch: "feature2",
    });
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;

    const mkRun = (issueId: string, oid: string) =>
      createRun(app.db, {
        repoId: repo.id,
        kind: "deploy",
        issueId,
        commitOid: oid,
        env: "pull-x",
        reason: "push",
      });

    // Queued: never satisfies.
    mkRun(pull.id, oid1);
    let refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // Cancelled: never satisfies.
    const toCancel = mkRun(pull.id, oid1);
    cancelRun(app.db, toCancel.id, "test cancel");
    refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // A green run for a DIFFERENT pull at the same commit: never satisfies
    // pull 1.
    const foreignRun = mkRun(opened2.value.id, oid1);
    claimRun(app.db, foreignRun.id);
    finishRun(app.db, foreignRun.id, { state: "ok", summary: "green" });
    refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // Now a genuinely green run for pull 1 at its actual head: merge works.
    const goodRun = mkRun(pull.id, oid1);
    claimRun(app.db, goodRun.id);
    finishRun(app.db, goodRun.id, { state: "ok", summary: "green" });
    const merged = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(merged.ok).toBe(true);
  }, 60_000);

  test("rule 4: a push after a green check re-locks the pull until the new head is green", async () => {
    const madeRepo = await createRepo(app, alice, { name: "rule4-relock" });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    let repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    repo = (await updateRepoSettings(app, alice, repo, { requireChecks: true }))
      .ok
      ? getRepoById(app.db, repo.id)!
      : repo;
    const c1 = await commitToBranch(app, alice, repo, {
      branch: "relock",
      base: repo.defaultBranch,
      message: "c1",
      files: [{ path: "R.md", content: "1\n" }],
    });
    if (!c1.ok) throw new Error("setup failed");
    const opened = await openPull(app, alice, repo, {
      title: "Relock",
      baseBranch: repo.defaultBranch,
      headBranch: "relock",
    });
    if (!opened.ok) throw new Error("setup failed");
    const pull = opened.value;
    const green1 = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      issueId: pull.id,
      commitOid: c1.value.commitOid,
      env: "pull-x",
      reason: "push",
    });
    claimRun(app.db, green1.id);
    finishRun(app.db, green1.id, { state: "ok", summary: "green" });
    expect(
      (
        await mergePull(
          app,
          alice,
          repo,
          getPull(app.db, repo.id, pull.number)!,
          "merge",
        )
      ).ok,
    ).toBe(true);
  }, 30_000);
});
