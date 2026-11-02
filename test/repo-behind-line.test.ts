/** A followed repository's home says how far behind its upstream the last check found it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { noteCheck, putFollow } from "../src/core/upstream_follow.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getRepo } from "../src/core/repos.ts";
import type { Session } from "../src/tui/session.ts";
import { upstreamRows } from "../src/tui/screens/about.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;
let userId: string;
let user: User;

const home = async (name: string, withCookie = cookie) => {
  const r = await fetch(`${servers.url}/amy/${name}`, { headers: { cookie: withCookie } });
  expect(r.status).toBe(200);
  return { html: await r.text(), timing: r.headers.get("server-timing") ?? "" };
};

const repo = async (name: string, check?: { behind: number; error: string; at?: string }) => {
  const made = await createRepo(app, user, { name, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  await commitToBranch(app, user, made.value, {
    message: "first",
    files: [{ path: "a.txt", content: "a\n" }],
  });
  if (check === undefined) return;
  putFollow(app.db, {
    repoId: made.value.id,
    url: "https://github.com/trevato/forge.git",
    branch: "main",
    enabled: true,
    byId: userId,
    originId: "",
  });
  noteCheck(app.db, made.value.id, {
    at: check.at ?? new Date(Date.now() - 2 * 3600_000).toISOString(),
    behind: check.behind,
    error: check.error,
  });
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-behind-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "amy",
    email: "amy@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  user = made.value;
  userId = user.id;
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "amy", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  await repo("behind", { behind: 12, error: "" });
  await repo("level", { behind: 0, error: "" });
  await repo("conflicted", { behind: 3, error: "conflict" });
  await repo("plain");
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("behind: the count, the upstream, the age, linking to the settings", async () => {
  const { html, timing } = await home("behind");
  const line = html.match(/<div[^>]*data-behind-upstream[\s\S]*?<\/div>/)?.[0] ?? "";
  expect(line.replace(/\s+/g, " ")).toContain("12 commits behind trevato/forge");
  expect(line).toContain('href="/amy/behind/settings#upstream"');
  expect(line).toContain("checked 2h ago");
  expect(timing).toContain("behind;");
  expect(line).toContain('<form method="post" action="/amy/behind/settings/upstream/check"');
  expect(line).toContain('name="back" value="/amy/behind"');
  expect(line).toMatch(/<button[^>]*type="submit"[\s\S]*Update/);
});

test("level: no line", async () => {
  expect((await home("level")).html).not.toContain("data-behind-upstream");
});

test("conflicted: says what to do", async () => {
  const { html } = await home("conflicted");
  expect(html).toContain("conflicts with trevato/forge: resolve");
  expect(html).not.toContain("commits behind");
});

test("not a fork: no line, and a stranger sees none", async () => {
  expect((await home("plain")).html).not.toContain("data-behind-upstream");
  const r = await fetch(`${servers.url}/amy/behind`);
  expect(await r.text()).not.toContain("data-behind-upstream");
});

test("a signed-in non-admin who can read the repository sees no line and no button", async () => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(made.error);
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const bob = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  const { html } = await home("behind", bob);
  expect(html).not.toContain("data-behind-upstream");
  expect(html).not.toContain("settings/upstream/check");
});

test("Update runs the check and comes back to the home; a foreign back goes to settings", async () => {
  const post = (back: string) =>
    fetch(`${servers.url}/amy/behind/settings/upstream/check`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams({ back }),
      redirect: "manual",
    });
  expect((await post("/amy/behind")).headers.get("location")).toBe("/amy/behind");
  expect((await post("https://evil.example/")).headers.get("location")).toBe("/amy/behind/settings#upstream");
});

test("the terminal's About rows carry the same behind words, only while behind or conflicting", () => {
  const rows = (name: string) => {
    const repo = getRepo(app.db, "amy", name)!;
    // The Update test above ran a real check; put the stored one back.
    const stored = { behind: { behind: 12, error: "" }, conflicted: { behind: 3, error: "conflict" }, level: { behind: 0, error: "" } }[name]!;
    noteCheck(app.db, repo.id, { at: new Date().toISOString(), ...stored });
    const session = { db: app.db, user } as unknown as Session;
    return upstreamRows(session, repo).filter(([k]) => k === "behind");
  };
  expect(rows("behind")).toEqual([["behind", "12 commits behind trevato/forge · u updates"]]);
  expect(rows("conflicted")).toEqual([["behind", "conflicts with trevato/forge: resolve · u updates"]]);
  expect(rows("level")).toEqual([]);
});
