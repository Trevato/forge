/**
 * The client against a real forge: `createApp` + `serve` in a temp directory,
 * a real user, a real token, two real repos with real commits — and the CLI
 * run the way a shell runs it, as a separate process reading only the
 * environment it is given.
 *
 * The assertions that matter are the safety ones: a second sync changes
 * nothing, a dirty working tree is reported and never touched, and `--ff`
 * moves a repo only when moving it cannot lose anything.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { ForgeApi, Pin } from "../src/cli/api.ts";
import { hostDir } from "../src/cli/config.ts";
import { changesBetween, syncOnce, tokenRefusal, type RepoReport, type SyncReport } from "../src/cli/sync.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

const clientEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@forge.local",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@forge.local",
});

async function sh(args: string[], cwd: string): Promise<string> {
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
  if (code !== 0) throw new Error(`${args.join(" ")} failed: ${err}`);
  return out.trim();
}

describe("the local client, against a real forge", () => {
  let dataDir = "";
  let work = "";
  let root = "";
  let configDir = "";
  let app: App;
  let servers: Servers;
  let base = "";
  let token = "";
  let host = "";

  /** The CLI as a shell would run it: a process, and an environment. */
  async function forge(
    args: string[],
    extra: Record<string, string> = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      cwd: work,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        FORGE_URL: base,
        FORGE_TOKEN: token,
        FORGE_ROOT: root,
        FORGE_CONFIG_DIR: configDir,
        FORGE_KEYCHAIN: "0",
        NO_COLOR: "1",
        ...clientEnv,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  const api = (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    if (token !== "") headers.set("authorization", `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cli-data-"));
    work = await mkdtemp(join(tmpdir(), "forge-cli-work-"));
    root = await mkdtemp(join(tmpdir(), "forge-cli-root-"));
    configDir = await mkdtemp(join(tmpdir(), "forge-cli-config-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    host = hostDir(base);

    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.local",
      password: "correct horse battery",
    });
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "alice",
        password: "correct horse battery",
        name: "cli",
        scope: "rw",
      }),
    });
    token = ((await minted.json()) as { token: string }).token;

    for (const name of ["one", "two"]) {
      await api("/api/v1/repos", {
        method: "POST",
        body: JSON.stringify({ owner: "alice", name, visibility: "private" }),
      });
      const remote = `${base.replace("http://", `http://alice:${token}@`)}/alice/${name}.git`;
      const dir = join(work, `seed-${name}`);
      await sh(["git", "clone", remote, dir], work);
      await writeFile(join(dir, "README.md"), `# ${name}\n`);
      await sh(["git", "add", "-A"], dir);
      await sh(["git", "commit", "-m", "genesis"], dir);
      await sh(["git", "push", "origin", "main"], dir);
      await api(`/api/v1/user/pins/alice/${name}`, { method: "PUT" });
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    for (const dir of [dataDir, work, root, configDir])
      await rm(dir, { recursive: true, force: true });
  });

  test("login verifies the token and writes a 0600 config", async () => {
    // No FORGE_TOKEN in this environment: login has to be the thing that
    // stores it, and the config file has to be the thing that holds it.
    const result = await forge(["login", base, "--token", token], {
      FORGE_URL: "",
      FORGE_TOKEN: "",
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("as alice");

    const path = join(configDir, "config.json");
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await Bun.file(path).text()) as {
      url: string;
      token: string;
    };
    expect(stored.url).toBe(base);
    expect(stored.token).toBe(token);

    // And the stored config alone is enough to be someone.
    const who = await forge(["whoami"], { FORGE_URL: "", FORGE_TOKEN: "" });
    expect(who.code).toBe(0);
    expect(who.out.trim()).toBe(`alice at ${base}`);
  });

  test("login refuses a token the forge does not know", async () => {
    const result = await forge(["login", base, "--token", "forge_nonsense"], {
      FORGE_URL: "",
      FORGE_TOKEN: "",
      FORGE_CONFIG_DIR: join(configDir, "throwaway"),
    });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("forge login");
  });

  test("sync clones every repo into <root>/<host>/<owner>/<name>", async () => {
    const result = await forge(["sync"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("alice/one");
    expect(result.out).toContain("alice/two");
    expect(result.out).toContain("cloned");

    for (const name of ["one", "two"]) {
      const dir = join(root, host, "alice", name);
      expect(await Bun.file(join(dir, ".git/HEAD")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "README.md")).text()).toBe(`# ${name}\n`);
    }
  });

  test("the token never lands in the stored remote", async () => {
    const dir = join(root, host, "alice", "one");
    const remote = await sh(["git", "remote", "get-url", "origin"], dir);
    expect(remote).not.toContain(token);
    expect(remote).toBe(`${base}/alice/one.git`);
  });

  test("a second sync changes nothing and says so", async () => {
    const result = await forge(["sync"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("cloned");
    // Clean, level and holding nothing back: one tick, no words.
    expect(result.out).toContain("\u2713");
    expect(result.out).toMatch(/REPO\s+BRANCH\s+SYNC\s+DIRTY\s+STATE\s+FETCHED/);
  });

  test("status does not fetch; sync does; --ff then moves it", async () => {
    const seed = join(work, "seed-one");
    await writeFile(join(seed, "NEXT.md"), "next\n");
    await sh(["git", "add", "-A"], seed);
    await sh(["git", "commit", "-m", "second"], seed);
    await sh(["git", "push", "origin", "main"], seed);

    // `status` reads the repo, and only the repo: the commit is on the
    // workbench, so a client that fetched would already know about it.
    const offline = await forge(["status"]);
    expect(offline.out).toContain("alice/one");
    expect(offline.out).not.toContain("\u21931");

    const fetched = await forge(["sync"]);
    expect(fetched.out).toMatch(/alice\/one.*\u21931/);

    const dir = join(root, host, "alice", "one");
    expect(await Bun.file(join(dir, "NEXT.md")).exists()).toBe(false);

    const ff = await forge(["sync", "--ff"]);
    expect(ff.code).toBe(0);
    expect(ff.out).toContain("fast-forwarded");
    expect(await Bun.file(join(dir, "NEXT.md")).text()).toBe("next\n");
  });

  test("a dirty working tree is reported and never touched", async () => {
    const dir = join(root, host, "alice", "two");
    await writeFile(join(dir, "README.md"), "# two, edited by hand\n");
    await writeFile(join(dir, "scratch.txt"), "mine\n");

    // Give it something to be behind by, so --ff would act if it could.
    const seed = join(work, "seed-two");
    await writeFile(join(seed, "SERVER.md"), "server\n");
    await sh(["git", "add", "-A"], seed);
    await sh(["git", "commit", "-m", "server side"], seed);
    await sh(["git", "push", "origin", "main"], seed);

    const result = await forge(["sync", "--ff"]);
    expect(result.code).toBe(0);
    // Dirty is a count in its own column, not a sentence in the state column.
    expect(result.out).toMatch(/alice\/two\s+\S+\s+\S*\s*2\s/);
    expect(result.out).not.toMatch(/alice\/two.*fast-forwarded/);
    expect(await Bun.file(join(dir, "README.md")).text()).toBe(
      "# two, edited by hand\n",
    );
    expect(await Bun.file(join(dir, "scratch.txt")).text()).toBe("mine\n");
    expect(await Bun.file(join(dir, "SERVER.md")).exists()).toBe(false);
  });

  test("ls names what is here and where", async () => {
    const result = await forge(["ls"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(join(root, host));
    expect(result.out).toMatch(/REPO\s+BRANCH\s+SYNC\s+STATE\s+FETCHED/);
    expect(result.out).toContain("alice/one");
    expect(result.out).toContain("alice/two");
  });

  test("--json says the same thing without a table to parse", async () => {
    for (const command of ["status", "ls"]) {
      const result = await forge([command, "--json"]);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out) as {
        root: string;
        repos: {
          owner: string;
          name: string;
          dirty: number;
          behind: number;
          branch: string | null;
          lastFetch: string | null;
        }[];
      };
      expect(report.root).toBe(join(root, host));
      const two = report.repos.find((r) => r.name === "two");
      expect(two?.owner).toBe("alice");
      expect(two?.branch).toBe("main");
      // The repo left dirty by the test above, counted rather than described.
      expect(two?.dirty).toBe(2);
      expect(two?.behind).toBeGreaterThan(0);
      // A table row is text; this is a date a script can compare.
      expect(Date.parse(two?.lastFetch ?? "")).toBeGreaterThan(0);
    }
  });

  test("a watch only speaks when something actually changed", () => {
    const repo = (over: Partial<RepoReport>): RepoReport => ({
      owner: "alice",
      name: "one",
      dir: "/tmp/one",
      present: true,
      cloned: false,
      pinned: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      staged: 0,
      changed: 0,
      untracked: 0,
      conflicted: 0,
      stashes: 0,
      unpushed: [],
      lastFetch: null,
      fastForwarded: false,
      error: null,
      ...over,
    });
    const report = (r: RepoReport): SyncReport => ({
      root: "/tmp",
      repos: [r],
      pinsUnavailable: false,
      failures: r.error === null ? 0 : 1,
    });

    // The same facts twice is silence — a notifier that fires every pass is
    // a notifier that gets muted within the hour.
    const same = report(repo({}));
    expect(changesBetween(same, report(repo({})))).toEqual([]);
    // Even a repeated bad state is silent after the first time it is said.
    const broken = report(repo({ error: "boom" }));
    expect(changesBetween(broken, report(repo({ error: "boom" })))).toEqual([]);
    // A transition is not.
    expect(changesBetween(same, report(repo({ behind: 2 })))).toEqual([
      "alice/one is 2 behind",
    ]);
    expect(changesBetween(same, report(repo({ error: "boom" })))).toEqual([
      "alice/one failed to fetch",
    ]);
    expect(changesBetween(same, report(repo({ present: false })))).toEqual([
      "alice/one is gone",
    ]);
    // And there is nothing to compare against on the first pass.
    expect(changesBetween(null, same)).toEqual([]);
  });

  test("open prints the web URL", async () => {
    const result = await forge(["open", "alice/one"]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(`${base}/alice/one`);
  });

  test("pin says plainly when the forge has no pins yet", async () => {
    const result = await forge(["pin", "alice/one"]);
    if (result.code === 0) {
      // The pins endpoint has landed; then it must have worked.
      expect(result.out).toContain("pinned alice/one");
    } else {
      expect(result.err).toContain("does not support pins");
    }
  });

  test("a bad ref and an unknown command are usage errors", async () => {
    expect((await forge(["pin", "not-a-ref"])).code).toBe(2);
    expect((await forge(["wat"])).code).toBe(2);
  });

  test("without a config or an environment it says how to sign in", async () => {
    const result = await forge(["sync"], {
      FORGE_URL: "",
      FORGE_TOKEN: "",
      FORGE_CONFIG_DIR: join(configDir, "empty"),
    });
    expect(result.code).toBe(3);
    expect(result.err).toContain("forge login");
  });
});

describe("tokenRefusal", () => {
  const wb = "https://forge.example";
  test("only the workbench's own origin over https, or loopback http, gets the token", () => {
    expect(tokenRefusal("https://forge.example/a/b.git", wb)).toBeNull();
    expect(tokenRefusal("http://127.0.0.1:3000/a/b.git", "http://127.0.0.1:3000")).toBeNull();
    expect(tokenRefusal("http://other.example/a/b.git", wb)).toContain("token withheld");
    expect(tokenRefusal("https://other.example/a/b.git", wb)).toContain("token withheld");
    expect(tokenRefusal("http://forge.example/a/b.git", wb)).toContain("token withheld");
    expect(tokenRefusal("https://forge.example:8443/a/b.git", wb)).toContain("token withheld");
    expect(tokenRefusal("http://10.0.0.5/a.git", "http://10.0.0.5")).toContain("token withheld");
    expect(tokenRefusal(null, wb)).toContain("token withheld");
  });
});

describe("the token reaches git only for the workbench's own origin", () => {
  const secret = "tok-secret-7400";
  let tmp = "";
  const seen: { port: number; auth: string | null }[] = [];
  const listeners: ReturnType<typeof Bun.serve>[] = [];

  /** A local listener that records Authorization and refuses every request. */
  function listen(): ReturnType<typeof Bun.serve> {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push({ port: server.port ?? 0, auth: req.headers.get("authorization") });
        return new Response("no", { status: 404 });
      },
    });
    listeners.push(server);
    return server;
  }
  const stubApi = (url: string, pins: Pin[]): ForgeApi =>
    ({
      url,
      pinsUnavailable: false,
      pins: async () => ({ ok: true, value: pins }),
    }) as unknown as ForgeApi;
  const pin = (cloneUrl: string): Pin => ({
    owner: "alice",
    name: "one",
    cloneUrl,
    sshUrl: null,
    defaultBranch: "main",
    origin: null,
  });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "forge-token-"));
  });
  afterAll(async () => {
    for (const l of listeners) l.stop(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("a clone from a foreign cloneUrl is sent without the token", async () => {
    const own = listen();
    const other = listen();
    seen.length = 0;
    const root = join(tmp, "clone");
    const report = await syncOnce({
      api: stubApi(`http://127.0.0.1:${own.port}`, [pin(`http://127.0.0.1:${other.port}/alice/one.git`)]),
      token: secret,
      root,
      fetch: true,
    });
    const one = report.repos[0]!;
    expect(one.note).toContain("token withheld");
    expect(one.error).not.toBeNull();
    const hits = seen.filter((h) => h.port === other.port);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => (h.auth ?? "").startsWith("Bearer"))).toBe(false);
  });

  test("a fetch of an edited origin is sent without the token", async () => {
    const own = listen();
    const other = listen();
    const api = stubApi(`http://127.0.0.1:${own.port}`, []);
    const root = join(tmp, "fetch");
    const dir = join(root, hostDir(api.url), "alice", "one");
    await sh(["git", "init", "-q", dir], tmp);
    await sh(["git", "remote", "add", "origin", `http://127.0.0.1:${other.port}/alice/one.git`], dir);
    seen.length = 0;
    const report = await syncOnce({ api, token: secret, root, fetch: true });
    const one = report.repos[0]!;
    expect(one.note).toContain("token withheld");
    const hits = seen.filter((h) => h.port === other.port);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => (h.auth ?? "").startsWith("Bearer"))).toBe(false);
  });

  test("the workbench's own origin still gets the token, on clone and on fetch", async () => {
    const own = listen();
    const api = stubApi(`http://127.0.0.1:${own.port}`, [pin(`http://127.0.0.1:${own.port}/alice/one.git`)]);
    const root = join(tmp, "own");
    seen.length = 0;
    const first = await syncOnce({ api, token: secret, root, fetch: true });
    expect(first.repos[0]!.note).toBeUndefined();
    expect(seen.some((h) => h.auth === `Bearer ${secret}`)).toBe(true);
    // Not cloned (the listener refuses), so make it a clone to exercise fetch.
    const dir = join(root, hostDir(api.url), "alice", "one");
    await sh(["git", "init", "-q", dir], tmp);
    await sh(["git", "remote", "add", "origin", `http://127.0.0.1:${own.port}/alice/one.git`], dir);
    seen.length = 0;
    const second = await syncOnce({ api, token: secret, root, fetch: true });
    expect(second.repos[0]!.note).toBeUndefined();
    expect(seen.some((h) => h.auth === `Bearer ${secret}`)).toBe(true);
  });
});
