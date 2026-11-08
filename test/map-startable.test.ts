/** GET …/map `startable` (#6177): ready, unassigned, unheld; `counts.ready` agrees with it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { addComment, createIssue } from "../src/core/issues.ts";
import { HOT_PULLS, rememberPullFiles } from "../src/crew/hot_files.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, repoId = "", bearer = "";
const nums: Record<string, number> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mapstart-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  repoId = repo.id;
  rememberPullFiles(
    repoId,
    Array.from({ length: HOT_PULLS }, (_, i) => ({ number: i + 1, files: ["src/hot.ts", `src/own${i}.ts`] })),
  );
  const add = (key: string, title: string) => {
    const r = createIssue(app.db, { repoId: repo.id, authorId: admin.value.id, title, body: "" });
    if (!r.ok) throw new Error(r.error);
    nums[key] = r.value.number;
    return r.value;
  };
  add("free", "Free");
  const taken = add("taken", "Taken");
  const front = add("front", "In front");
  const waits = add("waits", "Waits");
  add("hot", "Add a flag to src/hot.ts");
  const parked = add("parked", "Parked");
  for (let n = 0; n < 2; n++) {
    const said = addComment(app.db, {
      issueId: parked.id,
      authorId: admin.value.id,
      body: "Parked by the crew: the check stayed red past its tries.",
    });
    if (!said.ok) throw new Error(said.error);
  }
  // Working but unassigned: only the word keeps it off the list.
  const busy = add("working", "Crew is on it");
  const agent = await createAgent(app, admin.value, { username: "scout" });
  if (!agent.ok) throw new Error(String(agent.error));
  if (!addToCrew(app, admin.value, repo, "scout").ok) throw new Error("crew");
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: busy.id,
    actorId: getUserByName(app.db, "scout")!.id,
    reason: "assigned",
  });
  if (claimRun(app.db, run.id) === undefined) throw new Error("claim");
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  const a = assignIssue(app, admin.value, repo, taken, admin.value);
  if (!a.ok) throw new Error(String(a.error));
  const d = addDependency(app.db, waits, front, admin.value.id);
  if (!d.ok) throw new Error(String(d.error));
});

afterAll(async () => {
  rememberPullFiles(repoId, []);
  servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("startable leaves out the assigned and the waiting, and counts.ready equals its length", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/map`);
  const body = (await res.json()) as {
    ready: { number: number }[];
    startable: number[];
    counts: { ready: number };
  };
  expect(body.startable).toContain(nums.free!);
  expect(body.startable).toContain(nums.front!);
  expect(body.startable).not.toContain(nums.taken!);
  expect(body.startable).not.toContain(nums.waits!);
  expect(body.ready.map((r) => r.number)).not.toContain(nums.waits!);
  expect(body.counts.ready).toBe(body.startable.length);
  expect(body.startable.every((n) => body.ready.some((r) => r.number === n))).toBe(true);
});

test("a filter-held, parked or crew-working issue is ready or counted out, but never startable", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/map`);
  const body = (await res.json()) as {
    ready: { number: number; held: { by: string } | null }[];
    startable: number[];
  };
  const held = body.ready.find((r) => r.number === nums.hot!);
  expect(held?.held?.by).toBe("hot_file");
  expect(body.startable).not.toContain(nums.hot!);
  expect(body.startable).not.toContain(nums.parked!);
  expect(body.startable).not.toContain(nums.working!);
  expect(body.startable).toContain(nums.free!);
});

test("the MCP map tool carries startable, and counts.ready agrees", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "map", arguments: { app: "alice/notes" } },
    }),
  });
  const body: any = await res.json();
  const map = JSON.parse(body.result.content[0].text) as { startable: number[]; counts: { ready: number } };
  expect(map.startable).toContain(nums.free!);
  expect(map.startable).not.toContain(nums.hot!);
  expect(map.startable).not.toContain(nums.parked!);
  expect(map.startable).not.toContain(nums.working!);
  expect(map.counts.ready).toBe(map.startable.length);
});

test("the forge-wide map's lanes carry startable without the filters", async () => {
  const res = await fetch(`${servers.url}/api/v1/map`, { headers: { authorization: `Bearer ${bearer}` } });
  const body = (await res.json()) as { repos: { repo: { name: string }; startable: number[]; counts: { ready: number } }[] };
  const lane = body.repos.find((r) => r.repo.name === "notes")!;
  expect(lane.startable).toContain(nums.free!);
  expect(lane.startable).toContain(nums.hot!);
  expect(lane.startable).not.toContain(nums.parked!);
  expect(lane.startable).not.toContain(nums.working!);
  expect(lane.counts.ready).toBe(lane.startable.length);
});
