/** The preview seeds one app and takes its page at desk and phone as the owner (#9782). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getUserByName } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { studioApp } from "../src/web/studio/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { ownerLooksFor } from "../src/spawn/preview-looks.ts";
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

test("a forge preview takes the app's page at both widths, whatever its diff touches (#9797)", () => {
  const looks = ownerLooksFor("trevato/forge", { ownerName: "trevato", name: "forge" }, "pull-1");
  for (const kind of ["desktop", "phone"] as const)
    expect(looks).toContainEqual({ page: PREVIEW_APP_PAGE, kind });
  // Another repository's preview, and production, take none of them.
  expect(ownerLooksFor("trevato/forge", { ownerName: "x", name: "y" }, "pull-1")).toEqual([]);
  expect(ownerLooksFor("trevato/forge", { ownerName: "trevato", name: "forge" }, "production")).toEqual([]);
});

test("the app's page says in plain words why Open the app is off when nothing runs (#9797)", async () => {
  const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_APP)!;
  const record = getAppByRepo(app.db, repo.id)!;
  const admin = getUserByName(app.db, PREVIEW_ADMIN)!;
  const url = new URL(`https://preview.invalid${PREVIEW_APP_PAGE}`);
  const answer = await studioApp(
    { app, request: new Request(url.href), url, params: {}, auth: { user: admin }, theme: undefined } as Ctx,
    repo,
    record,
  );
  expect(answer.status).toBe(200);
  expect(await answer.text()).toContain('title="Nothing is running yet. The app starts when it is deployed."');
});
