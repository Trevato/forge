import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordScriptError } from "../src/http/script_errors.ts";
import { controlRows, scriptErrorRows, entry } from "../src/tui/screens/controls.ts";
import { CONTROLS, readControlChecks } from "../src/checks/controls.ts";

let dir = "";
let app: App;
let servers: Servers;
let admin = "";
let other = "";
const get = (cookie?: string) =>
  fetch(`${servers.url}/settings/security/controls`, { redirect: "manual", headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-controls-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const seed = { origin: "seed", trusted: true, password: "a-good-passphrase" } as const;
  const a = await createUser(app.db, { ...seed, username: "alice", email: "a@forge.local", isAdmin: true });
  const b = await createUser(app.db, { ...seed, username: "bob", email: "b@forge.local" });
  if (!a.ok || !b.ok) throw new Error("no users");
  admin = `forge_session=${createSession(app.db, a.value.id).token}`;
  other = `forge_session=${createSession(app.db, b.value.id).token}`;
});
afterAll(async () => {
  servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("an admin sees every control; with no report each says no check recorded", async () => {
  const res = await get(admin);
  expect(res.status).toBe(200);
  const text = await res.text();
  for (const c of CONTROLS) expect(text).toContain(c.name);
  expect(text.match(/No check recorded/g)?.length).toBe(CONTROLS.length);
});

test("the page is an admin's", async () => {
  expect((await get()).status).toBe(303);
  expect((await get(other)).status).toBe(404);
});

test("a recorded check shows its time; a failed one says failed; junk is ignored", async () => {
  const at = new Date().toISOString();
  await writeFile(
    join(dir, "security-report.json"),
    JSON.stringify({
      controls: [
        { id: "app-env", at, ok: true },
        { id: "edge-secret", at, ok: false },
        { id: "nope", at, ok: true },
        { id: "crew-sandbox", at: "garbage", ok: true },
      ],
    }),
  );
  const m = readControlChecks(dir);
  expect([...m.keys()].sort()).toEqual(["app-env", "edge-secret"]);
  const text = await (await get(admin)).text();
  expect(text).toContain("Failed");
  expect(text.match(/No check recorded/g)?.length).toBe(CONTROLS.length - 2);
});

test("a check older than 8 days says out of date; one inside 8 days does not", async () => {
  const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await writeFile(join(dir, "security-report.json"), JSON.stringify({ controls: [{ id: "app-env", at: old, ok: true }] }));
  expect(await (await get(admin)).text()).toContain("Out of date");
  await writeFile(join(dir, "security-report.json"), JSON.stringify({ controls: [{ id: "app-env", at: fresh, ok: true }] }));
  expect(await (await get(admin)).text()).not.toContain("Out of date");
});

test("without a controls list the report's own time covers the tested controls, not pod security", async () => {
  const at = new Date().toISOString();
  await writeFile(
    join(dir, "security-report.json"),
    JSON.stringify({ at, secretScan: { findings: 0 }, selfTest: { passed: 3, failed: 0 } }),
  );
  const text = await (await get(admin)).text();
  expect(text.match(/No check recorded/g)?.length).toBe(1);
  expect(text).not.toContain("Failed");
  await writeFile(
    join(dir, "security-report.json"),
    JSON.stringify({ at, secretScan: { findings: 0 }, selfTest: { passed: 2, failed: 1 } }),
  );
  expect(await (await get(admin)).text()).toContain("Failed");
});

test("the security page links to the controls", async () => {
  const res = await fetch(`${servers.url}/settings/security`, { headers: { cookie: admin } });
  expect(await res.text()).toContain('href="/settings/security/controls"');
});

test("the terminal rows match the page", () => {
  const rows = controlRows(dir, Date.now());
  expect(rows.map((r) => r.title)).toEqual(CONTROLS.map((c) => c.name));
  expect(rows.find((r) => r.title === "Pod security")?.meta).toBe("No check recorded");
});

test("the terminal lists script errors, for an admin only", () => {
  expect(scriptErrorRows(app.db, Date.now())).toEqual([]);
  recordScriptError(app.db, { page: "/", src: "/a.js", line: 3, msg: "boom" });
  const rows = scriptErrorRows(app.db, Date.now());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ title: "Script error on /: boom", secondary: "/a.js:3", meta: "1 in 7 days" });
  const as = (isAdmin: boolean, kind = "human") => entry.offered({ user: { isAdmin, kind } } as never);
  expect(as(true)).toBe(true);
  expect(as(false)).toBe(false);
  expect(as(true, "agent")).toBe(false);
});
