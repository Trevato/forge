/** The `crew` tool is Settings › Crew over MCP: list, plan, apply (admin token, never an agent). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createAgent } from "../src/actions/crew.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";
import { mcpTool } from "./helpers/mcp.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let admin = "";
let rw = "";
let agentTok = "";
let ro = "";
let bob = "";
let carol = "";

const names = (r: any): string[] => r.value.crew.map((m: any) => m.username);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-crew-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  proveAll(app);
  const repo = await createRepo(app, a.value, { name: "game", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const bot = await createAgent(app, a.value, { username: "robo" });
  if (!bot.ok) throw new Error(bot.error);
  const c = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
  if (!c.ok) throw new Error(c.error);
  promote(app.db, c.value);
  proveAll(app);
  const carolRepo = await createRepo(app, c.value, { name: "side", visibility: "public" });
  if (!carolRepo.ok) throw new Error(String(carolRepo.error));
  // Carol's address stops being proven once her repository exists.
  app.db.query("UPDATE email_check SET verified_at = NULL WHERE user_id = ?1").run(c.value.id);
  carol = createToken(app.db, c.value.id, "admin", "admin").token;
  bob = createToken(app.db, b.value.id, "admin", "admin").token;
  ro = createToken(app.db, a.value.id, "ro", "ro").token;
  admin = createToken(app.db, a.value.id, "admin", "admin").token;
  rw = createToken(app.db, a.value.id, "rw", "rw").token;
  agentTok = createToken(app.db, bot.value.user.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const crew = (token: string, args: Record<string, unknown>) =>
  mcpTool(servers.url, token, "crew", { repo: "alice/game", ...args });

test("lists, plans, applies and removes", async () => {
  expect(names(await crew(admin, {}))).toEqual([]);

  const plan = await crew(admin, { add: "robo" });
  expect(plan.value.changes).toBe(true);
  expect(plan.value.says).toContain("nothing changed");
  expect(names(await crew(admin, {}))).toEqual([]);

  const done = await crew(admin, { add: "robo", dryRun: false });
  expect(done.value.changed).toBe(true);
  const listed = await crew(admin, {});
  expect(names(listed)).toEqual(["robo"]);
  expect(listed.value.crew[0].role).toBeDefined();

  const planOut = await crew(admin, { remove: "robo" });
  expect(planOut.value.changes).toBe(true);
  expect(names(await crew(admin, {}))).toEqual(["robo"]);
  await crew(admin, { remove: "robo", dryRun: false });
  expect(names(await crew(admin, {}))).toEqual([]);
});

test("refusals are in words", async () => {
  expect((await crew(admin, { add: "bob" })).error).toContain("not_an_agent");
  expect((await crew(admin, { add: "ghost" })).error).toContain("no_such_agent");
  expect((await crew(admin, { add: "robo", remove: "robo" })).error).toContain("invalid");
});

test("applying needs an admin token and is never an agent's", async () => {
  expect((await crew(rw, { add: "robo", dryRun: false })).error).toContain("admin token");
  expect((await crew(agentTok, { add: "robo", dryRun: false })).error).toContain("person");
  expect(names(await crew(admin, {}))).toEqual([]);
});

test("a person who is not the repository's admin is refused, plan and apply", async () => {
  for (const dryRun of [true, false]) {
    const r = await crew(bob, { add: "robo", dryRun });
    expect(r.error).toContain("forbidden");
  }
  expect(names(await crew(admin, {}))).toEqual([]);
});

test("an admin whose email is not proven is refused on add", async () => {
  const r = await mcpTool(servers.url, carol, "crew", { repo: "carol/side", add: "robo", dryRun: false });
  expect(r.error).toContain("unverified");
  expect(names(await mcpTool(servers.url, carol, "crew", { repo: "carol/side" }))).toEqual([]);
});

test("a read-only token lists and plans but cannot apply", async () => {
  expect(names(await crew(ro, {}))).toEqual([]);
  expect((await crew(ro, { add: "robo" })).value.changes).toBe(true);
  const r = await crew(ro, { add: "robo", dryRun: false });
  expect(r.error).toContain("forbidden");
  expect(names(await crew(admin, {}))).toEqual([]);
});

test("config shows for the admin and not for a plain reader", async () => {
  await crew(admin, { add: "robo", dryRun: false });
  expect((await crew(admin, {})).value.crew[0].config).toBeDefined();
  const seen = await crew(bob, {});
  expect(names(seen)).toEqual(["robo"]);
  expect(seen.value.crew[0].config).toBeUndefined();
  await crew(admin, { remove: "robo", dryRun: false });
});

test("the listing carries the governor's slots and reason for a writer while the crew is on; null when off or for a reader (#7644)", async () => {
  expect((await crew(admin, {})).value.governor).toBeNull(); // the crew is off
  app.db.query("UPDATE repo SET autonomy = 'assisted', autonomy_slots = 4 WHERE name = 'game'").run();
  try {
    const on = (await crew(admin, {})).value.governor;
    expect(on).toEqual({ slots: 4, ceiling: 4, held: false, says: "", why: "Builders 4: a quiet hour, 0 of 0 open pulls moving" });
    expect((await crew(bob, {})).value.governor).toBeNull(); // bob cannot write to alice/game
  } finally {
    app.db.query("UPDATE repo SET autonomy = 'off' WHERE name = 'game'").run();
  }
});

test("the listing's governor carries what it last did once the slots changed (#11459)", async () => {
  app.db.query("UPDATE repo SET autonomy = 'assisted', autonomy_slots = 4 WHERE name = 'game'").run();
  const repoId = (app.db.query("SELECT id FROM repo WHERE name = 'game'").get() as any).id;
  app.db.query("INSERT INTO governor_last (repo_id, from_slots, to_slots, why, at) VALUES (?1, 4, 2, '9 opened vs 2 landed', ?2)").run(repoId, Date.UTC(2026, 9, 26, 20, 41));
  try {
    expect((await crew(admin, {})).value.governor.says).toBe("Builders 4 → 2 at 20:41: 9 opened vs 2 landed");
  } finally {
    app.db.query("DELETE FROM governor_last WHERE repo_id = ?1").run(repoId);
    app.db.query("UPDATE repo SET autonomy = 'off' WHERE name = 'game'").run();
  }
});

test("the crew answer carries the three seats, empty ones named", async () => {
  const r: any = await mcpTool(servers.url, admin, "crew", { repo: "alice/game" });
  const team = r.value.seats;
  expect(team.seats.map((p: any) => p.role)).toEqual(["planner", "builder", "reviewer"]);
  for (const p of team.seats) {
    expect(typeof p.does).toBe("string");
    if (p.by.length === 0) expect(p.without).toBeString();
  }
});
