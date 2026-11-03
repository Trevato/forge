/** GET …/app/notes carries a weak ETag and answers a repeat with 304 until a note arrives or is moderated (#9244). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { setMember } from "../src/core/roles.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const BASE = "/api/v1/repos/founder/notes/app/notes";
let dataDir: string, app: App, servers: Servers, runtime: AppsRuntime;
const tokens: Record<string, string> = {};

const get = (who: string, path = BASE, extra: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${tokens[who]}`, ...extra } });
const post = (who: string, path: string) =>
  fetch(`${servers.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${tokens[who]}` } });
let sends = 0;
const send = async (text: string) => {
  const host = `notes.${DOMAIN}:${servers.port}`;
  const res = await fetch(`${servers.url}/__forge/note`, {
    method: "POST",
    headers: { host, origin: `http://${host}`, "content-type": "application/json", "x-forwarded-for": `10.8.0.${++sends}` },
    body: JSON.stringify({ text, page: `http://${host}/list`, viewport: "390x844" }),
  });
  expect(res.status).toBe(201);
};
const tagOf = async (who = "founder") => {
  const r = await get(who);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("etag")!;
};
const notes = async () => (await (await get("founder")).json()) as { notes: { id: string }[] };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-app-notes-etag-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
  await runtime.start();
  const make = async (username: string, first = false): Promise<User> => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const siteAdmin = await make("siteadmin", true);
  const founder = await make("founder");
  const stranger = await make("stranger");
  setMember(app.db, founder.id, true, siteAdmin.id, new Date());
  const made = await newApp(app, founder, { name: "notes", owner: "founder", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  tokens.founder = createToken(app.db, founder.id, "rw", "rw").token;
  tokens.siteadmin = createToken(app.db, siteAdmin.id, "rw", "rw").token;
  tokens.stranger = createToken(app.db, stranger.id, "rw", "rw").token;
}, 120_000);

afterAll(async () => {
  await runtime?.stop();
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a repeat is a 304 with the same headers and no body; the tag moves with every note change", async () => {
  await send("One");
  await send("Two");
  await send("Three");
  const r = await get("founder");
  const tag = r.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(r.headers.get("cache-control")).toBe("private, no-cache");
  expect(r.headers.get("vary")).toContain("authorization, cookie");
  await r.text();
  const again = await get("founder", BASE, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");

  await send("Four");
  const afterArrival = await tagOf();
  expect(afterArrival).not.toBe(tag);
  expect((await get("founder", BASE, { "if-none-match": tag })).status).toBe(200);

  const [a, b] = (await notes()).notes;
  expect((await post("founder", `${BASE}/${a!.id}/hide`)).status).toBe(200);
  const afterHide = await tagOf();
  expect(afterHide).not.toBe(afterArrival);
  expect((await post("founder", `${BASE}/${b!.id}/ban`)).status).toBe(200);
  const afterBan = await tagOf();
  expect(afterBan).not.toBe(afterHide);
  expect((await post("founder", `${BASE}/${b!.id}/unban`)).status).toBe(200);
  expect(await tagOf()).not.toBe(afterBan);
});

test("two viewers never share a tag", async () => {
  const mine = await tagOf("founder");
  const theirs = await tagOf("siteadmin");
  expect(theirs).not.toBe(mine);
  expect((await get("siteadmin", BASE, { "if-none-match": mine })).status).toBe(200);
});

test("a refusal or a missing app carries no tag, even with If-None-Match: *", async () => {
  const star = { "if-none-match": "*" };
  const denied = await get("stranger", BASE, star);
  expect(denied.status).toBe(403);
  expect(denied.headers.get("etag")).toBeNull();
  const missing = await get("founder", "/api/v1/repos/founder/missing/app/notes", star);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});
