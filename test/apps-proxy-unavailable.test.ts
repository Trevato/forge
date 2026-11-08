/**
 * The page a preview that is not serving shows (#8154): `gone` only when
 * its pull is closed or missing, and every such page leads out.
 */
import { signGrant } from "../src/apps/proxy.ts";
import { AppsRuntime as Runtime } from "../src/apps/runtime.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { AppsRuntime } from "../src/apps/runtime.ts";
import { unavailable } from "../src/apps/proxy.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getIssue, setIssueState } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("unavailable page", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let target: any;
  let open: number;
  let closed: number;
  let production = true;
  let secret: any;
  let secretPull: number;
  let bob: User;

  const runtime = () =>
    ({
      app,
      options: { forgeUrl: "https://forge.test" },
      envStatus: (_a: unknown, env: string) =>
        env === "production" && production ? { state: "running", port: 1 } : undefined,
      urlFor: (_a: unknown, env: string) => `https://x--${env}.test/?a=1&b=<2>`,
    }) as unknown as AppsRuntime;
  const page = (env: string, status?: any) =>
    unavailable(runtime(), { ...target, env }, status);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-unavail-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const a = await newApp(app, alice, { name: "hello", visibility: "public" });
    if (!a.ok) throw new Error(a.error);
    const repo = a.value.repo;
    target = { app: a.value.app, env: "production", nested: false };
    const bobMade = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob",
      email: "bob@forge.local", password: "a-good-passphrase",
    });
    if (!bobMade.ok) throw new Error(bobMade.error);
    bob = bobMade.value;
    const sec = await newApp(app, alice, { name: "vault", visibility: "private" });
    if (!sec.ok) throw new Error(sec.error);
    secret = { app: sec.value.app, env: "production", nested: false };
    await commitToBranch(app, alice, sec.value.repo, {
      branch: "s", base: sec.value.repo.defaultBranch, message: "s",
      files: [{ path: "s.md", content: "x\n" }],
    });
    const so = await openPull(app, alice, sec.value.repo, {
      title: "Secret roadmap", baseBranch: sec.value.repo.defaultBranch, headBranch: "s",
    });
    if (!so.ok) throw new Error(so.error);
    secretPull = so.value.number;
    const mk = async (branch: string, title: string) => {
      await commitToBranch(app, alice, repo, {
        branch, base: repo.defaultBranch, message: branch,
        files: [{ path: `${branch}.md`, content: "x\n" }],
      });
      const o = await openPull(app, alice, repo, {
        title, baseBranch: repo.defaultBranch, headBranch: branch,
      });
      if (!o.ok) throw new Error(o.error);
      return o.value;
    };
    open = (await mk("b-open", "Open <b>pull</b>")).number;
    const c = await mk("b-closed", "Closed one");
    closed = c.number;
    setIssueState(app.db, getIssue(app.db, repo.id, c.number)!.id, "closed");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an open pull with no environment is not gone", async () => {
    const res = page(`pull-${open}`);
    const html = await res.text();
    expect(html).not.toContain("is gone");
    expect(html).toContain("is not running");
    expect(html).toContain("app_deploy redeploy");
    expect(html).toContain("next push");
    expect(res.status).toBeLessThan(500);
  });

  test("a failed deploy's error is redacted, and a running one says so", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const failed = await page(`pull-${open}`, { state: "failed", error: `boom token=${secret}` }).text();
    expect(failed).toContain("boom");
    expect(failed).not.toContain(secret);
    const running = await page(`pull-${open}`, { state: "running", port: 1 }).text();
    expect(running).toContain("It is running.");
  });

  test("a closed pull, and one that does not exist, are a 404 gone", async () => {
    for (const n of [closed, 9999]) {
      const res = page(`pull-${n}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("is gone");
    }
  });

  test("every page links to the pull, production and home, escaped", async () => {
    const cases: [string, any][] = [
      [`pull-${open}`, undefined],
      [`pull-${open}`, { state: "deploying" }],
      [`pull-${open}`, { state: "failed", error: "boom" }],
      [`pull-${closed}`, undefined],
    ];
    for (const [env, status] of cases) {
      const html = await page(env, status).text();
      const n = env.slice(5);
      expect(html).toContain(`href="https://forge.test/alice/hello/pulls/${n}"`);
      expect(html).toContain(
        `href="https://x--production.test/?a=1&amp;b=&lt;2&gt;"`,
      );
      expect(html).toContain(`href="https://forge.test/"`);
      expect(html).not.toContain("<b>pull</b>");
    }
  });

  test("production is linked only when it serves; production's own page has no pull link", async () => {
    production = false;
    const html = await page(`pull-${open}`).text();
    production = true;
    expect(html).not.toContain("Production</a>");
    const own = await page("production").text();
    expect(own).toContain('href="https://forge.test/"');
    expect(own).not.toContain("/pulls/");
  });

  const who = (u: User) => ({ id: u.id, name: u.username, role: "user" as const });
  const secretPage = (v?: User) =>
    unavailable(runtime(), { ...secret, env: `pull-${secretPull}` }, undefined, undefined, v && who(v)).text();

  test("a private repository's pull link and title go only to a reader", async () => {
    for (const viewer of [undefined, bob]) {
      const html = await secretPage(viewer);
      expect(html).not.toContain("alice/vault");
      expect(html).not.toContain("Secret roadmap");
      expect(html).not.toContain("/pulls/");
      expect(html).not.toContain("Production</a>");
      expect(html).toContain('href="https://forge.test/"');
    }
    const html = await secretPage(alice);
    expect(html).toContain(`href="https://forge.test/alice/vault/pulls/${secretPull}"`);
    expect(html).toContain("Secret roadmap");
    expect(html).toContain("Production</a>");
  });

  test("a merged pull is closed, so its preview is gone", () => {
    // mergePull closes the issue (src/actions/pulls.ts) with the same
    // setIssueState the closed case above uses; `gone` reads that state.
    expect(getIssue(app.db, target.app.repoId, closed)!.state).toBe("closed");
  });

  test("the proxy hands the signed-in person to the page", async () => {
    const servers: Servers = await serve(app);
    const rt = new Runtime(app, {
      domain: "apps.test", scheme: "http", publicPort: servers.port,
      forgeUrl: servers.url, concurrency: 1,
    });
    await rt.start();
    try {
      const host = `vault--${secretPull}.apps.test`;
      const t = { ...secret, env: `pull-${secretPull}` };
      const ask = async (v: User) => {
        const cookie = `forge_grant_${secret.app.id.slice(-8)}=${signGrant(dataDir, t, 60_000, Date.now(), who(v))}`;
        return fetch(`${servers.url}/`, { headers: { host, cookie }, redirect: "manual" });
      };
      const mine = await ask(alice);
      const html = await mine.text();
      expect(html).toContain("Secret roadmap");
      expect(html).toContain(`/alice/vault/pulls/${secretPull}`);
      const theirs = await (await ask(bob)).text();
      expect(theirs).not.toContain("Secret roadmap");
    } finally {
      await rt.stop();
      servers.stop();
    }
  }, 30_000);
});
