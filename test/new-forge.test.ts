/**
 * "+ New forge" (#426): the page a forge's admin spawns a child from — the
 * same door as `POST /api/v1/forges` and the MCP `spawn`, in a form that
 * works without JavaScript. See the plan first, then spawn, then read the
 * claim link once on the page (never in a URL). Only an admin sees the
 * door; the page says plainly what never travels.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { usePlacement } from "../src/spawn/door.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-new-forge-passphrase";

describe("+ New forge", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let reader = "";

  const url = (path: string) => `${servers.url}${path}`;
  const signIn = async (username: string) => {
    const res = await fetch(url("/signin"), {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const get = (cookie: string, path: string) =>
    fetch(url(path), { headers: { cookie }, redirect: "manual" });
  const post = (
    cookie: string,
    form: [string, string][],
    // The forge's own origin is its configured address.
    origin = "https://forge.test",
  ) =>
    fetch(url("/forges/new"), {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const children = async () =>
    (await readdir(join(dir, "spawn")).catch(() => [] as string[])).length;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-new-forge-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    const b = await createUser(app.db, {
      trusted: true,
      username: "bob",
      email: "b@x.test",
      password: PASSWORD,
    });
    if (!a.ok || !b.ok) throw new Error("users");
    const repo = await createRepo(app, a.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(app.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    servers = await serve(app);
    admin = await signIn("alice");
    reader = await signIn("bob");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("someone who is not an admin has no door: no link, no page, no post", async () => {
    expect(await (await get(reader, "/")).text()).not.toContain(
      'href="/forges/new"',
    );
    expect((await get(reader, "/forges/new")).status).toBe(404);
    expect(
      (
        await post(reader, [
          ["name", "kai"],
          ["apps", "alice/bakery"],
          ["do", "spawn"],
        ])
      ).status,
    ).toBe(404);
    expect(await children()).toBe(0);
  });

  test("an admin finds the door and a form that says what never travels", async () => {
    expect(await (await get(admin, "/")).text()).toContain(
      'href="/forges/new"',
    );
    const page = await get(admin, "/forges/new");
    expect(page.status).toBe(200);
    const html = (await page.text()).replace(/\s+/g, " ");
    expect(html).toContain('value="alice/bakery"');
    expect(html).toContain("Never copied");
    expect(html).toContain("secrets");
    expect(html).toContain("user accounts");
  });

  test("a post from another origin is refused, and nothing is made", async () => {
    const res = await post(
      admin,
      [
        ["name", "kai"],
        ["apps", "alice/bakery"],
        ["do", "spawn"],
      ],
      "https://evil.test",
    );
    expect(res.status).toBe(403);
    expect(await children()).toBe(0);
  });

  test("See the plan shows what is copied and what stays, and makes nothing", async () => {
    const res = await post(admin, [
      ["name", "kai"],
      ["apps", "alice/bakery"],
      ["direction", "Run Kai's shop."],
      ["do", "plan"],
    ]);
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/\s+/g, " ");
    expect(html).toContain("app alice/bakery (full history, forge.json)");
    expect(html).toContain("your words, as the child&#39;s direction");
    expect(await children()).toBe(0);
  });

  test("an error is shown beside the field that caused it", async () => {
    const bad = await post(admin, [
      ["name", "Not A Name"],
      ["apps", "alice/bakery"],
      ["do", "plan"],
    ]);
    expect(bad.status).toBe(422);
    const html = await bad.text();
    expect(html).toMatch(/id="f-name-err"[^>]*>[^<]*name must be/);
    const key = await post(admin, [
      ["name", "kai"],
      ["apps", "alice/bakery"],
      ["modelKey", "sk-ant-oat01-a-persons-own-plan-XXXXXXXX"],
      ["budgetUsd", "5"],
      ["do", "plan"],
    ]);
    expect(key.status).toBe(422);
    expect(await key.text()).toMatch(
      /id="f-modelKey-err"[^>]*>[^<]*a subscription token is a person/,
    );
  });

  test("Spawn makes the child and shows its claim link once, on the page, never cached", async () => {
    const res = await post(admin, [
      ["name", "kai"],
      ["apps", "alice/bakery"],
      ["keepAccess", "on"],
      ["do", "spawn"],
    ]);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toMatch(/https:\/\/kai\.forge\.test\/claim#[A-Za-z0-9_-]{43}/);
    expect(await children()).toBe(1);
    // Asked again, the child exists: no second link.
    const again = await post(admin, [
      ["name", "kai"],
      ["apps", "alice/bakery"],
      ["keepAccess", "on"],
      ["do", "spawn"],
    ]);
    expect(await again.text()).not.toMatch(/claim#[A-Za-z0-9_-]{43}/);
  });

  test("a forge at its depth limit shows no door, and its page says why", async () => {
    usePlacement(app, hostedPlacement({ host: "forge.test", depth: 2 }));
    expect(await (await get(admin, "/")).text()).not.toContain('href="/forges/new"');
    const html = await (await get(admin, "/forges/new")).text();
    expect(html).toContain("cannot hold another child");
    expect(html).not.toContain('action="/forges/new"');
  });
});
