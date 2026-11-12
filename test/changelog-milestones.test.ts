/** /changelog opens with how close each open milestone is, and with none shows no block (#11409). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserById } from "../src/core/users.ts";
import { nearLines } from "../src/tui/screens/changelog.ts";
import { nearMilestones } from "../src/web/pages/milestones_near.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let repoId: string;
let userId: string;
let n = 0;

/** A milestone: an umbrella waiting for `done` closed and `open` open issues. */
function milestone(name: string, done: number, open: number, inRepo = repoId): string {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const add = (title: string, state: string) => {
    const repo = inRepo;
    const id = `i${++n}`;
    app.db.run(
      "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at, closed_at) VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, ?6, ?7, ?7, ?8)",
      [id, repo, n, title, userId, state, at, state === "open" ? null : at],
    );
    return id;
  };
  const umbrella = add(name, "open");
  for (let i = 0; i < done; i++) app.db.run("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)", [umbrella, add(`${name} done ${i}`, "closed")]);
  for (let i = 0; i < open; i++) app.db.run("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)", [umbrella, add(`${name} open ${i}`, "open")]);
  return umbrella;
}

const close = (id: string) => app.db.run("UPDATE issue SET state = 'closed', closed_at = ?2 WHERE id = ?1", [id, new Date().toISOString()]);
const read = async (as?: string) => (await fetch(`${servers.url}/changelog`, as === undefined ? {} : { headers: { cookie: as } })).text();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-changelog-ms-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge" });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  userId = u.value.id;
  const made = await createRepo(app, u.value, { name: "forge", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = getRepo(app.db, "alice", "forge")!.id;
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("each open milestone is one line: name, N of M done, a bar, linked to its page", async () => {
  milestone("Alpha goal", 1, 2);
  milestone("Beta goal", 3, 1);
  const res = await fetch(`${servers.url}/changelog`);
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain('id="milestones-near"');
  expect(body).toContain("Alpha goal");
  expect(body).toContain("1 of 3 done");
  expect(body).toContain("Beta goal");
  expect(body).toContain("3 of 4 done");
  expect(body).toContain("<progress");
  expect(body).toMatch(/href="\/alice\/forge\/milestones\/\d+"[^>]*>Alpha goal/);
  expect(body.indexOf("milestones-near")).toBeLessThan(body.indexOf('id="shipped"'));
});

test("closing the milestones takes the block away", async () => {
  const gone = milestone("Gamma goal", 0, 1);
  expect(await read()).toContain("Gamma goal");
  close(gone);
  const body = await read();
  expect(body).not.toContain("Gamma goal");
});

test("with every milestone closed the block is absent", async () => {
  for (const r of app.db.query<{ id: string }, [string]>("SELECT id FROM issue WHERE repo_id = ?1 AND state = 'open' AND title LIKE '% goal'").all(repoId)) close(r.id);
  expect(await read()).not.toContain("milestones-near");
});

test("a deferred milestone is left out", async () => {
  const live = milestone("Delta goal", 0, 1);
  const later = milestone("Epsilon goal", 0, 1);
  const gate = `g${++n}`;
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'issue', 'Later gate: not yet', '', ?4, 'open', ?5, ?5)",
    [gate, repoId, n, userId, new Date().toISOString()],
  );
  app.db.run("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)", [later, gate]);
  const body = await read();
  expect(live).not.toBe(later);
  expect(body).toContain("Delta goal");
  expect(body).not.toContain("Epsilon goal");
});

test("a private repository's milestones are not shown to a guest, and are to its owner", async () => {
  app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [repoId]);
  try {
    expect(await read()).not.toContain("Delta goal");
    expect(nearMilestones(app, "alice/forge", undefined)).toBeUndefined();
    const owner = getUserById(app.db, userId)!;
    expect(nearMilestones(app, "alice/forge", owner)?.near.map((m) => m.name)).toContain("Delta goal");
  } finally {
    app.db.run("UPDATE repo SET visibility = 'public' WHERE id = ?1", [repoId]);
  }
  expect(await read()).toContain("Delta goal");
});

test("the terminal says the same lines", () => {
  const near = nearMilestones(app, "alice/forge", undefined)!.near;
  expect(nearLines(near)).toContain("Delta goal  0 of 1 done");
  expect(nearLines(near).join("\n")).not.toContain("Epsilon goal");
});
