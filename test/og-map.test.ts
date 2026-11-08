/** The map's share card on 2,000 closed and 300 open issues stays small and quick (#6150). */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

setDefaultTimeout(60_000);

let dataDir = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ogmap-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const repoId = made.value.id;
  const issues = Array.from({ length: 2300 }, (_, i) => {
    const r = createIssue(app.db, { repoId, authorId: admin.value.id, title: `Issue ${i}`, body: "" });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  });
  app.db.transaction(() => {
    // The first 2,000 are chained and closed; the last 300 are chained in tens and open.
    for (let i = 1; i < 2000; i++) addDependency(app.db, issues[i]!, issues[i - 1]!, admin.value.id);
    for (let i = 2000; i < 2300; i++)
      if (i % 10 !== 0) addDependency(app.db, issues[i]!, issues[i - 1]!, admin.value.id);
    for (const w of issues.slice(0, 2000))
      app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?1", [w.id]);
  })();
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("the card draws open issues only, names the done count, and resolves fast", async () => {
  await fetch(`${servers.url}/og/map/alice~notes.svg`).then((r) => r.arrayBuffer()); // warm
  const res = await fetch(`${servers.url}/og/map/alice~notes.svg`);
  const svg = await res.text();
  expect(res.status).toBe(200);
  expect(new TextEncoder().encode(svg).length).toBeLessThan(300_000);
  expect(svg).toContain("2000 done");
  expect(svg).toContain("300 open issues");
  const resolve = /resolve;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "");
  expect(resolve).not.toBeNull();
  expect(Number(resolve![1])).toBeLessThan(150);
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]);
  for (const n of ["graph", "marks", "layout"]) expect(names).toContain(n);
});
