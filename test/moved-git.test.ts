/** A moved repository's old HTTPS git URL: clone and fetch reach the new one; a push is refused with the new path (#10130). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { transferRepo } from "../src/core/transfer.ts";
import { createUser, type User } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", "-c", "protocol.version=2", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  const [out, errText] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err: errText };
};

describe("git through a moved repository's old URL", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  const commit = (owner: string, name: string, message: string) =>
    commitFiles(repoDir(app.reposRoot, owner, name), {
      branch: "main",
      message,
      files: [{ path: `${message}.txt`, content: message }],
      author: { name: "a", email: "a@example.com" },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-moved-git-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string): Promise<User> => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@example.com`,
        password: "a-long-moved-git-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!u.ok) throw new Error(JSON.stringify(u.error));
      return u.value;
    };
    const alice = await mk("alice");
    const bob = await mk("bob");
    await mk("eve");
    for (const [name, visibility] of [["demo", "public"], ["secret", "private"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(JSON.stringify(made.error));
      expect((await commit("alice", name, "first")).ok).toBe(true);
      const moved = await transferRepo(app.db, app.reposRoot, made.value, bob, alice.id);
      expect(moved.ok).toBe(true);
    }
    expect((await commit("bob", "demo", "second")).ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the advertisement answers 308 to the same path under the new owner", async () => {
    const res = await fetch(`${servers.url}/alice/demo.git/info/refs?service=git-upload-pack`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/bob/demo.git/info/refs?service=git-upload-pack");
  });

  test("real git clones and fetches through the old URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-moved-git-wc-"));
    try {
      const cloned = await git(dir, "clone", `${servers.url}/alice/demo.git`, "wc");
      expect(cloned.code).toBe(0);
      const wc = join(dir, "wc");
      expect((await git(wc, "log", "--format=%s")).out.trim().split("\n")).toEqual(["second", "first"]);
      expect((await commit("bob", "demo", "third")).ok).toBe(true);
      expect((await git(wc, "fetch", "origin")).code).toBe(0);
      expect((await git(wc, "log", "--format=%s", "origin/main")).out.split("\n")[0]).toBe("third");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stranger gets what a missing path answers, and a private repository stays hidden", async () => {
    const res = await fetch(`${servers.url}/alice/secret.git/info/refs?service=git-upload-pack`, { redirect: "manual" });
    const missing = await fetch(`${servers.url}/alice/nothing.git/info/refs?service=git-upload-pack`, { redirect: "manual" });
    expect(res.status).toBe(missing.status);
    expect(res.headers.get("location")).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), "forge-moved-git-st-"));
    try {
      expect((await git(dir, "clone", `${servers.url}/alice/secret.git`, "x")).code).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a push to the old URL is refused with a sentence naming the new path", async () => {
    const adv = await fetch(`${servers.url}/alice/demo.git/info/refs?service=git-receive-pack`, { redirect: "manual" });
    expect(adv.status).toBe(403);
    expect(await adv.text()).toContain("moved to bob/demo");
    const post = await fetch(`${servers.url}/alice/demo.git/git-receive-pack`, { method: "POST", redirect: "manual" });
    expect(post.status).toBe(403);
  });
});
