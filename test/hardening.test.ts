/**
 * Regression tests for the adversarial-validator findings. Each name cites
 * the finding it pins down so a future change that reopens the hole fails
 * loudly here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { reconcile } from "../src/core/reconcile.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { renderMarkdown } from "../src/web/markdown.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@f.dev",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@f.dev",
});

async function shOk(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, {
    cwd,
    env: gitEnv,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [errText, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")}: ${errText}`);
}

describe("markdown link safety (L-1)", () => {
  test("protocol-relative //host is not linkified", () => {
    expect(renderMarkdown("[x](//evil.com)").text).not.toContain("href=");
    expect(renderMarkdown("[x](https://ok.com)").text).toContain(
      'href="https://ok.com"',
    );
  });
});

describe("reconcile refreshes hooks (H-1)", () => {
  test("a repo whose hook was removed gets it back on boot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-harden-recon-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const user = await createUser(app.db, { origin: "seed", trusted: true,
        username: "h",
        email: "h@f.dev",
        password: "reconcile-me-now",
      });
      if (!user.ok) throw new Error("user");
      const repo = await createRepo(app.db, app.reposRoot, {
        ownerId: user.value.id,
        name: "r",
      });
      if (!repo.ok) throw new Error("repo");

      const hook = join(
        repoDir(app.reposRoot, "h", "r"),
        "hooks",
        "pre-receive",
      );
      expect(await Bun.file(hook).exists()).toBe(true);
      await rm(hook, { force: true });
      expect(await Bun.file(hook).exists()).toBe(false);

      await reconcile(app);
      expect(await Bun.file(hook).exists()).toBe(true);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// These two are about unix socket files themselves; where the sandbox
// refuses the bind (FORGE_TEST_SOCKET=port) the check runs them instead.
const bySocket = portInsteadOfSocket() ? describe.skip : describe;

bySocket("two forges on one data directory", () => {
  test("a socket another forge still answers on is left alone, and this forge boots beside it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-harden-share-"));
    const app = createApp({ dataDir, port: 0 });
    const other = join(dataDir, "forge-other.sock");
    // A forge that is still alive — a release's old process, draining.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.serve({unix:${JSON.stringify(other)},fetch:()=>new Response("x")});setInterval(()=>{},1e9)`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (
      let i = 0;
      i < 50 &&
      !(await lstat(other).then(
        () => true,
        () => false,
      ));
      i++
    ) {
      await Bun.sleep(20);
    }
    let servers: Servers | undefined;
    try {
      servers = await serve(app);
      expect((await fetch(`${servers.url}/`)).status).toBe(200);
      // Theirs is untouched; ours is its own file.
      expect(
        await lstat(other).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(app.socketPath).not.toBe(other);
      expect(
        await lstat(app.socketPath).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    } finally {
      servers?.stop();
      child.kill("SIGKILL");
      await child.exited;
      app.close();
      // Ours went with us.
      expect(
        await lstat(app.socketPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

bySocket("stale socket recovery (H-2)", () => {
  test("a real SIGKILL-orphaned socket inode does not block boot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-harden-sock-"));
    const app = createApp({ dataDir, port: 0 });

    // Faithfully reproduce production: a child binds the socket, then dies
    // by SIGKILL, leaving a live socket *inode* (not a regular file — the
    // case Bun.file().exists() misses).
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.serve({unix:${JSON.stringify(app.socketPath)},fetch:()=>new Response("x")});setInterval(()=>{},1e9)`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (
      let i = 0;
      i < 50 &&
      !(await lstat(app.socketPath).then(
        () => true,
        () => false,
      ));
      i++
    ) {
      await Bun.sleep(20);
    }
    child.kill("SIGKILL");
    await child.exited;

    let servers: Servers | undefined;
    try {
      servers = await serve(app); // would EADDRINUSE without the sweep
      const ping = await fetch(`${servers.url}/`);
      expect(ping.status).toBe(200);
    } finally {
      servers?.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("running-forge attacks", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-harden-"));
    work = await mkdtemp(join(tmpdir(), "forge-harden-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    cookie = await adminCookie(app, { username: "t", email: "t@f.dev", password: "long-enough-pass" });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "t",
        password: "long-enough-pass",
        name: "c",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "r", visibility: "public" }),
    });

    // Push two pathological blobs: many short lines, and one huge line.
    const remote = `${base.replace("http://", `http://t:${token}@`)}/t/r.git`;
    await shOk(["git", "clone", remote, "r"], work);
    const dir = join(work, "r");
    await Bun.write(join(dir, "many.txt"), "x\n".repeat(20_000));
    await Bun.write(join(dir, "huge.txt"), "x".repeat(1_100_000));
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "pathological"], dir);
    await shOk(["git", "push", "origin", "main"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("blob rendering caps line count (C-1)", async () => {
    const html = await (await fetch(`${base}/t/r/blob/main/many.txt`)).text();
    expect(html).toContain('id="L1500"');
    expect(html).not.toContain('id="L1501"'); // the first 1,500 only
    expect(html).toContain("18,500 more lines");
    expect(html).toContain("?all=1");
    expect(html.length).toBeLessThan(400_000);
    // Even ?all=1 stops at a ceiling: the 20k-line file is not drawn whole.
    const all = await (
      await fetch(`${base}/t/r/blob/main/many.txt?all=1`)
    ).text();
    expect(all).toContain('id="L10000"');
    expect(all).not.toContain('id="L10001"');
    expect(all).toContain("10,000 more lines");
  });

  test("oversized blob is refused by stat, not read into memory (C-2)", async () => {
    const html = await (await fetch(`${base}/t/r/blob/main/huge.txt`)).text();
    expect(html).toContain("Too large to render");
    expect(html.length).toBeLessThan(200_000); // the 1.1MB body never rendered
  });

  test("cross-origin POST /signin is refused (M-1)", async () => {
    const res = await fetch(`${base}/signin`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: new URLSearchParams({
        username: "t",
        password: "long-enough-pass",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  test("cross-origin DELETE /api/v1/sessions is refused (M-1)", async () => {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: "DELETE",
      headers: { origin: "http://evil.example", cookie },
    });
    expect(res.status).toBe(403);
  });

  test("malformed form body is a 400, not a 500 (M-2)", async () => {
    const res = await fetch(`${base}/signin`, {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "multipart/form-data; boundary=nope",
      },
      body: "this is not a valid multipart body",
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  test("hostile ?page values collapse to page 1, never a bogus skip (L-3)", async () => {
    for (const page of ["Infinity", "1e400", "-5", "NaN", "abc"]) {
      const html = await (
        await fetch(`${base}/t/r/commits?page=${page}`)
      ).text();
      expect(html).toContain("pathological"); // the real first-page commit
      expect(html).not.toContain("No commits yet");
    }
  });
});
