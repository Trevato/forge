import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

const clientEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@forge.local",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@forge.local",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function sh(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(args, {
    cwd,
    env: clientEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: errText.trim() };
}

async function shOk(args: string[], cwd: string): Promise<string> {
  const result = await sh(args, cwd);
  if (result.code !== 0)
    throw new Error(`${args.join(" ")} failed (${result.code}): ${result.err}`);
  return result.out;
}

describe("the forge, end to end", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  let authedRemote = "";

  const api = (path: string, init?: RequestInit & { token?: boolean }) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    if (init?.token !== false && token !== "")
      headers.set("authorization", `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-"));
    work = await mkdtemp(join(tmpdir(), "forge-appwork-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("register: first user is admin, duplicates rejected", async () => {
    const created = await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: "alice",
        email: "alice@forge.local",
        password: "correct-horse-battery",
      }),
    });
    expect(created.status).toBe(201);
    const user = (await created.json()) as {
      username: string;
      isAdmin: boolean;
    };
    expect(user.isAdmin).toBe(true);

    const dupe = await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: "ALICE",
        email: "other@forge.local",
        password: "correct-horse-battery",
      }),
    });
    expect(dupe.status).toBe(422);
    expect(((await dupe.json()) as { error: string }).error).toBe(
      "username_taken",
    );

    const second = await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: "bob",
        email: "bob@forge.local",
        password: "bobs-long-password",
      }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  test("login yields a working session cookie", async () => {
    const login = await api("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        username: "alice",
        password: "correct-horse-battery",
      }),
    });
    expect(login.status).toBe(201);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_session=");
    expect(cookie).toContain("HttpOnly");

    const whoami = await fetch(`${base}/api/v1/user`, {
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(whoami.status).toBe(200);
    expect(((await whoami.json()) as { username: string }).username).toBe(
      "alice",
    );

    const wrong = await api("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "wrong" }),
    });
    expect(wrong.status).toBe(401);
  });

  test("mint a token with password auth", async () => {
    const minted = await api("/api/v1/tokens", {
      method: "POST",
      token: false,
      body: JSON.stringify({
        username: "alice",
        password: "correct-horse-battery",
        name: "cli",
        scope: "admin",
      }),
    });
    expect(minted.status).toBe(201);
    token = ((await minted.json()) as { token: string }).token;
    expect(token.startsWith("forge_")).toBe(true);
  });

  test("create a private repo through the API", async () => {
    const created = await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "app", description: "the app" }),
    });
    expect(created.status).toBe(201);

    const anon = await fetch(`${base}/api/v1/repos`);
    expect(((await anon.json()) as { items: unknown[] }).items.length).toBe(0);

    const mine = await api("/api/v1/repos");
    expect(((await mine.json()) as { items: unknown[] }).items.length).toBe(1);
  });

  test("anonymous clone of a private repo is challenged", async () => {
    const result = await sh(
      ["git", "clone", `${base}/alice/app.git`, "denied"],
      work,
    );
    expect(result.code).not.toBe(0);
    // The 401 challenge lands: git falls back to asking for credentials,
    // which the test environment forbids.
    expect(result.err).toContain("could not read Username");
  });

  test("authenticated clone, push, and the durable push event", async () => {
    authedRemote = `${base.replace("http://", `http://alice:${token}@`)}/alice/app.git`;
    await shOk(["git", "clone", authedRemote, "app"], work);

    const dir = join(work, "app");
    await Bun.write(join(dir, "README.md"), "# app\n");
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "genesis"], dir);
    await shOk(["git", "push", "origin", "main"], dir);

    const events = await api("/api/v1/repos/alice/app/events");
    const list = (await events.json()) as {
      kind: string;
      payload: { updates?: { ref: string }[] };
    }[];
    const push = list.find((e) => e.kind === "push");
    expect(push).toBeDefined();
    expect(push?.payload.updates?.[0]?.ref).toBe("refs/heads/main");
  });

  test("a read-only token cannot push", async () => {
    const minted = await api("/api/v1/tokens", {
      method: "POST",
      token: false,
      body: JSON.stringify({
        username: "alice",
        password: "correct-horse-battery",
        name: "reader",
        scope: "ro",
      }),
    });
    const roToken = ((await minted.json()) as { token: string }).token;
    const roRemote = `${base.replace("http://", `http://alice:${roToken}@`)}/alice/app.git`;

    await shOk(["git", "clone", roRemote, "ro-clone"], work);
    const dir = join(work, "ro-clone");
    await Bun.write(join(dir, "x.txt"), "x\n");
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "attempt"], dir);
    const pushed = await sh(["git", "push"], dir);
    expect(pushed.code).not.toBe(0);
  });

  test("bob cannot see or touch alice's private repo", async () => {
    const minted = await api("/api/v1/tokens", {
      method: "POST",
      token: false,
      body: JSON.stringify({
        username: "bob",
        password: "bobs-long-password",
        name: "cli",
        scope: "admin",
      }),
    });
    const bobToken = ((await minted.json()) as { token: string }).token;

    const seen = await fetch(`${base}/api/v1/repos/alice/app`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(seen.status).toBe(404);

    const bobRemote = `${base.replace("http://", `http://bob:${bobToken}@`)}/alice/app.git`;
    const cloned = await sh(["git", "clone", bobRemote, "bob-clone"], work);
    expect(cloned.code).not.toBe(0);
  });

  test("protected default branch refuses force pushes and deletion", async () => {
    const patched = await api("/api/v1/repos/alice/app", {
      method: "PATCH",
      body: JSON.stringify({ protectDefault: true }),
    });
    expect(patched.status).toBe(200);

    const dir = join(work, "app");
    await shOk(["git", "commit", "--amend", "-m", "rewritten history"], dir);
    const forced = await sh(["git", "push", "--force"], dir);
    expect(forced.code).not.toBe(0);
    expect(forced.err).toContain("force push refused");

    const deleted = await sh(["git", "push", "origin", ":main"], dir);
    expect(deleted.code).not.toBe(0);
    expect(deleted.err).toContain("deletion refused");

    // An honest fast-forward still lands.
    await shOk(["git", "reset", "--hard", "origin/main"], dir);
    await Bun.write(join(dir, "more.txt"), "more\n");
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "fast forward"], dir);
    await shOk(["git", "push"], dir);
  });

  test("the refs/pull namespace is reserved", async () => {
    const dir = join(work, "app");
    const pushed = await sh(
      ["git", "push", "origin", "HEAD:refs/pull/1/head"],
      dir,
    );
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("reserved");
  });

  test("delete removes the row and the directory", async () => {
    const deleted = await api("/api/v1/repos/alice/app", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await api("/api/v1/repos/alice/app").then((r) => r.status)).toBe(
      404,
    );
    expect(
      await Bun.file(join(dataDir, "repos/alice/app.git/HEAD")).exists(),
    ).toBe(false);
  });
});
