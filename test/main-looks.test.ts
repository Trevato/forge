import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../src/app.ts";
import { recordLook } from "../src/core/looks.ts";
import { keepAsMain, mainLook } from "../src/looks/main_looks.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mainlooks-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const db = () => {
  const d = createApp({ dataDir: dir, port: 0 }).db;
  d.run("PRAGMA foreign_keys = OFF");
  return d;
};

function take(d: ReturnType<typeof db>, env: string, page: string, kind: "phone" | "desktop", content: string) {
  const path = join("looks", "app1", env, `c-${encodeURIComponent(page)}-${kind}.png`);
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  recordLook(d, { appId: "app1", env, commitOid: "c", page, kind, path });
}

test("the second landing replaces the first; a page only the first took keeps it", () => {
  const d = db();
  take(d, "pull-1", "/", "phone", "first-home");
  take(d, "pull-1", "/about", "phone", "first-about");
  expect(keepAsMain(d, dir, "app1", "pull-1")).toBe(2);
  // the pull's folder is swept
  rmSync(join(dir, "looks"), { recursive: true, force: true });
  take(d, "pull-2", "/", "phone", "second-home");
  expect(keepAsMain(d, dir, "app1", "pull-2")).toBe(1);
  rmSync(join(dir, "looks"), { recursive: true, force: true });

  expect(readFileSync(mainLook(dir, "app1", "/", "phone")!.path, "utf8")).toBe("second-home");
  expect(readFileSync(mainLook(dir, "app1", "/about", "phone")!.path, "utf8")).toBe("first-about");
  expect(mainLook(dir, "app1", "/", "desktop")).toBeUndefined();
  expect(mainLook(dir, "app1", "/", "phone", "dark")).toBeUndefined();
  expect(mainLook(dir, "../x", "/", "phone")).toBeUndefined();
  expect(existsSync(join(dir, "main-looks"))).toBe(true);
});

// The wiring: the looks service, handed pull.merged / pull.closed.
import { newApp } from "../src/actions/apps.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createUser } from "../src/core/users.ts";
import { err } from "../src/kernel/result.ts";
import { startLooks } from "../src/looks/service.ts";

async function wired() {
  const wdir = mkdtempSync(join(tmpdir(), "mainlooks-wired-"));
  const app = createApp({ dataDir: wdir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await newApp(app, u.value, { name: "hello", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const handle = startLooks(app, {
    localUrl: "http://127.0.0.1:1",
    capture: async () => err("no capture in this test"),
  });
  const appId = made.value.app.id;
  const env = previewEnv(7);
  const path = join("looks", appId, env, "c-phone.png");
  mkdirSync(dirname(join(wdir, path)), { recursive: true });
  writeFileSync(join(wdir, path), "head-look");
  recordLook(app.db, { appId, env, commitOid: "c", kind: "phone", path });
  return { app, wdir, handle, appId, repoId: made.value.repo.id };
}

test("a pull.merged event keeps the head's look as main's, then the sweep takes the folder", async () => {
  const w = await wired();
  w.app.bus.append({ kind: "pull.merged", repoId: w.repoId, payload: { number: 7 } });
  const kept = mainLook(w.wdir, w.appId, "/", "phone");
  expect(kept).toBeDefined();
  expect(readFileSync(kept!.path, "utf8")).toBe("head-look");
  expect(existsSync(join(w.wdir, "looks", w.appId, previewEnv(7)))).toBe(false);
  await w.handle.stop();
});

test("a pull.closed event keeps nothing", async () => {
  const w = await wired();
  w.app.bus.append({ kind: "pull.closed", repoId: w.repoId, payload: { number: 7 } });
  expect(mainLook(w.wdir, w.appId, "/", "phone")).toBeUndefined();
  expect(existsSync(join(w.wdir, "looks", w.appId, previewEnv(7)))).toBe(false);
  await w.handle.stop();
});
