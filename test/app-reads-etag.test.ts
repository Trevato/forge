/** GET …/app/members and …/app/domains carry an ETag and answer a repeat with 304 (#9178). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { DomainResolver } from "../src/apps/domains.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const HOST = "app.example.com";
const MEMBERS = "/api/v1/repos/alice/notes/app/members";
const DOMAINS = "/api/v1/repos/alice/notes/app/domains";

/** A zone the test writes; anything unwritten does not exist. */
class FakeDns implements DomainResolver {
  readonly txt = new Map<string, string[][]>();
  resolveTxt(name: string): Promise<string[][]> {
    const found = this.txt.get(name);
    return found ? Promise.resolve(found) : Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
  }
  resolveCname(): Promise<string[]> {
    return Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
  }
}

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let adminTok = "";
let rwTok = "";
let bobTok = "";
const dns = new FakeDns();

const call = (method: string, path: string, tok: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${servers.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const tagOf = async (path: string) => {
  const res = await call("GET", path, adminTok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};
const moved = async (path: string, tag: string) => {
  const res = await call("GET", path, adminTok, { "if-none-match": tag });
  expect(res.status).toBe(200);
  const next = res.headers.get("etag")!;
  expect(next).not.toBe(tag);
  await res.text();
  return next;
};
const held = async (path: string, tag: string) => {
  const res = await call("GET", path, adminTok, { "if-none-match": tag });
  expect(res.status).toBe(304);
  await res.text();
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-app-etag-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
    dns,
  });
  await runtime.start();
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
  await mk("carol", false);
  const repo = await createRepo(app, alice, { name: "notes", visibility: "public", description: "" });
  if (!repo.ok) throw new Error("repo");
  const row = insertApp(app.db, { repoId: repo.value.id, slug: "notes", access: "private" });
  if (!row.ok) throw new Error(row.error);
  adminTok = createToken(app.db, alice.id, "a", "admin").token;
  rwTok = createToken(app.db, alice.id, "rw", "rw").token;
  bobTok = createToken(app.db, bob.id, "b", "admin").token;
});
afterAll(async () => {
  await runtime?.stop();
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

for (const path of [MEMBERS, DOMAINS]) {
  test(`${path}: weak tag, private no-cache, vary; a repeat is a bodiless 304 with the floor`, async () => {
    const res = await call("GET", path, adminTok);
    expect(res.status).toBe(200);
    const tag = res.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"/);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    expect(res.headers.get("content-type")).toContain("application/json");
    await res.text();
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

test("a members PUT moves the tag; a dry run does not", async () => {
  const tag = await tagOf(MEMBERS);
  const plan = await call("PUT", MEMBERS, adminTok, {}, { members: ["carol"] });
  expect(plan.status).toBe(200);
  await plan.text();
  await held(MEMBERS, tag);
  const done = await call("PUT", MEMBERS, adminTok, {}, { members: ["carol"], dryRun: false });
  expect(done.status).toBe(200);
  await done.text();
  const next = await moved(MEMBERS, tag);
  await held(MEMBERS, next);
});

test("adding, verifying and removing a domain move the domains tag", async () => {
  let tag = await tagOf(DOMAINS);
  const added = await call("POST", DOMAINS, adminTok, {}, { host: HOST });
  expect(added.status).toBe(201);
  const domain = (await added.json()) as { records: { value: string }[] };
  tag = await moved(DOMAINS, tag);
  await held(DOMAINS, tag);
  const proof = domain.records.find((r) => r.value.startsWith("forge-verify="))?.value;
  expect(proof).toBeDefined();
  dns.txt.set(`_forge-verify.${HOST}`, [[proof!]]);
  const checked = await call("POST", `${DOMAINS}/${HOST}/check`, adminTok);
  expect(checked.status).toBe(200);
  await checked.text();
  tag = await moved(DOMAINS, tag);
  const removed = await call("DELETE", `${DOMAINS}/${HOST}`, adminTok);
  expect(removed.status).toBe(200);
  await removed.text();
  await moved(DOMAINS, tag);
});

test("refusals carry no tag and never a 304, even with *", async () => {
  const cases: [string, string, number[]][] = [
    [MEMBERS, rwTok, [200]], // members reads at ro: rw is allowed, checked below
    [DOMAINS, rwTok, [403]],
    [DOMAINS, bobTok, [403, 404]],
    ["/api/v1/repos/alice/nope/app/members", adminTok, [404]],
    ["/api/v1/repos/alice/nope/app/domains", adminTok, [404]],
  ];
  for (const [path, tok, statuses] of cases) {
    const res = await call("GET", path, tok, { "if-none-match": "*" });
    if (path === MEMBERS && tok === rwTok) {
      expect(res.status).toBe(304); // the same person, after the access check
    } else {
      expect(statuses).toContain(res.status);
      expect(res.status).not.toBe(304);
      expect(res.headers.get("etag")).toBeNull();
    }
    await res.text();
  }
  const stranger = await call("GET", MEMBERS, bobTok, { "if-none-match": "*" });
  expect(stranger.status).not.toBe(304);
  expect(stranger.headers.get("etag")).toBeNull();
  await stranger.text();
  const anon = await fetch(`${servers.url}${MEMBERS}`, { headers: { "if-none-match": "*" } });
  expect([401, 404]).toContain(anon.status);
  expect(anon.headers.get("etag")).toBeNull();
  await anon.text();
});
