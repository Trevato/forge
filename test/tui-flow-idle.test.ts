/** The Flow dialog lists the idle crew pulls (#6479). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
let dir: string;
let app: App;
let seed = "";
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-flow-idle-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "scout", email: "s@forge.local", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  seed = u.value.id;
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [seed]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'pub', 'public')", [seed]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('priv', ?1, 'priv', 'private')", [seed]);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

function idlePull(repo: string, hours = 100): number {
  n++;
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, 'open', ?5)",
    [`p${n}`, repo, n, seed, new Date(NOW.getTime() - hours * 3_600_000).toISOString()],
  );
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', 'h')", [`p${n}`, `b${n}`]);
  return n;
}
const admin = (): string => flowLines(app.db, NOW, [], undefined, undefined).join("\n");
const guest = (): string => flowLines(app.db, NOW, [], { queues: [] }, undefined).join("\n");

test("with no idle pull the dialog draws nothing about them", () => {
  expect(admin()).not.toContain("idle");
});

test("an idle crew pull has its line on the screen", () => {
  const p = idlePull("pub");
  expect(admin()).toContain("idle: 1");
  expect(admin()).toContain(`#${p} pub · 100 h since a push`);
});

test("a private repository's idle pull is the admin's alone", () => {
  const p = idlePull("priv", 90);
  expect(admin()).toContain(`#${p} priv`);
  expect(guest()).not.toContain(`#${p} priv`);
  expect(guest()).toContain("idle: 1");
});

test("past five pulls the rest is summarised", () => {
  for (let i = 0; i < 6; i++) idlePull("pub", 120 + i);
  const text = admin();
  expect(text).toContain("idle: 8");
  expect(text).toContain("+3 more");
});

test("at the reader's cap the count reads 20+, not a false total", () => {
  for (let i = 0; i < 20; i++) idlePull("pub", 130 + i);
  const text = admin();
  expect(text).toContain("idle: 20+");
  expect(text).toContain("+15+ more");
});
