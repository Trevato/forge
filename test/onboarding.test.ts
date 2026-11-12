import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "N",
  GIT_AUTHOR_EMAIL: "n@f.dev",
  GIT_COMMITTER_NAME: "N",
  GIT_COMMITTER_EMAIL: "n@f.dev",
});

describe("onboarding: a person with just a login", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let port = 0;
  let cookie = "";

  const form = (f: Record<string, string>) => new URLSearchParams(f);
  async function git(args: string[], cwd: string): Promise<number> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    return await p.exited;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-onboard-"));
    work = await mkdtemp(join(tmpdir(), "forge-onboard-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    port = servers.port;
    cookie = await adminCookie(app, {
      username: "nora",
      email: "n@f.dev",
      password: "nora-login-secret",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("git push authenticates with the account password", async () => {
    // Create the repo, then push with the login password (no token).
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ owner: "nora", name: "app", visibility: "private" }),
      redirect: "manual",
    });
    const repo = join(work, "app");
    await git(["init", "-q", "-b", "main", repo], work);
    await Bun.write(join(repo, "f.txt"), "hi\n");
    await git(["-C", repo, "add", "."], work);
    await git(["-C", repo, "commit", "-q", "-m", "x"], work);
    const remote = `http://nora:nora-login-secret@localhost:${port}/nora/app.git`;
    expect(await git(["-C", repo, "push", remote, "main"], work)).toBe(0);

    // A wrong password is refused.
    const bad = `http://nora:nope@localhost:${port}/nora/app.git`;
    expect(await git(["-C", repo, "push", bad, "main"], work)).not.toBe(0);
  });

  test("push-to-create makes a repo that doesn't exist yet", async () => {
    const repo = join(work, "fresh");
    await git(["init", "-q", "-b", "main", repo], work);
    await Bun.write(join(repo, "r.txt"), "new\n");
    await git(["-C", repo, "add", "."], work);
    await git(["-C", repo, "commit", "-q", "-m", "seed"], work);
    // "scratch" was never created in the UI — pushing brings it into being.
    const remote = `http://nora:nora-login-secret@localhost:${port}/nora/scratch.git`;
    expect(await git(["-C", repo, "push", remote, "main"], work)).toBe(0);

    const info = await fetch(`${base}/api/v1/repos/nora/scratch`, {
      headers: { cookie },
    });
    expect(info.status).toBe(200);
    expect(((await info.json()) as { visibility: string }).visibility).toBe(
      "private",
    );
  });

  test("push-to-create is refused into someone else's namespace", async () => {
    await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username: "mallory",
        email: "m@f.dev",
        password: "mallory-secret",
      }),
      redirect: "manual",
    });
    const repo = join(work, "evil");
    await git(["init", "-q", "-b", "main", repo], work);
    await Bun.write(join(repo, "e.txt"), "x\n");
    await git(["-C", repo, "add", "."], work);
    await git(["-C", repo, "commit", "-q", "-m", "x"], work);
    // Mallory tries to push-create under nora's namespace.
    const remote = `http://mallory:mallory-secret@localhost:${port}/nora/hijack.git`;
    expect(await git(["-C", repo, "push", remote, "main"], work)).not.toBe(0);
    expect(
      (await fetch(`${base}/api/v1/repos/nora/hijack`, { headers: { cookie } }))
        .status,
    ).toBe(404);
  });

  test("the token page mints a token, once, and it works for git", async () => {
    const pageHtml = await (
      await fetch(`${base}/settings/tokens`, { headers: { cookie } })
    ).text();
    expect(pageHtml).toContain("Access codes");

    // Post-redirect-get: minting redirects, and the secret rides a one-shot
    // flash cookie so a refresh shows the list instead of minting again.
    const created = await fetch(`${base}/settings/tokens`, {
      method: "POST",
      headers: { cookie },
      // The first account is the site admin: its token is minted on purpose (#596).
      body: form({ name: "laptop", scope: "rw", aiAdmin: "on" }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    const flash = (created.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(flash).toStartWith("forge_flash=");

    const shown = await fetch(`${base}/settings/tokens`, {
      headers: { cookie: `${cookie}; ${flash}` },
    });
    const html = await shown.text();
    const match = html.match(/forge_[A-Za-z0-9_-]+/);
    expect(match).not.toBeNull();
    const token = match![0];
    // Shown exactly once: the page that rendered it also cleared the cookie.
    expect(shown.headers.get("set-cookie") ?? "").toContain("forge_flash=;");

    // The minted token authenticates a push.
    const remote = `http://nora:${token}@localhost:${port}/nora/app.git`;
    const repo = join(work, "app");
    await Bun.write(join(repo, "g.txt"), "tok\n");
    await git(["-C", repo, "add", "."], work);
    await git(["-C", repo, "commit", "-q", "-m", "via token"], work);
    expect(await git(["-C", repo, "push", remote, "main"], work)).toBe(0);
  });

  test("a token cannot mint another token (no privilege bootstrap)", async () => {
    // Get a token, then try to use it to create a token via the web route.
    const roToken = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "nora",
        password: "nora-login-secret",
        name: "ro",
        scope: "admin",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const res = await fetch(`${base}/settings/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ name: "escalate", scope: "admin" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});

// The real-world default is `FORGE_DATA=data` — a *relative* path. Git runs the
// pre-receive hook with its working directory set to the bare repo, so the hook
// must reach the forge over an *absolute* socket path; a relative one resolves
// against the repo dir and the relay fails ("typo in the url or port"), failing
// the push closed. This proves createApp resolves dataDir so the hook connects.
describe("a forge booted from a relative data dir still accepts pushes", () => {
  let dataAbs: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let port = 0;

  async function git(args: string[], cwd: string): Promise<number> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "ignore",
      stderr: "ignore",
    });
    return await p.exited;
  }

  beforeAll(async () => {
    // A genuinely relative dataDir, but backed by tmp so nothing pollutes the
    // repo. `relative(cwd, abs)` yields a "../../…"-style path that createApp
    // must resolve back to absolute for the socket to be reachable.
    dataAbs = await mkdtemp(join(tmpdir(), "forge-relative-"));
    work = await mkdtemp(join(tmpdir(), "forge-relative-work-"));
    const dataDir = relative(process.cwd(), dataAbs);
    expect(dataDir.startsWith("/")).toBe(false); // guard: actually relative
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    port = servers.port;
    await adminCookie(app, {
      username: "rel",
      email: "r@f.dev",
      password: "rel-secret",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataAbs, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the pre-receive hook relay reaches the forge and the push lands", async () => {
    const repo = join(work, "app");
    await git(["init", "-q", "-b", "main", repo], work);
    await Bun.write(join(repo, "f.txt"), "hi\n");
    await git(["-C", repo, "add", "."], work);
    await git(["-C", repo, "commit", "-q", "-m", "x"], work);
    const remote = `http://rel:rel-secret@localhost:${port}/rel/app.git`;
    expect(await git(["-C", repo, "push", remote, "main"], work)).toBe(0);
  });
});
