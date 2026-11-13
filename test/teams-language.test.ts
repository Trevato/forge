/** Settings › Teams speaks the home page's language: one heading, a row per team, its own page with the forms; no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let cookie = "";
let other = "";
const person = async (username: string, adminIfFirst = false): Promise<User> => {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.test`, adminIfFirst });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-teams-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const admin = await person("alice", true);
  promote(app.db, admin);
  cookie = `forge_session=${createSession(app.db, admin.id).token}`;
  const bob = await person("bob");
  other = `forge_session=${createSession(app.db, bob.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const teamsMain = async (): Promise<string> => {
  const res = await fetch(`${servers.url}/settings/teams`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  const page = await res.text();
  return page.slice(page.indexOf("<main"), page.indexOf("</main>"));
};

const teamMain = async (slug: string): Promise<string> => {
  const res = await fetch(`${servers.url}/settings/teams/${slug}`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  const page = await res.text();
  return page.slice(page.indexOf("<main"), page.indexOf("</main>"));
};

test("the list is one heading and a row per team; each team's page holds its form, no card", async () => {
  const main = await teamsMain();
  expect(main.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(main).not.toContain('class="card');
  expect(main).toContain('<ul class="list">');
  expect(main).not.toContain("<form");
  expect(main).toMatch(/id="teams-total">\d+%</);
  const slug = /href="\/settings\/teams\/([a-z0-9-]+)"/.exec(main)?.[1] ?? "";
  expect(slug).not.toBe("");
  const team = await teamMain(slug);
  expect(team.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(team).not.toContain('class="card');
  expect(team).toContain(`action="/settings/teams/${slug}"`);
});

test("one POST saves; Recent changes is then a plain h2 and ul, and the total is still a percentage", async () => {
  const before = await teamsMain();
  expect(before).not.toContain("Recent changes");
  const slug = /href="\/settings\/teams\/([a-z0-9-]+)"/.exec(before)?.[1] ?? "";
  const dial = new RegExp(`id="dial-${slug}"[^>]*value="(\\d+)"`).exec(await teamMain(slug))?.[1] ?? "0";
  const post = await fetch(`${servers.url}/settings/teams/${slug}`, {
    method: "POST",
    headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ charter: "Ship small things.", dial }),
    redirect: "manual",
  });
  expect(post.status).toBeLessThan(400);
  expect(await teamMain(slug)).toContain("Ship small things.");
  const main = await teamsMain();
  expect(main).toMatch(/<h2>Recent changes<\/h2>\s*<ul[^>]*>\s*<li>/);
  const section = main.slice(main.indexOf("<h2>Recent changes</h2>"));
  expect(section).not.toContain("card");
  expect(main).toMatch(/id="teams-total">\d+%</);
});

test("a non-admin is refused with 403, on page and post", async () => {
  const res = await fetch(`${servers.url}/settings/teams`, { headers: { cookie: other }, redirect: "manual" });
  expect(res.status).toBe(403);
  const own = await fetch(`${servers.url}/settings/teams/design`, { headers: { cookie: other }, redirect: "manual" });
  expect(own.status).toBe(403);
  const post = await fetch(`${servers.url}/settings/teams/x`, { method: "POST", headers: { cookie: other }, redirect: "manual" });
  expect(post.status).toBe(403);
});
