/** `/__forge/` on an app's host: the forge's own small page, no script (#3308). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser, getUserById } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let record: AppRecord;
let alice: string;
let pull: number;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-door-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: DOMAIN,
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  await runtime.start();
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value.id;
  const made = await newApp(app, u.value, {
    name: "notes",
    description: "x",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  record = getAppByRepo(app.db, made.value.repo.id)!;
  const p = createIssue(app.db, {
    repoId: made.value.repo.id,
    authorId: alice,
    title: "<b>t</b>",
    kind: "pull",
  });
  if (!p.ok) throw new Error(p.error);
  pull = p.value.number;
}, 120_000);

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const door = (host: string, cookie?: string) =>
  fetch(`${servers.url}/__forge/`, {
    headers: { host, ...(cookie === undefined ? {} : { cookie }) },
  });

test("production: the app, where you are, Home and the repository; no script", async () => {
  const res = await door(`notes.${DOMAIN}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await res.text();
  expect(html).toContain("<h1>notes</h1>");
  expect(html).toContain("<p>production</p>");
  expect(html).toContain(`href="${servers.url}"`);
  expect(html).toContain(`href="${servers.url}/alice/notes"`);
  expect(html).toContain('href="/__forge/signin"');
  expect(html).not.toContain("<script");
});

test("a preview says the pull, and a signed-in director gets the tell link", async () => {
  const target = { app: record, env: `pull-${pull}` } as AppTarget;
  const grant = signGrant(dataDir, target, 60_000, Date.now(), {
    id: alice,
    name: "alice",
    role: "admin",
  });
  const html = await (
    await door(`notes--${pull}.${DOMAIN}`, `forge_grant_${record.id.slice(-8)}=${grant}`)
  ).text();
  expect(html).toContain(`<p>preview of pull #${pull}</p>`);
  expect(html).toContain(`href="${servers.url}/alice/notes/tell"`);
  expect(html).toContain(">Tell the crew<");
  expect(html).not.toContain("<b>t</b>");
});

test("a nested host is the guest's: not found", async () => {
  const res = await door(`other--notes.${DOMAIN}`);
  expect(res.status).toBe(404);
});

test("a private repository is linked only to who may read it", async () => {
  const owner = getUserById(app.db, alice)!;
  const made = await newApp(app, owner, {
    name: "vault",
    description: "x",
    visibility: "private",
  });
  if (!made.ok) throw new Error(String(made.error));
  const vault = getAppByRepo(app.db, made.value.repo.id)!;
  const b = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  const target = { app: vault, env: "production" } as AppTarget;
  const cookie = `forge_grant_${vault.id.slice(-8)}`;
  const as = (id: string, name: string, role: "admin" | "user") =>
    `${cookie}=${signGrant(dataDir, target, 60_000, Date.now(), { id, name, role })}`;
  const host = `vault.${DOMAIN}`;

  for (const cookies of [undefined, as(b.value.id, "bob", "user")]) {
    const html = await (await door(host, cookies)).text();
    expect(html).toContain("<h1>vault</h1>");
    expect(html).not.toContain("alice/vault");
    expect(html).not.toContain("The repository");
  }
  const mine = await (await door(host, as(alice, "alice", "admin"))).text();
  expect(mine).toContain(`href="${servers.url}/alice/vault"`);
  expect(mine).toContain("alice/vault");
});

test("HEAD answers the headers with no body; POST is a 405 that says what is allowed", async () => {
  const get = await door(`notes.${DOMAIN}`);
  const head = await fetch(`${servers.url}/__forge/`, {
    method: "HEAD",
    headers: { host: `notes.${DOMAIN}` },
  });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  for (const h of ["content-type", "content-security-policy", "cache-control"])
    expect(head.headers.get(h)).toBe(get.headers.get(h));
  const post = await fetch(`${servers.url}/__forge/`, {
    method: "POST",
    headers: { host: `notes.${DOMAIN}` },
  });
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
  expect(post.headers.get("x-content-type-options")).toBe("nosniff");
});

const phasesOf = async (host: string, path: string, cookie?: string) => {
  let header = "";
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${servers.url}${path}`, {
      headers: { host, ...(cookie === undefined ? {} : { cookie }) },
    });
    expect(res.status).toBe(200);
    await res.text();
    header = res.headers.get("server-timing") ?? "";
  }
  return new Map(
    header.split(", ").map((p) => {
      const [name, dur] = p.split(";dur=");
      return [name!, Number(dur)] as const;
    }),
  );
};

test("the door and the crew line name the phases they read, signed in, on production and a preview", async () => {
  const who = { id: alice, name: "alice", role: "admin" } as const;
  const name = `forge_grant_${record.id.slice(-8)}`;
  const grantFor = (env: string) =>
    `${name}=${signGrant(dataDir, { app: record, env } as AppTarget, 60_000, Date.now(), who)}`;
  const hosts: [string, string][] = [
    [`notes.${DOMAIN}`, grantFor("production")],
    [`notes--${pull}.${DOMAIN}`, grantFor(`pull-${pull}`)],
  ];
  const reads: Record<string, string[]> = {
    "/__forge/": ["session", "app", "pull", "render"],
    "/__forge/crew": ["session", "app", "pull", "working", "render"],
  };
  for (const [host, cookie] of hosts)
    for (const [path, names] of Object.entries(reads)) {
      const phases = await phasesOf(host, path, cookie);
      expect([...phases.keys()].sort()).toEqual([...names].sort());
      for (const ms of phases.values()) expect(Number.isFinite(ms)).toBe(true);
    }
});

test("a guest names session and render, and the crew line stops before the reads it never makes", async () => {
  for (const host of [`notes.${DOMAIN}`, `notes--${pull}.${DOMAIN}`]) {
    // No cookie: the crew line has no viewer, so no app, pull or working read.
    const crew = await phasesOf(host, "/__forge/crew");
    expect([...crew.keys()].sort()).toEqual(["render", "session"]);
    for (const ms of crew.values()) expect(Number.isFinite(ms)).toBe(true);
    // The door still looks the app and pull up for its words.
    const page = await phasesOf(host, "/__forge/");
    expect([...page.keys()].sort()).toEqual(["app", "pull", "render", "session"]);
  }
});
