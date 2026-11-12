import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";

let dir = "";
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-preview-grace-"));
  app = createApp({ dataDir: dir, port: 0 });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => {
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};

test("a seeded preview shows the Plan row in grace and the grace row on /forges", async () => {
  expect(await get("/settings")).toMatch(/Payment due — paused on \d+ \w+/);
  expect(await get("/forges")).toMatch(/grace until \d{4}-\d{2}-\d{2}/);
});

test("home carries no notice, and a second seed changes nothing", async () => {
  expect(await get("/")).not.toContain("Payment due");
  const again = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  expect(again.ok && again.value.seeded).toBe(false);
});

test("the looks take /settings and /forges", () => {
  for (const p of ["/settings", "/forges"]) expect(PREVIEW_OWNER_LOOKS.filter((l) => l.page === p).length).toBe(2);
});

test("outside a preview nothing is seeded", async () => {
  const other = await mkdtemp(join(tmpdir(), "forge-no-grace-"));
  const a = createApp({ dataDir: other, port: 0 });
  try {
    const r = await seedPreview(a, { FORGE_APP_ENV: "production" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(other, "plan.json"))).toBe(false);
    expect(existsSync(join(other, "spawn"))).toBe(false);
  } finally {
    a.close();
    await rm(other, { recursive: true, force: true });
  }
});
