/** GET /changelog stays instant as history grows: 500 release entries, median of warm GETs under budget (#10724). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** The page's budget in milliseconds, as the palette's timing test states its own. */
const BUDGET_MS = 50;
const ENTRIES = 500;
const RUNS = 3;

let dataDir: string;
let app: App;
let servers: Servers;
const saved = process.env["FORGE_COMMIT"];

beforeAll(async () => {
  process.env["FORGE_COMMIT"] = "a".repeat(40);
  dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-timing-"));
  app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "forge", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const insertIssue = app.db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', ?4, ?5, 'closed')`,
  );
  const insertPull = app.db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid) VALUES (?1, ?2, 'b', 'base', '', ?3, ?4)`,
  );
  const oids: string[] = [];
  app.db.transaction(() => {
    for (let n = 1; n <= ENTRIES; n++) {
      insertIssue.run(`i${n}`, made.value.id, n, `Release entry ${n}`, u.value.id);
      const at = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();
      insertPull.run(`i${n}`, made.value.defaultBranch, at, `oid-${n}`);
      oids.push(`oid-${n}`);
    }
  })();
  keepLive("alice/forge", oids, 0);
}, 60_000);

afterAll(async () => {
  forgetLive();
  if (saved === undefined) delete process.env["FORGE_COMMIT"];
  else process.env["FORGE_COMMIT"] = saved;
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test(`${ENTRIES} entries: GET /changelog answers in under ${BUDGET_MS} ms (median of ${RUNS} warm runs)`, async () => {
  const warm = await fetch(`${servers.url}/changelog`);
  expect(warm.status).toBe(200);
  expect(await warm.text()).toContain("Release entry");
  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const res = await fetch(`${servers.url}/changelog`);
    await res.arrayBuffer();
    runs.push(performance.now() - t);
    expect(res.status).toBe(200);
  }
  const m = median(runs);
  console.log(`changelog median ${m.toFixed(1)} ms over ${ENTRIES} entries (${runs.map((r) => r.toFixed(1)).join(", ")})`);
  expect(m).toBeLessThan(BUDGET_MS);
}, 60_000);
