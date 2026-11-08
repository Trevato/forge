/** The preview seeds one app and takes its page at desk and phone as the owner (#9782). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { PREVIEW_ADMIN, PREVIEW_APP, PREVIEW_APP_PAGE, PREVIEW_OWNER_LOOKS, seedPreview } from "../src/spawn/preview-seed.ts";

let dir: string;
let app: App;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-preview-app-"));
  app = createApp({ dataDir: dir, port: 0 });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
}, 60_000);
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the named list holds the app's page at desktop and phone", () => {
  expect(PREVIEW_APP_PAGE).toBe(`/${PREVIEW_ADMIN}/${PREVIEW_APP}`);
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_APP_PAGE, kind: "desktop" });
  expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_APP_PAGE, kind: "phone" });
});

test("the seed made one app, as a record only", () => {
  const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_APP)!;
  expect(getAppByRepo(app.db, repo.id)?.slug).toBe(PREVIEW_APP);
  expect(app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM app").get()!.n).toBe(1);
});
