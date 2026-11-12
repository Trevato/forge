/**
 * The read-only standby (#9657): a small snapshot restored by
 * `scripts/standby-restore.ts`, the restored directory booted with
 * FORGE_READ_ONLY=1, `/` answering and git reading, and every mutation a
 * plain 503. The guard is also checked as plain data over the methods.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { isRead, readOnlyFrom, readOnlyRefusal } from "../src/http/read_only.ts";
import { lostPort, onFreshPort } from "../src/kernel/port.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";

const TREE = join(import.meta.dir, "..");
let root: string;
let app: App;
let session = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-standby-"));
  app = createApp({ dataDir: join(root, "live"), port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app, u.value, { name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const c = await commitToBranch(app, u.value, repo.value, { message: "first", files: [{ path: "README.md", content: "# notes\n" }] });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const secret = await createRepo(app, u.value, { name: "diary", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  const d = await commitToBranch(app, u.value, secret.value, { message: "first", files: [{ path: "README.md", content: "# diary\n" }] });
  if (!d.ok) throw new Error(JSON.stringify(d.error));
  session = createSession(app.db, u.value.id).token;
  await takeSnapshot(
    { db: app.db, dataDir: app.config.dataDir, reposRoot: app.reposRoot, version: "t" },
    dirStore(join(root, "store")),
    new Date("2026-11-01T08:00:00Z"),
  );
});

afterAll(async () => {
  app.close();
  await rm(root, { recursive: true, force: true });
});

const run = (args: string[], env: Record<string, string>) =>
  Bun.spawn([process.execPath, ...args], {
    cwd: TREE,
    env: { PATH: process.env["PATH"] ?? "", HOME: root, ...(process.env["FORGE_TEST_SOCKET"] ? { FORGE_TEST_SOCKET: process.env["FORGE_TEST_SOCKET"] } : {}), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

test("the guard lets reads through and refuses every other method and the push door", () => {
  const req = (method: string, path: string, headers: Record<string, string> = {}) =>
    new Request(`http://forge.test${path}`, { method, headers });
  expect(isRead(req("GET", "/"))).toBe(true);
  expect(isRead(req("HEAD", "/alice/notes"))).toBe(true);
  expect(isRead(req("POST", "/alice/notes.git/git-upload-pack"))).toBe(true);
  expect(isRead(req("POST", "/alice/notes.git/git-receive-pack"))).toBe(false);
  expect(isRead(req("GET", "/alice/notes.git/info/refs?service=git-receive-pack"))).toBe(false);
  expect(isRead(req("GET", "/alice/notes.git/info/refs?service=git-upload-pack"))).toBe(true);
  expect(isRead(req("GET", "/x/shell", { upgrade: "websocket" }))).toBe(false);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(readOnlyRefusal(req(m, "/anything"))?.status).toBe(503);
  expect(readOnlyFrom({ FORGE_READ_ONLY: "1" })).toBe(true);
  expect(readOnlyFrom({})).toBe(false);
});

test("a restored snapshot boots read-only: / answers, git reads, a POST is a 503", async () => {
  const data = join(root, "standby");
  const restore = run(["scripts/standby-restore.ts", "latest", data], { FORGE_SNAPSHOT_DIR: join(root, "store") });
  const [out, code] = [await new Response(restore.stdout).text(), await restore.exited];
  expect({ code, out }).toMatchObject({ code: 0 });
  expect(out).toContain("verified");

  // Not empty now: a second restore is refused.
  const again = run(["scripts/standby-restore.ts", "latest", data], { FORGE_SNAPSHOT_DIR: join(root, "store") });
  const [refusal, againCode] = [await new Response(again.stderr).text(), await again.exited];
  expect(againCode).toBe(1);
  expect(refusal).toContain(`${data} is not empty`);

  await onFreshPort(async (port) => {
    const child = run(["src/main.ts"], { FORGE_READ_ONLY: "1", FORGE_DATA: data, PORT: String(port), FORGE_SSH_PORT: "2222" });
    let stderr = "";
    let logged = "";
    void (async () => { for await (const c of child.stderr) stderr = (stderr + new TextDecoder().decode(c)).slice(-4096); })();
    void (async () => { for await (const c of child.stdout) logged += new TextDecoder().decode(c); })();
    const base = `http://127.0.0.1:${port}`;
    try {
      const until = Date.now() + 45_000;
      let up = false;
      while (Date.now() < until && child.exitCode === null && !up) {
        up = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status === 200, () => false);
        if (!up) await Bun.sleep(200);
      }
      expect({ up, stderr: up ? "" : stderr }).toEqual({ up: true, stderr: "" });
      const home = await fetch(`${base}/`);
      expect(home.status).toBe(200);
      expect((await fetch(`${base}/alice/notes`)).status).toBe(200);
      const refs = await fetch(`${base}/alice/notes.git/info/refs?service=git-upload-pack`);
      expect(refs.status).toBe(200);
      // A real clone, through git-upload-pack.
      const clone = join(root, "clone");
      const cloned = Bun.spawn(["git", "clone", "--quiet", `${base}/alice/notes.git`, clone], { env: { PATH: process.env["PATH"] ?? "", HOME: root }, stdout: "pipe", stderr: "pipe" });
      const cloneErr = await new Response(cloned.stderr).text();
      expect({ code: await cloned.exited, cloneErr }).toEqual({ code: 0, cloneErr: "" });
      expect(await Bun.file(join(clone, "README.md")).text()).toBe("# notes\n");
      // A session of the main forge is not an identity here: the private repository stays private.
      const cookie = { cookie: `forge_session=${session}` };
      expect((await fetch(`${base}/alice/diary`, { headers: cookie, redirect: "manual" })).status).not.toBe(200);
      expect((await fetch(`${base}/alice/diary`, { redirect: "manual" })).status).not.toBe(200);
      // Only the listener started: no boot record, no timers' log lines.
      expect(logged).toContain("read-only standby");
      expect(logged).not.toMatch(/processes|apps are up|crew is|snapshot|nightly|reconcil/i);
      expect(existsSync(join(data, "boots.json"))).toBe(false);
      for (const [method, path] of [["POST", "/signin"], ["POST", "/new"], ["POST", "/alice/notes.git/git-receive-pack"], ["DELETE", "/alice/notes"]] as const) {
        const res = await fetch(`${base}${path}`, { method, headers: { origin: base }, body: method === "DELETE" ? null : "x=1" });
        expect({ path, status: res.status }).toEqual({ path, status: 503 });
        expect(await res.text()).toContain("read-only standby");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      }
      expect((await fetch(`${base}/alice/notes.git/info/refs?service=git-receive-pack`)).status).toBe(503);
      expect((await fetch(`${base}/api/v1/repos`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    } finally {
      child.kill();
      await child.exited;
    }
    return { result: undefined, portLost: lostPort(stderr) };
  });
}, 90_000);
