/** An org's profile speaks the home page's language (#9890): plain sections under headings, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

const PASS = "a-good-passphrase";

async function mk(username: string, first = false) {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.test`,
    password: PASS,
    adminIfFirst: first,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

async function get(path: string, as: string): Promise<string> {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: as, password: PASS }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const got = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(got.status).toBe(200);
  return got.text();
}

const noBoxes = (body: string) => {
  expect(body).not.toContain('class="card');
  expect(body).not.toContain("card-body");
};
const h1s = (body: string) => body.match(/<h1[\s>]/g)?.length ?? 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-org-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  await mk("alice", true);
  const bob = await mk("bob");
  const carol = await mk("carol");
  const dave = await mk("dave");
  const acme = createOrg(app.db, "acme", bob.id);
  if (!acme.ok) throw new Error("org");
  const readers = createTeam(app.db, acme.value.id, "Readers", "read");
  if (!readers.ok) throw new Error("team");
  addTeamMember(app.db, readers.value, carol.id);
  const orphan = createOrg(app.db, "orphan", dave.id);
  if (!orphan.ok) throw new Error("org");
  const watchers = createTeam(app.db, orphan.value.id, "Watchers", "read");
  if (!watchers.ok) throw new Error("team");
  addTeamMember(app.db, watchers.value, carol.id);
  app.db.run("UPDATE user SET suspended_at = ? WHERE id = ?", [new Date().toISOString(), dave.id]);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an org with teams: one h1, plain sections, the form for its owner", async () => {
  const body = await get("/acme", "bob");
  noBoxes(body);
  expect(h1s(body)).toBe(1);
  expect(body).toContain(">Teams</h2>");
  expect(body).toContain(">Members</h2>");
  expect(body).toContain("<h2>New team</h2>");
  expect(body).toContain('action="/acme/-/teams"');
  expect(body).toContain("Readers");
});

test("a member who cannot manage sees the teams and no form", async () => {
  const body = await get("/acme", "carol");
  noBoxes(body);
  expect(body).toContain(">Teams</h2>");
  expect(body).not.toContain("New team");
  expect(body).not.toContain('action="/acme/-/teams"');
});

test("an ownerless org says so in one plain line, not a box", async () => {
  const body = await get("/orphan", "carol");
  noBoxes(body);
  expect(h1s(body)).toBe(1);
  expect(body).toContain("Nobody can administer this organization");
  expect(body).toContain('data-tone="attn"');
  expect(body).toContain('href="/orphan/-/teams/Owners"');
});

test("a forge admin sees no box on an org page, grants and secrets included", async () => {
  const body = await get("/acme", "alice");
  noBoxes(body);
  expect(body).toContain("Secrets");
  expect(body).toContain("Subscriptions for every repository here");
  expect(body).not.toContain('class="mt"><h2');
});

test("an org with no teams says so in one muted line", async () => {
  const eve = await mk("eve");
  const empty = createOrg(app.db, "hollow", eve.id);
  if (!empty.ok) throw new Error("org");
  app.db.run("DELETE FROM team WHERE org_id = ?", [empty.value.id]);
  const body = await get("/hollow", "alice");
  expect(body).toContain("No teams yet");
});

test("a person's profile shows what it did, without boxes", async () => {
  const body = await get("/bob", "carol");
  noBoxes(body);
  expect(h1s(body)).toBe(1);
  expect(body).toContain("@bob");
  expect(body).not.toContain(">Teams</h2>");
});
