/** The new-organization page and a team's page are sections and rows, not cards (#9763). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg, createTeam } from "../src/actions/orgs.ts";
import { listTeams } from "../src/core/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let owners = "";
let crew = "";
let empty = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-org-team-rows-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = createOrg(app, u.value, "acme");
  if (!made.ok) throw new Error(made.error);
  owners = listTeams(app.db, made.value.id).find((x) => x.name === "Owners")!.id;
  const t = createTeam(app, u.value, made.value, "crew", "write");
  if (!t.ok) throw new Error("team");
  crew = t.value.id;
  const e = createTeam(app, u.value, made.value, "empty", "read");
  if (!e.ok) throw new Error("team");
  empty = e.value.id;
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const main = (body: string) => body.slice(body.indexOf("<h1"));

test("a team's page is headed sections over rows, with no card", async () => {
  const body = main(await (await fetch(`${servers.url}/acme/-/teams/${crew}`, { headers: { cookie } })).text());
  expect(body).not.toMatch(/class="[^"]*\bcard\b/);
  expect(body).toContain('<section class="settings-block">');
  for (const h of ["Members", "Add a member", "Delete this team"]) expect(body).toContain(`<h2>${h}</h2>`);
  expect(body).toContain('action="/acme/-/teams/' + crew + '/add"');
  expect(body).not.toContain("Danger zone");
});

test("Owners lists its member as a row with a Remove link, and cannot be deleted", async () => {
  const body = main(await (await fetch(`${servers.url}/acme/-/teams/${owners}`, { headers: { cookie } })).text());
  expect(body).toContain('<ul class="list setting-list">');
  expect(body).not.toContain("Delete this team");
  expect(body).not.toMatch(/class="[^"]*\bcard\b/);
});

test("an empty team is one muted line, not an empty-state box", async () => {
  const body = main(await (await fetch(`${servers.url}/acme/-/teams/${empty}`, { headers: { cookie } })).text());
  expect(body).toContain('<p class="muted">Nobody is on this team yet.</p>');
  expect(body).not.toContain("empty-title");
});

test("the new-organization page opens with one sentence, then the form", async () => {
  const body = main(await (await fetch(`${servers.url}/organizations/new`, { headers: { cookie } })).text());
  expect(body).toContain('action="/organizations/new"');
  expect(body).not.toMatch(/class="[^"]*\bcard\b/);
  expect(body).toContain("hands out access through teams.");
  expect(body).not.toContain("first owner");
  expect(body.match(/<p class="muted small mb">/g)?.length).toBe(1);
});
