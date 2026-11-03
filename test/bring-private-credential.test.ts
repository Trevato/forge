/**
 * A private repository brought from a connected forge: its credential rides
 * in git's environment (`GIT_CONFIG_*` → a URL-scoped `http.extraHeader`) and
 * nowhere else. Not on any command line, not in the clone's config, not in
 * the job a person reads, not in anything the server printed.
 *
 * argv is caught by a `git` shim first on PATH that records every argument
 * of every invocation and then runs the real git — so the assertion is about
 * what was actually spawned, not about what the code means to spawn.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrigin } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { settled } from "../src/origins/jobs.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-private-token-5d1f9a";
const PASSWORD = "alice-secret-7089";
const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
/** Every form the credential could leak in: plaintext, and the header blob. */
const LEAKS = [TOKEN, Buffer.from(`${LOGIN}:${TOKEN}`).toString("base64")];

describe("bringing a private repository", () => {
  const dirs: string[] = [];
  let app: App;
  let gitApp: App;
  let servers: Servers;
  let gitServers: Servers;
  let fake: FakeForge;
  let argvLog = "";
  const path = process.env.PATH;
  const printed: string[] = [];
  const consoles = ["log", "info", "warn", "error", "debug"] as const;
  const originals = consoles.map((name) => console[name]);

  beforeAll(async () => {
    for (const prefix of ["forge-bringp-", "forge-bringp-git-", "forge-bringp-shim-"])
      dirs.push(await mkdtemp(join(tmpdir(), prefix)));
    const shim = dirs[2]!;
    argvLog = join(shim, "argv.log");
    const real = Bun.which("git");
    if (real === null) throw new Error("no git on PATH");
    // One argument per line, a blank line between invocations.
    await writeFile(
      join(shim, "git"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done\nprintf '\\n' >> '${argvLog}'\nexec '${real}' "$@"\n`,
    );
    await chmod(join(shim, "git"), 0o755);
    process.env.PATH = `${shim}:${path ?? "/usr/bin:/bin"}`;

    gitApp = createApp({ dataDir: dirs[1]!, port: 0 });
    gitServers = await serve(gitApp);
    await seedAdmin(gitApp, { username: LOGIN, email: "octo@upstream.test", password: TOKEN });
    proveAll(gitApp);
    const auth = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    const repo = await fetch(`${gitServers.url}/api/v1/repos`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "vault", visibility: "private" }),
    });
    expect(repo.status).toBeLessThan(300);
    const made = await fetch(`${gitServers.url}/api/v1/repos/octo/vault/contents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        branch: "main",
        message: "a private thing",
        files: [{ path: "README.md", content: "private\n" }],
      }),
    });
    expect(made.status).toBeLessThan(300);
    // Private for real: without the credential the upstream will not serve it.
    const anon = await fetch(`${gitServers.url}/octo/vault.git/info/refs?service=git-upload-pack`);
    expect(anon.status).not.toBe(200);

    const state = newFakeState("forgejo", LOGIN, TOKEN);
    state.repos.push({
      id: 77,
      fullName: "octo/vault",
      private: true,
      defaultBranch: "main",
      cloneUrl: `${gitServers.url}/octo/vault.git`,
    });
    fake = serveFakeForge(state);
    state.repos[0]!.htmlUrl = `${fake.url}/octo/vault`;
    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    proveAll(app);
  }, 120_000);

  afterAll(async () => {
    consoles.forEach((name, i) => (console[name] = originals[i]!));
    process.env.PATH = path;
    await syncsSettled();
    fake.stop();
    servers.stop();
    gitServers.stop();
    app.close();
    gitApp.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("it comes across, and the token is in no argv, no config and no log", async () => {
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: getUserByName(app.db, "alice")!.id,
      kind: "forgejo",
      apiUrl: fake.apiUrl,
      webUrl: fake.url,
      login: LOGIN,
      token: TOKEN,
    });
    if (!made.ok) throw new Error(made.error);

    consoles.forEach((name) => {
      console[name] = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    });
    const started = await fetch(`${servers.url}/bring`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: basic("alice", PASSWORD), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link: `${fake.url}/octo/vault` }).toString(),
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location")!;
    const job = await settled(where.split("/").pop()!);
    const page = await fetch(`${servers.url}${where}`, { headers: { authorization: basic("alice", PASSWORD) } });
    const pageText = await page.text();
    consoles.forEach((name, i) => (console[name] = originals[i]!));

    // It worked, so the credential did reach the upstream — by the env.
    expect(job?.stage).toBe("done");
    const repo = getRepo(app.db, "alice", "vault")!;
    expect(repo).toBeDefined();
    const dir = repoDir(app.reposRoot, "alice", "vault");
    const head = Bun.spawnSync(["git", "rev-parse", "--verify", "refs/heads/main"], { cwd: dir });
    expect(head.exitCode).toBe(0);

    const argv = await readFile(argvLog, "utf8");
    // The shim saw the fetch from the upstream, so its silence below means something.
    expect(argv).toContain(`${gitServers.url}/octo/vault.git`);
    const config = await readFile(join(dir, "config"), "utf8");
    expect(config).toContain(`${gitServers.url}/octo/vault.git`);
    const log = [JSON.stringify(job), pageText, ...printed].join("\n");
    for (const leak of LEAKS) {
      expect(argv).not.toContain(leak);
      expect(config).not.toContain(leak);
      expect(log).not.toContain(leak);
    }
  });
});
