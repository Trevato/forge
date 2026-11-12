/**
 * App templates: an admin marks repositories, New app offers the marked ones
 * the caller can read (default first), and a name the caller cannot read is 404.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp, type App } from "../src/app.ts";
import { offeredTemplates } from "../src/core/app_templates.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import { getRepo, listReposOwnedBy } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { tokenFor } from "./helpers/tokens.ts";

quietLogs();
setDefaultTimeout(30_000);

let dir: string;
let app: App;
let servers: Servers;
let base: string;
let adminToken: string;
let takerToken: string;
let takerCookie: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-apptpl-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const mk = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@x.test`,
      password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const admin = await mk("giver", true);
  const trevato = await mk("trevato");
  const taker = await mk("taker");
  setRole(app, admin, taker.username, "member");
  setRole(app, admin, trevato.username, "member");
  const make = async (owner: typeof admin, name: string, visibility: "public" | "private") => {
    const repo = await createRepo(app, owner, { name, visibility, description: "" });
    if (!repo.ok) throw new Error(repo.error);
    const done = await commitToBranch(app, owner, repo.value, {
      message: "t",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    if (!done.ok) throw new Error(String(done.error));
  };
  await make(trevato, "app-template", "public");
  await make(admin, "kit", "public");
  await make(admin, "secret", "private");
  adminToken = tokenFor(app, "giver", "admin");
  takerToken = tokenFor(app, "taker", "admin");
  takerCookie = (
    (
      await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "taker", password: "a-good-passphrase" }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const mark = (token: string, repo: string, marked: boolean) =>
  fetch(`${base}/api/v1/admin/app-templates`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ repo, marked }),
  });
const listed = async (token: string): Promise<string[]> =>
  ((await (await fetch(`${base}/api/v1/app-templates`, { headers: { authorization: `Bearer ${token}` } })).json()) as { templates: string[] }).templates;
const page = async (): Promise<string> => (await fetch(`${base}/apps/new`, { headers: { cookie: takerCookie } })).text();

test("with only the default marked, it is listed and the page shows no picker", async () => {
  expect(await listed(takerToken)).toEqual(["trevato/app-template"]);
  expect(await page()).not.toContain('name="template"');
});

test("a non-admin cannot mark (403) and nothing changes", async () => {
  const res = await mark(takerToken, "giver/kit", true);
  expect(res.status).toBe(403);
  expect(offeredTemplates(app.db, getUserByName(app.db, "taker"))).toEqual(["trevato/app-template"]);
});

test("an admin marks; the default stays first and the page shows a picker", async () => {
  expect((await mark(adminToken, "giver/kit", true)).status).toBe(200);
  expect((await mark(adminToken, "giver/kit", true)).status).toBe(200); // idempotent
  expect(await listed(takerToken)).toEqual(["trevato/app-template", "giver/kit"]);
  const html = await page();
  expect(html).toContain('name="template"');
  expect(html.indexOf("trevato/app-template")).toBeLessThan(html.indexOf("giver/kit"));
});

test("a private marked template is listed only to those who can read it", async () => {
  expect((await mark(adminToken, "giver/secret", true)).status).toBe(200);
  expect(await listed(adminToken)).toEqual(["trevato/app-template", "giver/kit", "giver/secret"]);
  expect(await listed(takerToken)).toEqual(["trevato/app-template", "giver/kit"]);
  expect(await page()).not.toContain("giver/secret");
});

test("choosing an unreadable template by name makes nothing and is refused", async () => {
  const res = await fetch(`${base}/api/v1/apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${takerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "sneaky", description: "x", template: "giver/secret" }),
  });
  expect(res.status).toBe(404);
  expect(getRepo(app.db, "taker", "sneaky")).toBeUndefined();
});

test("unmarking removes it; the default cannot be unmarked; an unknown name is 404", async () => {
  expect((await mark(adminToken, "giver/secret", false)).status).toBe(200);
  expect(await listed(adminToken)).toEqual(["trevato/app-template", "giver/kit"]);
  expect((await mark(adminToken, "trevato/app-template", false)).status).toBe(422);
  expect((await mark(adminToken, "giver/none", true)).status).toBe(404);
  expect((await mark(adminToken, "bad name", true)).status).toBe(404);
});

test("the settings page is admin-only", async () => {
  const forTaker = await fetch(`${base}/settings/app-templates`, { headers: { cookie: takerCookie } });
  expect(forTaker.status).toBe(403);
  const asAdmin = await fetch(`${base}/settings/app-templates`, { headers: { authorization: `Bearer ${adminToken}` } });
  expect(asAdmin.status).toBe(200);
  expect(await asAdmin.text()).toContain("giver/kit");
});

test("the web New app form refuses an unreadable named template with 404 and makes nothing", async () => {
  expect((await mark(adminToken, "giver/secret", true)).status).toBe(200);
  const res = await fetch(`${base}/apps/new`, {
    method: "POST",
    headers: { cookie: takerCookie, origin: base },
    body: new URLSearchParams({ description: "a plant waterer", template: "giver/secret" }),
    redirect: "manual",
  });
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("giver/secret</");
  expect(listReposOwnedBy(app.db, getUserByName(app.db, "taker")!.id)).toEqual([]);
});

test("marking and unmarking is news for admins alone, so a private name is not broadcast", () => {
  expect(eventAudience("app_template.marked")).toBe("admins");
  expect(eventAudience("app_template.unmarked")).toBe("admins");
});
