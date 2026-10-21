/** The delivery series on `/metrics` (#3750): each moves when its fact lands, and a private repository shows its id only. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { recordRelease } from "../src/release/record.ts";
import { forgeMetrics } from "../src/metrics/forge.ts";

let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "metrics-delivery-"));
  app = createApp({ dataDir: dir, port: 0 });
  app.db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'ann', 'a@f.dev', 'x')");
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('rpub', 'u1', 'open', 'public')");
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('rpriv', 'u1', 'secretname', 'private')");
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const text = (now?: number) => forgeMetrics(app.db, undefined, now);
const issue = (id: string, repo: string, n: number, kind: string, body: string, at: string) =>
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, created_at) VALUES (?1, ?2, ?3, ?4, 't', ?5, 'u1', ?6)",
    [id, repo, n, kind, body, at],
  );

test("a merged pull moves forge_pulls_merged_total, public by name and private by id", () => {
  expect(text()).not.toContain("forge_pulls_merged_total{");
  issue("p1", "rpub", 2, "pull", "Closes #1", "2026-01-01T00:10:00.000Z");
  issue("p2", "rpriv", 1, "pull", "", "2026-01-01T00:10:00.000Z");
  for (const id of ["p1", "p2"])
    app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1,'main','h','a','b','2026-01-01T01:00:00.000Z')", [id]);
  const t = text();
  expect(t).toContain('forge_pulls_merged_total{repo="ann/open"} 1');
  expect(t).toContain('forge_pulls_merged_total{repo="rpriv"} 1');
  expect(t).not.toContain("secretname");
});

test("a release moves forge_releases_total and the ask-to-live histogram", () => {
  issue("i1", "rpub", 1, "issue", "ask", "2026-01-01T00:00:00.000Z");
  expect(text()).toContain("forge_releases_total 0");
  expect(text()).toContain("forge_ask_to_live_seconds_count 0");
  const r = recordRelease(app.db, { sha: "abc", repoId: "rpub", pullNumber: 2, ok: true, line: "ok" });
  app.db.run("UPDATE release SET created_at = '2026-01-01T00:30:00.000Z' WHERE id = ?1", [r.id]);
  const t = text();
  expect(t).toContain("forge_releases_total 1");
  expect(t).toContain("forge_ask_to_live_seconds_count 1");
  expect(t).toContain("forge_ask_to_live_seconds_sum 1800");
  expect(t).toContain('forge_ask_to_live_seconds_bucket{le="900"} 0');
  expect(t).toContain('forge_ask_to_live_seconds_bucket{le="3600"} 1');
});

test("a failing then fixed main moves forge_main_red_seconds_total", () => {
  const run = (id: string, state: string, at: string) =>
    app.db.run(
      "INSERT INTO run (id, repo_id, kind, env, state, finished_at) VALUES (?1, 'rpriv', 'check', 'main', ?2, ?3)",
      [id, state, at],
    );
  run("r1", "ok", "2026-02-01T00:00:00.000Z");
  expect(text()).toContain('forge_main_red_seconds_total{repo="rpriv"} 0');
  run("r2", "failed", "2026-02-01T01:00:00.000Z");
  const still = Date.parse("2026-02-01T01:01:00.000Z");
  expect(text(still)).toContain('forge_main_red_seconds_total{repo="rpriv"} 60');
  run("r3", "ok", "2026-02-01T01:10:00.000Z");
  expect(text(still + 86_400_000)).toContain('forge_main_red_seconds_total{repo="rpriv"} 600');
});

test("a failed release is not the ask going live: only the good one counts", () => {
  issue("i9", "rpub", 8, "issue", "ask", "2026-02-01T00:00:00.000Z");
  issue("p9", "rpub", 9, "pull", "Closes #8", "2026-02-01T00:01:00.000Z");
  const before = /forge_releases_total (\d+)/.exec(text())![1]!;
  const sumBefore = Number(/forge_ask_to_live_seconds_sum (\S+)/.exec(text())![1]);
  const at = (ok: boolean, time: string) => {
    const r = recordRelease(app.db, { sha: "def", repoId: "rpub", pullNumber: 9, ok, line: "x" });
    app.db.run("UPDATE release SET created_at = ?2 WHERE id = ?1", [r.id, time]);
  };
  at(false, "2026-02-01T00:05:00.000Z");
  at(true, "2026-02-01T00:30:00.000Z");
  const t = text();
  expect(Number(/forge_ask_to_live_seconds_sum (\S+)/.exec(t)![1]) - sumBefore).toBe(1800);
  expect(Number(/forge_releases_total (\d+)/.exec(t)![1]) - Number(before)).toBe(1);
});
