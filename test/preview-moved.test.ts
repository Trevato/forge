/** The preview's recently moved repository draws "Moved from" in its first-paint HTML (#10195). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { recentMove } from "../src/core/transfer.ts";
import { getRepo } from "../src/core/repos.ts";
import { PREVIEW_ADMIN, PREVIEW_MOVED, PREVIEW_MOVED_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";

let dir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-preview-moved-"));
  app = createApp({ dataDir: dir, port: 0 });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the moved repository's head says where from, in the HTML the server sends", async () => {
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const res = await fetch(`${servers.url}${PREVIEW_MOVED_PAGE}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("moved-from");
  expect(html).toContain(`Moved from ${PREVIEW_ADMIN}/${PREVIEW_MOVED} on`);
  const repo = getRepo(app.db, "preview-ada", PREVIEW_MOVED)!;
  expect(recentMove(app.db, repo.id)?.from).toBe(`${PREVIEW_ADMIN}/${PREVIEW_MOVED}`);
});

test("its head is looked at on desktop and phone", () => {
  for (const kind of ["desktop", "phone"] as const)
    expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_MOVED_PAGE, kind });
});
