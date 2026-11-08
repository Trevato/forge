/**
 * GET …/map on 1,000 closed and 200 open issues, 400 edges, 9 pillars and a
 * week of merges answers fast when warm, with the same bytes as a cold
 * build, and a plan shows at once (#3321).
 */
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepoById, updateRepoSettings } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mapSnapshots } from "../src/web/map_snapshot.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "", repoId = "";

const get = async (): Promise<{ body: string; ms: number; timing: string }> => {
  const t0 = performance.now();
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/map?done=1`, { headers: { authorization: `Bearer ${bearer}` } });
  const body = await res.text();
  return { body, ms: performance.now() - t0, timing: res.headers.get("server-timing") ?? "" };
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mapseed-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const userId = admin.value.id;
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  updateRepoSettings(app.db, getRepoById(app.db, repoId)!, { plansNeedNod: false });
  const mk = (title: string, kind: "issue" | "pull" = "issue", body = "") => {
    const r = createIssue(app.db, { repoId, authorId: userId, title, body, kind });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const umbrellas = Array.from({ length: 9 }, (_, i) => mk(`P${i + 1} Pillar ${i + 1}: umbrella`));
  const work = Array.from({ length: 1191 }, (_, i) => mk(`Issue ${i}`));
  app.db.transaction(() => {
    // Each pillar waits for work (200 edges); another 200 chain the work.
    for (let i = 0; i < 200; i++) addDependency(app.db, umbrellas[i % 9]!, work[i]!, userId);
    for (let i = 200; i < 400; i++) addDependency(app.db, work[i + 1]!, work[i]!, userId);
    // 1,000 closed, the rest open (191 + 9 umbrellas = 200).
    for (const w of work.slice(0, 1000))
      app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?1", [w.id]);
    // 7 days of merges: 3 a day... 10 a day, each closing a closed issue.
    for (let d = 0; d < 7; d++)
      for (let n = 0; n < 10; n++) {
        const closes = work[d * 10 + n]!;
        const pull = mk(`Pull ${d}-${n}`, "pull", `Closes #${closes.number}`);
        const at = new Date(Date.now() - (d * 86_400_000 + n * 3_600_000 + 60_000)).toISOString();
        app.db.run(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3, 'c')`,
          [pull.id, `b${d}-${n}`, at],
        );
      }
  })();
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("warm, the seed's map answers from its snapshot with the bytes of a cold build", async () => {
  mapSnapshots(app.db).clear();
  const cold = await get();
  const data = JSON.parse(cold.body) as { issues: unknown[]; edges: unknown[]; pillars: { merged?: number }[] };
  expect(data.issues.length).toBeGreaterThan(500);
  expect(data.edges.length).toBe(400);
  expect(data.pillars.length).toBeGreaterThanOrEqual(9);
  const hits = mapSnapshots(app.db).hits;
  const warm = await get();
  expect(mapSnapshots(app.db).hits).toBe(hits + 1);
  expect(warm.body).toBe(cold.body);
  // Counted, not timed: a warm map is served from its snapshot, a hit each time and a few statements at most.
  const warmHits = mapSnapshots(app.db).hits;
  expectWork(await statements(app.db, async () => void (await get())), { max: 9 });
  expect(mapSnapshots(app.db).hits).toBeGreaterThan(warmHits);
  expect(warm.timing).toContain("asktolive");
});

test("a plan is on the next read", async () => {
  await get();
  const before = JSON.parse((await get()).body) as { issues: { title: string }[] };
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/plan`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ issues: [{ key: "a", title: "Freshly planned", pillar: "P1" }] }),
  });
  expect(res.status).toBe(201);
  const after = JSON.parse((await get()).body) as { issues: { title: string }[] };
  expect(before.issues.some((i) => i.title === "Freshly planned")).toBe(false);
  expect(after.issues.some((i) => i.title === "Freshly planned")).toBe(true);
});
