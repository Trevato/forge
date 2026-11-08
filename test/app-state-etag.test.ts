/** GET …/app and …/app/env carry an ETag and answer a repeat with 304 until the app or its environment moves (#9227). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const APP = "/api/v1/repos/alice/notes/app";
const ENV = `${APP}/env`;

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let adminTok = "";
let roTok = "";
let bobTok = "";
let shown: EnvStatus[] = [];

const call = (method: string, path: string, tok: string | null, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${servers.url}${path}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const tagOf = async (path: string, tok = adminTok) => {
  const res = await call("GET", path, tok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};
const status = async (path: string, tag: string) => {
  const res = await call("GET", path, adminTok, { "if-none-match": tag });
  await res.text();
  return res.status;
};
const env = (state: string, commitOid: string): EnvStatus =>
  ({ env: "production", state, commitOid, url: "http://x.test" }) as EnvStatus;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-app-state-etag-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1,
  });
  await runtime.start();
  runtime.status = () => shown;
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const repo = await createRepo(app, alice, { name: "notes", visibility: "public", description: "" });
  if (!repo.ok) throw new Error("repo");
  const row = insertApp(app.db, { repoId: repo.value.id, slug: "notes", access: "public" });
  if (!row.ok) throw new Error(row.error);
  adminTok = createToken(app.db, alice.id, "a", "admin").token;
  roTok = createToken(app.db, alice.id, "r", "ro").token;
  bobTok = createToken(app.db, bob.id, "b", "admin").token;
});
afterAll(async () => {
  await runtime?.stop();
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

for (const path of [APP, ENV]) {
  test(`${path}: weak tag, private no-cache, vary; a repeat is a bodiless 304 with the floor`, async () => {
    const res = await call("GET", path, adminTok);
    expect(res.status).toBe(200);
    const tag = res.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"/);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    expect(res.headers.get("content-type")).toContain("application/json");
    await res.json();
    const again = await call("GET", path, adminTok, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toContain("authorization, cookie");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(again.headers.get("content-security-policy")).not.toBeNull();
    expect(await again.text()).toBe("");
  });
}

test("starting, stopping and deploying a new commit each move the /app tag", async () => {
  shown = [];
  const none = await tagOf(APP);
  shown = [env("running", "a".repeat(40))];
  const started = await tagOf(APP);
  expect(started).not.toBe(none);
  expect(await status(APP, started)).toBe(304);
  expect(await status(APP, none)).toBe(200);
  shown = [env("running", "b".repeat(40))];
  const deployed = await tagOf(APP);
  expect(deployed).not.toBe(started);
  shown = [env("stopped", "b".repeat(40))];
  const stopped = await tagOf(APP);
  expect(stopped).not.toBe(deployed);
  shown = [];
  expect(await tagOf(APP)).toBe(none);
});

test("setting and removing a variable move the /env tag; the value never feeds it", async () => {
  const empty = await tagOf(ENV);
  const set = await call("PUT", `${ENV}/GREETING`, adminTok, {}, { value: "secret-one" });
  expect(set.status).toBe(200);
  await set.text();
  const added = await tagOf(ENV);
  expect(added).not.toBe(empty);
  expect(await status(ENV, added)).toBe(304);
  const again = await call("PUT", `${ENV}/GREETING`, adminTok, {}, { value: "secret-two" });
  await again.text();
  const body = await (await call("GET", ENV, adminTok)).text();
  expect(body).not.toContain("secret");
  const gone = await call("DELETE", `${ENV}/GREETING`, adminTok);
  expect(gone.status).toBe(200);
  await gone.text();
  expect(await tagOf(ENV)).toBe(empty);
});

test("a body that differs for another viewer does not share the tag", async () => {
  const mine = await tagOf(APP);
  const theirs = await tagOf(APP, bobTok);
  expect(theirs).not.toBe(mine);
  expect(await status(APP, theirs)).toBe(200);
});

test("refusals and a missing repository answer as before, with no tag, even for *", async () => {
  for (const [token, path, code] of [
    [roTok, ENV, 403],
    [bobTok, ENV, 404],
    [null, ENV, 401],
    [adminTok, "/api/v1/repos/alice/nope/app", 404],
    [adminTok, "/api/v1/repos/alice/nope/app/env", 404],
  ] as const) {
    const res = await call("GET", path, token, { "if-none-match": "*" });
    expect(res.status).toBe(code);
    expect(res.headers.get("etag")).toBeNull();
    await res.text();
  }
});
