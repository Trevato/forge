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
import { checkMoveSection, previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";

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

test("its Settings is looked at on desktop and phone, by the fragment that lands on the move section", async () => {
  for (const kind of ["desktop", "phone"] as const)
    expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: "/preview-admin/sample/settings#move", kind });
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const res = await fetch(`${servers.url}/preview-admin/sample/settings`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('id="move"');
});

test("the seed refuses a Settings that is not 200 or lacks the move section", async () => {
  const answer = (status: number, body: string) => async () => ({ status, text: async () => body });
  expect((await checkMoveSection(answer(200, '<section id="move">'))).ok).toBe(true);
  const missing = await checkMoveSection(answer(404, ""));
  expect(!missing.ok && missing.error).toContain("404");
  const bare = await checkMoveSection(answer(200, "<h2>Move to another owner</h2>"));
  expect(!bare.ok && bare.error).toContain('id="move"');
});
