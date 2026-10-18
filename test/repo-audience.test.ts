/**
 * The repository head says who can see the repository, beside the badge: a
 * link to the settings for who can open them, plain text for everyone else,
 * and the public sentence for somebody not signed in.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRole } from "../src/actions/roles.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;

const signIn = async (username: string): Promise<string> => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};

const head = async (path: string, cookie = ""): Promise<string> => {
  const r = await fetch(`${servers.url}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  return text.match(/<header class="repo-head">[\s\S]*?<\\?\/header>/)?.[0] ?? "";
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-repo-audience-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const users = [];
  for (const [username, first] of [["hank", true], ["olive", false], ["ravi", false]] as const) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    users.push(made.value);
  }
  const promoted = setRole(app, users[0]!, "olive", "member");
  if (!promoted.ok) throw new Error(promoted.error);
  const r = await createRepo(app, users[1]!, { name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("a writer sees the sentence as a link to the settings", async () => {
  const h = await head("/olive/yard", await signIn("olive"));
  expect(h).toMatch(
    /<a class="repo-audience" href="\/olive\/yard\/settings" title="Public: anyone can read this; 1 person can change it\."\s*>Public: anyone can read this; 1 person can change it\.<\/a\s*>/,
  );
});

test("a reader sees the same sentence as plain text", async () => {
  const h = await head("/olive/yard", await signIn("ravi"));
  expect(h).toContain('<span class="repo-audience" title="Public: anyone');
  expect(h).not.toContain('href="/olive/yard/settings"');
});

test("somebody not signed in sees the public sentence", async () => {
  const h = await head("/olive/yard");
  expect(h).toContain("Public: anyone can read this; 1 person can change it.");
  expect(h).toContain('<span class="repo-audience"');
});
