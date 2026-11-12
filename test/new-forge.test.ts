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
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { childrenForMemory, maxChildren, setCapacity } from "../src/core/capacity.ts";
import { hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";
import { tool as spawnTool } from "../src/http/mcp/tools/spawn.ts";

quietLogs();

const PASSWORD = "a-long-new-forge-passphrase";
const KEY = "sk-ant-api03-child-key-AAAAAAAAAAAAAAAAAAAAAAAA";

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
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    const b = await createUser(app.db, {
      origin: "seed",
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

  test("anyone signed in finds the door; the list of forges and their claim links stay the admin's", async () => {
    // Since 0.7.57 any signed-in person may start a forge (spawn/door.ts);
    // what stays the admin's is the roster of children and re-issuing a
    // claim link for one.
    expect(await (await get(reader, "/")).text()).toContain(
      'href="/forges/new"',
    );
    expect((await get(reader, "/forges/new")).status).toBe(200);
    expect((await get(reader, "/forges")).status).toBe(404);
    expect(
      (
        await fetch(url("/forges/kai/claim-link"), {
          method: "POST",
          headers: { cookie: reader, origin: "https://forge.test" },
          redirect: "manual",
        })
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

  test("the Template field lists Blank first and selected; starter reaches the plan from the door's own body; an unknown id is refused on the field", async () => {
    const page = (await (await get(admin, "/forges/new")).text()).replace(/\s+/g, " ");
    const at = page.indexOf('name="template"');
    expect(at).toBeGreaterThan(0);
    const field = page.slice(at, page.indexOf("</select>", at));
    expect(field).toMatch(/<option value="blank" selected >\s*Blank/);
    expect(field.indexOf('value="blank"')).toBeLessThan(field.indexOf('value="starter"'));
    expect(field).toContain("Starter app");

    const plan = await post(admin, [["name", "tpl"], ["do", "plan"], ["template", "starter"]]);
    expect(plan.status).toBe(200);
    const planned = (await plan.text()).replace(/\s+/g, " ");
    expect(planned).toContain("starts from the <b>Starter app</b> template");
    expect(planned).toMatch(/<option value="starter" selected >/);

    const blank = await post(admin, [["name", "tpl"], ["do", "plan"], ["template", "blank"]]);
    expect(await blank.text()).not.toContain("template.</li>");

    const bad = await post(admin, [["name", "tpl"], ["do", "plan"], ["template", "nope"]]);
    expect(bad.status).toBe(422);
    const body = await bad.text();
    expect(body).toContain("template must be blank or starter");
    expect(body).toContain('value="tpl"');
    expect(await children()).toBe(0);
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

  test("the plan says what the person gets: the address, the admin, your access, the budget", async () => {
    const left = (
      await (
        await post(admin, [
          ["name", "kai"],
          ["apps", "alice/bakery"],
          ["do", "plan"],
        ])
      ).text()
    ).replace(/\s+/g, " ");
    expect(left).toContain("https://kai--forge.test");
    expect(left).toContain("Whoever opens the link becomes its admin");
    expect(left).toContain("You leave once it is taken over");
    const kept = (
      await (
        await post(admin, [
          ["name", "kai"],
          ["apps", "alice/bakery"],
          ["keepAccess", "on"],
          ["modelKey", KEY],
          ["budgetUsd", "5"],
          ["do", "plan"],
        ])
      ).text()
    ).replace(/\s+/g, " ");
    expect(kept).toContain("You keep owner access");
    expect(kept).toContain("$5");
  });

  test("a plan made with a key asks for it again, never echoes it, and Spawn with it makes the child", async () => {
    const planned = await post(admin, [
      ["name", "lia"],
      ["apps", "alice/bakery"],
      ["modelKey", KEY],
      ["budgetUsd", "5"],
      ["do", "plan"],
    ]);
    expect(planned.status).toBe(200);
    const html = await planned.text();
    expect(html).not.toContain(KEY);
    expect(html).toMatch(/name="modelKey"[^>]*required|required[^>]*name="modelKey"/);
    expect(html).toContain("Type the key again to make the forge");
    expect(html).not.toMatch(/Model key \(optional\)/);
    // The plan's own Spawn button submits the same form.
    expect(html).toMatch(/<button[^>]*form="new-forge"[^>]*>\s*Spawn/);
    const made = await post(admin, [
      ["name", "lia"],
      ["apps", "alice/bakery"],
      ["modelKey", KEY],
      ["budgetUsd", "5"],
      ["do", "spawn"],
    ]);
    expect(made.status).toBe(201);
    expect(await made.text()).toMatch(/https:\/\/lia--forge.test\/claim#[A-Za-z0-9_-]{43}/);
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
      ["modelKey", "\u200b"],
      ["budgetUsd", "5"],
      ["do", "plan"],
    ]);
    expect(key.status).toBe(422);
    expect(await key.text()).toMatch(
      /id="f-modelKey-err"[^>]*>[^<]*is empty/,
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
    expect(html).toMatch(/https:\/\/kai--forge.test\/claim#[A-Za-z0-9_-]{43}/);
    // Drawn with §5's row; the old names are gone and the words and the copy button stay.
    expect(html).not.toContain("claim-link-box");
    expect(html).not.toContain("forges-sent");
    expect(html).toMatch(/<li>\s*<div class="row"/);
    expect(html).toContain('id="claim-link"');
    expect(html).toContain('data-copy="claim-link"');
    expect(html).toContain("Send this link to the person it is for");
    expect(html).toContain('href="/forges"');
    expect(await children()).toBe(2);
    // Asked again, the child exists: no second link.
    const again = await post(admin, [
      ["name", "kai"],
      ["apps", "alice/bakery"],
      ["keepAccess", "on"],
      ["do", "spawn"],
    ]);
    expect(await again.text()).not.toMatch(/claim#[A-Za-z0-9_-]{43}/);
  });

  test("the form offers how the child follows the forge's code, take-updates by default, and tell-me is recorded", async () => {
    const html = (await (await get(admin, "/forges/new")).text()).replace(/\s+/g, " ");
    expect(html).toMatch(/name="followMode" value="take-updates" checked/);
    expect(html).toContain('value="tell-me"');
    (app.config as { forgeRepo?: string }).forgeRepo = "alice/bakery";
    try {
      const res = await post(admin, [
        ["name", "follower"],
        ["followMode", "tell-me"],
        ["do", "spawn"],
      ]);
      expect(res.status).toBe(201);
      const docs = await Promise.all(
        (await readdir(join(dir, "children"))).map((d) =>
          Bun.file(join(dir, "children", d, "parent.json")).json().catch(() => undefined),
        ),
      );
      const mine = docs.find((d) => d?.name === "follower");
      expect(mine?.forgeCode?.mode).toBe("tell-me");
      const bad = await post(admin, [
        ["name", "wrongmode"],
        ["followMode", "yolo"],
        ["do", "plan"],
      ]);
      expect(bad.status).toBe(422);
      expect(await bad.text()).toContain("must be tell-me or take-updates");
    } finally {
      delete (app.config as { forgeRepo?: string }).forgeRepo;
    }
  });

  test("the page promises no update that does not happen", async () => {
    const html = (await (await get(admin, "/forges/new")).text()).replace(/\s+/g, " ");
    expect(html).toContain("Tell me <span class=\"muted small\">tells the owner in their inbox when this forge&#39;s code moves.</span>");
    expect(html).toContain("Take updates <span class=\"muted small\">takes new code in by itself; opens a pull once the repository has commits of its own.</span>");
    expect(html).toContain("<legend>How it follows this forge's code</legend>");
    expect(html).not.toMatch(/recorded for now|nothing acts on it yet/i);
    expect(html).not.toContain("when this forge changes");
    expect(html).not.toMatch(/as long as its own changes merge/);
  });

  test("MCP spawn says what each follow mode does, as the page does", () => {
    const followMode = (spawnTool.inputSchema.properties as Record<string, { description?: string }>)["followMode"];
    expect(followMode?.description).toBe("take-updates: merges itself or a pull; tell-me: inbox card");
  });

  test("a forge at its depth limit shows no door, and its page says why", async () => {
    useProbe(app, () => async () => true);
    usePlacement(app, hostedPlacement({ host: "forge.test", depth: 2 }));
    expect(await (await get(admin, "/")).text()).not.toContain('href="/forges/new"');
    const html = await (await get(admin, "/forges/new")).text();
    expect(html).toContain("has no room for another forge");
    expect(html).not.toContain('action="/forges/new"');
  });

  test("at the room limit the door stays, disabled, with the sentence; raising the setting reopens it", async () => {
    const store = memoryBodies();
    store.add({ bodyId: "b1", name: "one", url: "https://one--forge.test", depth: 1, agents: 1, ssh: false });
    useProbe(app, () => async () => true);
    usePlacement(app, hostedPlacement({ host: "forge.test", store, maxChildren: () => maxChildren(app.db) }));
    setCapacity(app.db, "children.max", "1", "system");
    const sentence = "1 of 1 forges sent on this node — retire one, or raise the room in settings";
    const home = await (await get(admin, "/")).text();
    expect(home).toContain("New forge");
    expect(home).toContain('aria-disabled="true"');
    expect(home).toContain(sentence);
    expect(home).not.toContain('href="/forges/new"');
    const list = await (await get(admin, "/forges")).text();
    expect(list).toContain(sentence);
    expect(list).toContain("disabled");
    const page = await (await get(admin, "/forges/new")).text();
    expect(page).toContain(sentence);
    expect(page).not.toContain('action="/forges/new"');
    // Raised live: no restart, the door opens.
    setCapacity(app.db, "children.max", "2", "system");
    expect(await (await get(admin, "/")).text()).toContain('href="/forges/new"');
    expect(await (await get(admin, "/forges/new")).text()).toContain('action="/forges/new"');
  });

  test("the room defaults to one child per 512 MiB above the forge's own 2 GiB", () => {
    const GiB = 1024 ** 3;
    expect(childrenForMemory(32 * GiB)).toBe(60);
    expect(childrenForMemory(2 * GiB)).toBe(5);
    expect(childrenForMemory(GiB)).toBe(5);
  });
});

describe("/forges/new: More options (#9647)", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-new-forge-more-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: PASSWORD, isAdmin: true });
    if (!a.ok) throw new Error(a.error);
    servers = await serve(app);
    const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: PASSWORD }), redirect: "manual" });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const post = async (form: [string, string][]) =>
    (await fetch(`${servers.url}/forges/new`, { method: "POST", headers: { cookie, origin: "https://forge.test" }, body: new URLSearchParams(form), redirect: "manual" })).text();
  const opening = (html: string) => /<details class="disclosure"[^>]*>/.exec(html)?.[0] ?? "";

  test("a fresh form keeps the rarer fields in a closed disclosure inside the form, so they submit", async () => {
    const html = await (await fetch(`${servers.url}/forges/new`, { headers: { cookie } })).text();
    expect(opening(html)).not.toContain("open");
    const form = html.slice(html.indexOf('id="new-forge"'));
    const more = form.slice(form.indexOf("<summary>More options</summary>"), form.indexOf("</details>"));
    expect(more.length).toBeGreaterThan(0);
    for (const name of ["followMode", "keepAccess", "modelKey", "modelEndpoint", "budgetUsd", "template", "size"])
      expect(more).toContain(`name="${name}"`);
    expect(form.indexOf("</details>")).toBeLessThan(form.indexOf("</form>"));
    // The visible fields stay out of it.
    expect(form.indexOf('name="direction"')).toBeLessThan(form.indexOf("<summary>More options</summary>"));
  });
  test("a bad value in a hidden field opens it", async () => {
    const html = await post([["name", "okname"], ["budgetUsd", "not-a-number"], ["modelKey", KEY]]);
    expect(opening(html)).toContain("open");
  });
  test("an error on the name alone leaves it closed", async () => {
    const html = await post([["name", "Bad Name!"]]);
    expect(html).toContain("name");
    expect(opening(html)).not.toContain("open");
  });
});
