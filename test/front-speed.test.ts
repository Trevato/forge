/** The signed-out front page is kept between requests, and any write or a forgotten ranking drops it (#6126). */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgetFrontScores, frontPage } from "../src/actions/front.ts";
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
