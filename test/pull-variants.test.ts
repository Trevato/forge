import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const gitEnv = gitClientEnv();

describe("a pull says its variant group and siblings", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  let dir: string;

  async function gitOk(args: string[]): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      env: gitEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  }
  const auth = { authorization: "" };
  const api = async (path: string, init: RequestInit = {}) =>
    (await fetch(`${base}/api/v1/repos/dev/app${path}`, {
      ...init,
      headers: { ...auth, "content-type": "application/json" },
    })).json() as Promise<any>;
  const mcp = async (name: string, args: unknown, as?: string) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...auth,
        ...(as ? { authorization: `Bearer ${as}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  };
  const write = async (text: string, message: string) => {
    await Bun.write(join(dir, "code.txt"), text);
    await gitOk(["commit", "-am", message]);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pv-"));
    work = await mkdtemp(join(tmpdir(), "forge-pv-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "dev",
        email: "dev@f.dev",
        password: "pull-variants-pass",
      }),
      redirect: "manual",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "dev",
        password: "pull-variants-pass",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    auth.authorization = `Bearer ${token}`;
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    const remote = `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`;
    dir = work;
    await gitOk(["clone", remote, "app"]);
    dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nbeta\ngamma\n");
    await gitOk(["add", "."]);
    await gitOk(["commit", "-m", "base"]);
    await gitOk(["push", "origin", "main"]);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("pulls sharing a group name each other; an ordinary pull has null and []", async () => {
    for (const name of ["a", "b", "c"]) {
      await gitOk(["checkout", "-B", name, "main"]);
      await write(`alpha\n${name}\ngamma\n`, `try ${name}`);
      await gitOk(["push", "origin", name]);
      const made = await api("/pulls", {
        method: "POST",
        body: JSON.stringify({ base: "main", head: name, title: name }),
      });
      expect(made.variantGroup).toBeNull();
      expect(made.variantSiblings).toEqual([]);
    }
    app.db.run(
      `UPDATE pull SET variant_group = 'try-it'
        WHERE issue_id IN (SELECT id FROM issue WHERE number IN (1, 2))`,
    );
    const one = await api("/pulls/1");
    expect(one.variantGroup).toBe("try-it");
    expect(one.variantSiblings).toEqual([2]);
    const two = await api("/pulls/2");
    expect(two.variantGroup).toBe("try-it");
    expect(two.variantSiblings).toEqual([1]);
    const three = await api("/pulls/3");
    expect(three.variantGroup).toBeNull();
    expect(three.variantSiblings).toEqual([]);

    const list = (await api("/pulls")) as { items: any[] };
    const byNumber = new Map(list.items.map((p) => [p.number, p]));
    expect(byNumber.get(1).variantSiblings).toEqual([2]);
    expect(byNumber.get(3).variantGroup).toBeNull();
    expect(byNumber.get(3).variantSiblings).toEqual([]);
  });

  test("runs carry a nullable variant_group", () => {
    const cols = app.db
      .query<{ name: string }, []>("PRAGMA table_info(run)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("variant_group");
  });
});
