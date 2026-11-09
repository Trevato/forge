/** Settings › Webhooks pauses and resumes a hook with one button (#10103). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook, getWebhook } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let repoId = "";
let hook = "";
let admin = "";
let reader = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-web-hook-pause-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const repo = await createRepo(app, alice, { name: "a", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  repoId = repo.value.id;
  const made = createWebhook(app.db, { repoId, url: "https://a.example/h" });
  if (!made.ok) throw new Error("hook");
  hook = made.value.webhook.id;
  admin = `forge_session=${createSession(app.db, alice.id).token}`;
  reader = `forge_session=${createSession(app.db, bob.id).token}`;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const page = (cookie: string) => fetch(`${servers.url}/alice/a/settings/hooks`, { headers: { cookie } });
const post = (verb: "pause" | "resume", cookie: string, origin = servers.url) =>
  fetch(`${servers.url}/alice/a/settings/hooks/${hook}/${verb}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin },
  });
const active = () => getWebhook(app.db, repoId, hook)!.active;
const events = (kind: string) =>
  app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM event WHERE kind = ?1").get(kind)!.n;

test("an active hook's row offers Pause; posting it pauses the hook and the row reads paused with Resume", async () => {
  const before = await (await page(admin)).text();
  expect(before).toContain(`action="/alice/a/settings/hooks/${hook}/pause"`);
  expect(before).toMatch(/<button[^>]*>\s*Pause\s*<\/button>/);
  expect(before).toContain("No deliveries yet.");
  expect(before).not.toContain(`/settings/hooks/${hook}/resume"`);

  const res = await post("pause", admin);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/alice/a/settings/hooks");
  expect(active()).toBeFalsy();
  expect(events("webhook.paused")).toBe(1);

  const after = await (await page(admin)).text();
  expect(after).toContain(`action="/alice/a/settings/hooks/${hook}/resume"`);
  expect(after).toMatch(/<button[^>]*>\s*Resume\s*<\/button>/);
  expect(after).toContain("paused");
  expect(after).not.toContain("No deliveries yet.");
  expect(after).not.toContain(`/settings/hooks/${hook}/pause"`);
});

test("Resume makes it active again and the row offers Pause once more", async () => {
  const res = await post("resume", admin);
  expect(res.status).toBe(303);
  expect(active()).toBeTruthy();
  expect(events("webhook.resumed")).toBe(1);
  const html = await (await page(admin)).text();
  expect(html).toContain(`action="/alice/a/settings/hooks/${hook}/pause"`);
});

test("a reader neither sees the page nor can post it: 404, and the hook is untouched", async () => {
  expect((await page(reader)).status).toBe(404);
  expect((await post("pause", reader)).status).toBe(404);
  expect((await post("pause", "")).status).toBe(404);
  expect(active()).toBeTruthy();
});

test("a cross-site post is refused and a missing hook is a message", async () => {
  expect((await post("pause", admin, "https://evil.example")).status).toBe(403);
  expect(active()).toBeTruthy();
  const missing = await fetch(`${servers.url}/alice/a/settings/hooks/nope/pause`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: admin, origin: servers.url },
  });
  expect(missing.status).toBe(303);
  expect(events("webhook.paused")).toBe(1);
});
