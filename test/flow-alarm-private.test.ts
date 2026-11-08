/** A stuck pull in a private repository: the owner's `flow` reading and terminal name it, an agent's never does (#6346). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();
let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "alarm-private-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility, autonomy) VALUES ('r', ?1, 'secretrepo', 'private', 'auto')", [u.value.id]);
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES ('p1', 'r', 1, 'pull', 't', ?1, 'open', ?2)", [u.value.id, ago(10_000)]);
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('p1', 'main', 'b1', '', 'h')");
  app.db.run("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES ('rv', 'p1', ?1, 'approved', 'h', ?2)", [u.value.id, ago(600)]);
  app.db.run("INSERT INTO run (id, repo_id, kind, issue_id, state, commit_oid, created_at, finished_at) VALUES ('c', 'r', 'check', 'p1', 'ok', 'h', ?1, ?1)", [ago(60)]);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

test("the owner's alarms name the private pull; an agent's leave it and the idle-crew line out", () => {
  const owner = flowFor(app, { kind: "owner" }, NOW).alarms;
  expect(owner.map((a) => a.key)).toContain("stuck");
  expect(owner.find((a) => a.key === "stuck")!.says).toContain("alice/secretrepo#1");
  const agent = flowFor(app, { kind: "agent" } as never, NOW).alarms;
  expect(JSON.stringify(agent)).not.toContain("secretrepo");
  expect(agent.map((a) => a.key)).not.toContain("idle_crew");
});

test("the terminal's flow screen draws the fired alarm for the owner and not for an agent", () => {
  expect(flowLines(app.db, NOW, []).join("\n")).toContain("alice/secretrepo#1 has sat approved");
  expect(flowLines(app.db, NOW, [], { queues: [] }).join("\n")).not.toContain("secretrepo");
});
