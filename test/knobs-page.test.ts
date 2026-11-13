/** The knobs card on the crew page (#10461): five rows, edited in place by a same-origin POST. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { capacityValue } from "../src/core/capacity.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-knobs-page-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (origin: string, body: Record<string, string>) =>
  fetch(`${servers.url}/settings/crew/knobs`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(body),
  });

test("the crew page shows the knobs, and a same-origin post turns one", async () => {
  const res = await fetch(`${servers.url}/settings/crew`, { headers: { authorization: `Bearer ${bearer}` } });
  const body = await res.text();
  for (const id of ["speed", "budget", "polish", "feedback"]) expect(body).toContain(`data-knob="${id}"`);
  expect(body).toContain("nothing from a person waiting");
  const done = await post(servers.url, { knob: "speed", value: "3", repo: "" });
  expect(done.status).toBe(303);
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
});

test("a post to Reserve is refused with the plain line and stores nothing", async () => {
  const res = await post(servers.url, { knob: "reserve", value: "20", repo: "" });
  expect(res.status).toBe(303);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await fetch(`${servers.url}/settings/crew`, { headers: { authorization: `Bearer ${bearer}`, cookie } });
  const body = (await page.text()).replaceAll("&#39;", "'");
  expect(body).toContain("That dial follows Weekly budget: turn Weekly budget and it moves.");
  expect(body).toContain('data-derived="reserve"');
  expect(capacityValue(app.db, "week.use")).toBe("90");
});

test("another origin changes nothing", async () => {
  await post("https://evil.example", { knob: "speed", value: "5", repo: "" });
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
});

test("a guest post is sent to sign in and changes nothing", async () => {
  const res = await fetch(`${servers.url}/settings/crew/knobs`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ knob: "speed", value: "6", repo: "" }),
  });
  expect(res.status).not.toBe(200);
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
});

test("a member who is not an admin is refused and changes nothing", async () => {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "correct-horse-battery" });
  if (!made.ok) throw new Error(made.error);
  const token = createToken(app.db, made.value.id, "t", "rw").token;
  const res = await fetch(`${servers.url}/settings/crew/knobs`, {
    method: "POST",
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ knob: "speed", value: "6", repo: "" }),
  });
  expect(res.status).toBe(403);
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
});

test("an out-of-range value, an unknown knob and a removed dial change nothing", async () => {
  for (const body of [
    { knob: "speed", value: "99", repo: "" },
    { knob: "speed", value: "abc", repo: "" },
    { knob: "budget", value: "5", repo: "" },
    { knob: "polish", value: "70", repo: "" },
    { knob: "queue.depth", value: "4", repo: "" },
  ]) {
    const res = await post(servers.url, body);
    expect([303, 404]).toContain(res.status);
  }
  expect(capacityValue(app.db, "crew.concurrency")).toBe("3");
  expect(capacityValue(app.db, "week.use")).toBe("90");
  expect(capacityValue(app.db, "queue.depth")).toBe("2");
});

test("Autonomy and Polish share turn from the page", async () => {
  const made = await createRepo(app, (await listAdmin())!, { name: "site", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  expect((await post(servers.url, { knob: "autonomy", value: "ask", repo: "alice/site" })).status).toBe(303);
  expect(getRepoById(app.db, made.value.id)!.autonomy).toBe("autonomous");
  expect((await post(servers.url, { knob: "polish", value: "20", repo: "" })).status).toBe(303);
  expect(getRepoById(app.db, made.value.id)!.polishShare).toBe(20);
  const page = await (await fetch(`${servers.url}/settings/crew`, { headers: { authorization: `Bearer ${bearer}` } })).text();
  expect(page).toContain('data-knob="autonomy"');
  expect(page).toContain('data-variant="ghost"');
});

async function listAdmin() {
  return getUserByName(app.db, "alice");
}
