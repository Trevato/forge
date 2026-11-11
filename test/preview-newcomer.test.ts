/** The preview's newcomer: a claimed, untold person whose home is the first-login card (#11285). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { PREVIEW_NEWCOMER, PREVIEW_NEWCOMER_PAGE, PREVIEW_OWNER_LOOKS, ownerLooksFor } from "../src/spawn/preview-looks.ts";
import { checkFirstTell, previewAdmin, previewNewcomer, seedPreview } from "../src/spawn/preview-seed.ts";

let dir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-preview-newcomer-"));
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

test("the newcomer's home answers 200 with the one box and no passkey form above it", async () => {
  const cookie = `forge_session=${createSession(app.db, previewNewcomer(app)!.id).token}`;
  const res = await fetch(`${servers.url}/`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("What do you want built?");
  expect(body).toContain("data-first-tell");
  expect(checkFirstTell(res.status, body).ok).toBe(true);
});

test("the preview admin's home is still the full one", async () => {
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const body = await (await fetch(`${servers.url}/`, { headers: { cookie } })).text();
  expect(body).not.toContain("data-first-tell");
});

test("parent.json leaves the admin's settings page and /apps as they were", async () => {
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const read = async (path: string) => {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.text()).replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/\d{1,2}:\d{2}|\bago\b|\d+ ?[smhd]\b/g, "");
  };
  const file = join(dir, "parent.json");
  expect(existsSync(file)).toBe(true);
  const withParent = [await read("/settings"), await read("/apps")];
  await rename(file, `${file}.off`);
  try {
    expect([await read("/settings"), await read("/apps")]).toEqual(withParent);
  } finally {
    await rename(`${file}.off`, file);
  }
});

test("the check refuses a home without the box, a non-200, or a passkey form above it", () => {
  expect(checkFirstTell(404, "What do you want built?").ok).toBe(false);
  expect(checkFirstTell(200, "<h2>Home</h2>").ok).toBe(false);
  expect(checkFirstTell(200, "<form>Make a passkey</form><h2>What do you want built?</h2>").ok).toBe(false);
});

test("it is listed as a look taken as the newcomer, at desktop and phone, for the forge's own preview only", () => {
  for (const kind of ["desktop", "phone"] as const)
    expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_NEWCOMER_PAGE, kind, as: "newcomer" });
  const repo = { ownerName: "trevato", name: "forge" };
  expect(ownerLooksFor("trevato/forge", repo, "preview").some((l) => l.as === "newcomer")).toBe(true);
  expect(ownerLooksFor("trevato/forge", repo, "production")).toEqual([]);
});

test("nothing seeds outside a preview", async () => {
  const other = await mkdtemp(join(tmpdir(), "forge-preview-newcomer-prod-"));
  const prod = createApp({ dataDir: other, port: 0 });
  try {
    expect((await seedPreview(prod, { FORGE_APP_ENV: "production" })).ok).toBe(false);
    expect(previewNewcomer(prod)).toBeUndefined();
    expect(existsSync(join(other, "parent.json"))).toBe(false);
    expect(PREVIEW_NEWCOMER).toBe("preview-newcomer");
  } finally {
    prod.close();
    await rm(other, { recursive: true, force: true });
  }
});
