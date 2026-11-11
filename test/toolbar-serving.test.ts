/** The panel says which commit the page is serving and since when, from the forge's record (#11480). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { createUser } from "../src/core/users.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { pillWhere, type AppTarget } from "../src/apps/proxy.ts";
import type { AppsRuntime } from "../src/apps/runtime.ts";
import { toolbarTag } from "../src/apps/toolbar.ts";
import { boot } from "./helpers/toolbar-boot.ts";

const OID = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const base = { app: "notes", env: "production", repo: "alice/notes", forge: "https://forge.test" };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const line = (set: Record<string, string>) => {
  const b = boot(null, 400, 800, set);
  const els: any[] = [b.panel];
  const walk = (e: any) => e.children.forEach((c: any) => { els.push(c); walk(c); });
  walk(b.panel);
  return { texts: b.texts(), anchors: els.filter((e) => e.tag === "a") };
};

test("with a record the panel says the short id, linked to the commit, and how long ago", () => {
  const { texts, anchors } = line({ ...base, commit: OID, live: ago(4 * 60000 + 5000) });
  expect(texts).toContain("Serving ");
  expect(texts).toContain("a1b2c3d");
  expect(texts).toContain(", live 4 min ago");
  expect(anchors.find((a) => a.textContent === "a1b2c3d")?.href).toBe(`https://forge.test/alice/notes/commit/${OID}`);
});

test("without a record the line is left out", () => {
  expect(line(base).texts.some((t) => t.startsWith("Serving"))).toBe(false);
  expect(line({ ...base, commit: OID }).texts.some((t) => t.startsWith("Serving"))).toBe(false);
  expect(line({ ...base, commit: "<b>x</b>", live: ago(1000) }).texts.some((t) => t.startsWith("Serving"))).toBe(false);
});

test("the tag carries the record as escaped attributes, and an app name with markup stays text", () => {
  const evil = 'a"><img src=x onerror=1>';
  const tag = toolbarTag("https://forge.test", { app: evil, env: "production", serving: { oid: OID, at: "2026-01-01T00:00:00.000Z" } });
  expect(tag).toContain(` data-commit="${OID}"`);
  expect(tag).toContain(` data-live="2026-01-01T00:00:00.000Z"`);
  expect(tag).not.toContain("<img");
  expect(toolbarTag("https://forge.test", { app: "a", env: "production" })).not.toContain("data-commit");
  expect(line({ ...base, app: evil, commit: OID, live: ago(1000) }).texts).toContain(evil);
});

test("pillWhere takes the commit and time from the runtime's record, for a reader only", () => {
  const status = { state: "running", commitOid: OID, servingAt: "2026-01-01T00:00:00.000Z" };
  const w = (st: unknown, who?: unknown) =>
    pillWhere({ app: fake.app, envStatus: () => st } as unknown as AppsRuntime, fake.target, who as never);
  expect(w(status).serving).toEqual({ oid: OID, at: "2026-01-01T00:00:00.000Z" });
  expect(w(undefined).serving).toBeUndefined();
  expect(w({ ...status, state: "deploying" }).serving).toBeUndefined();
});


const fake = {} as { app: App; target: AppTarget };
let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-toolbar-serving-"));
  const app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const made = await newApp(app, u.value, { name: "open", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  fake.app = app;
  fake.target = { app: getAppByRepo(app.db, made.value.repo.id)!, env: "production" } as AppTarget;
}, 120_000);
afterAll(async () => {
  fake.app.close();
  await rm(dir, { recursive: true, force: true });
});
