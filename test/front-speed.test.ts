/** The signed-out front page is kept between requests, and any write or a forgotten ranking drops it (#6126). */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgetFrontScores, frontKey, frontPage } from "../src/actions/front.ts";
import { createRepo } from "../src/actions/repos.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { createApp as insertApp, type AppRecord } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import { encodePng } from "../src/design/image/png.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const HEAD = "a".repeat(40);
const PNG = Buffer.from(encodePng(1, 1, new Uint8Array([255, 255, 255, 255])));
const APPS = Number(process.env.N ?? 30);

let dataDir = "";
let app: App;
let runtime: AppsRuntime;
let restore: () => void;
const repoIds: string[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-front-speed-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "owner",
    allowReserved: true,
    email: "owner@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  promote(app.db, made.value);
  const owner: User = made.value;
  runtime = new AppsRuntime(app, {
    domain: "front.test",
    scheme: "http",
    publicPort: 0,
    forgeUrl: "http://localhost",
  });
  const status = spyOn(AppsRuntime.prototype, "status").mockImplementation(
    (): EnvStatus[] => [{ env: "production", state: "running", commitOid: HEAD } as EnvStatus],
  );
  restore = () => status.mockRestore();
  for (let n = 0; n < APPS; n++) {
    const name = `speed${n}`;
    const repo = await createRepo(app, owner, { name, visibility: "public", description: name });
    if (!repo.ok) throw new Error(String(repo.error));
    const record = insertApp(app.db, { repoId: repo.value.id, slug: name, access: "public" });
    if (!record.ok) throw new Error(record.error);
    const id = (record.value as AppRecord).id;
    mkdirSync(join(dataDir, "looks", id), { recursive: true });
    writeFileSync(join(dataDir, "looks", id, "thumb.png"), PNG);
    recordLook(app.db, {
      appId: id,
      env: "production",
      commitOid: HEAD,
      kind: "thumb",
      path: `looks/${id}/thumb.png`,
    });
    repoIds.push(repo.value.id);
  }
}, 60_000);

afterAll(async () => {
  restore();
  await runtime.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a second request is the page already built, not a new one", () => {
  const first = frontPage(app);
  expect(first.total).toBe(APPS);
  expect(first.shelf.length).toBeGreaterThan(0);
  expect(frontPage(app)).toBe(first);
});

test("forgetting the front scores drops the kept page", () => {
  const first = frontPage(app);
  expect(frontPage(app)).toBe(first);
  forgetFrontScores(app);
  expect(frontPage(app)).not.toBe(first);
});

test("making one app private builds a new page without it on the next request", () => {
  const before = frontPage(app);
  expect(frontPage(app)).toBe(before);
  const gone = before.shelf[0]!.repo;
  app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(gone.id);
  const after = frontPage(app);
  expect(after).not.toBe(before);
  expect(after.total).toBe(APPS - 1);
  expect([after.featured, ...after.shelf].some((e) => e?.repo.id === gone.id)).toBe(false);
});

test("a session insert and an issue_seq bump leave the kept page as it was (#6325)", () => {
  const first = frontPage(app);
  const owner = app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id;
  app.db
    .query("INSERT INTO session (token_hash, user_id, expires_at) VALUES ('h6325', ?1, '2099-01-01T00:00:00Z')")
    .run(owner);
  app.db.query("UPDATE repo SET issue_seq = issue_seq + 1, last_fetch_at = 'now'").run();
  expect(frontPage(app)).toBe(first);
});

test("archiving a repo, making an app private and retaking a thumb each give a new page (#6325)", () => {
  const ids = (p: ReturnType<typeof frontPage>) =>
    [p.featured, ...p.shelf].flatMap((e) => (e === undefined ? [] : [e.repo.id]));
  let page = frontPage(app);
  const [a, b] = ids(page);
  app.db.query("UPDATE repo SET archived_at = '2026-10-26T00:00:00Z' WHERE id = ?1").run(a!);
  let next = frontPage(app);
  expect(next).not.toBe(page);
  expect(frontPage(app)).toBe(next);
  page = next;
  app.db.query("UPDATE app SET access = 'private' WHERE repo_id = ?1").run(b!);
  next = frontPage(app);
  expect(next).not.toBe(page);
  expect(frontPage(app)).toBe(next);
  page = next;
  const appId = app.db.query<{ id: string }, [string]>("SELECT id FROM app WHERE repo_id = ?1").get(ids(page)[0]!)!.id;
  recordLook(app.db, { appId, env: "production", commitOid: "b".repeat(40), kind: "thumb", path: `looks/${appId}/thumb.png` });
  next = frontPage(app);
  expect(next).not.toBe(page);
  // A phone look, or a preview's thumb, is not the shelf's concern.
  recordLook(app.db, { appId, env: "production", commitOid: "c".repeat(40), kind: "phone", path: "x.png" });
  recordLook(app.db, { appId, env: "preview", commitOid: "c".repeat(40), kind: "thumb", path: "x.png" });
  expect(frontPage(app)).toBe(next);
});

test("with 2,000 more apps the key keeps its size and reads no app or look column (#6325)", () => {
  const owner = app.db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").get()!.id;
  const small = frontKey(app);
  app.db.transaction(() => {
    for (let n = 0; n < 2000; n++) {
      app.db.query("INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, 'public')").run(`bulk${n}`, owner, `bulk${n}`);
      app.db.query("INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, 'public')").run(`bulkapp${n}`, `bulk${n}`, `bulk${n}`);
    }
  })();
  const big = frontKey(app);
  expect(big).not.toBe(small);
  expect(big).toMatch(/^\d{1,9}$/);
  const page = frontPage(app);
  const asked: string[] = [];
  const spy = spyOn(app.db, "query").mockImplementation(((sql: string) => {
    asked.push(sql);
    return (Object.getPrototypeOf(app.db).query as (s: string) => unknown).call(app.db, sql);
  }) as never);
  expect(frontPage(app)).toBe(page);
  spy.mockRestore();
  expect(asked).toEqual(["SELECT n FROM front_epoch"]);
});
