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
let olive: Parameters<typeof createRepo>[1];

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
  olive = users[1]!;
  const r = await createRepo(app, users[1]!, { name: "yard", visibility: "public", description: "Where the mowers sleep" });
  if (!r.ok) throw new Error(String(r.error));
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("a writer sees the sentence as a link to the settings", async () => {
  const h = await head("/olive/yard", await signIn("olive"));
  expect(h).toMatch(
    /<a href="\/olive\/yard\/settings"\s*>Public: anyone can read this; 1 person can change it\.<\/a\s*>/,
  );
});

test("a reader sees the same sentence as plain text", async () => {
  const h = await head("/olive/yard", await signIn("ravi"));
  expect(h).toContain("Public: anyone can read this; 1 person can change it.");
  expect(h).not.toContain('href="/olive/yard/settings"');
});

test("somebody not signed in sees the public sentence", async () => {
  const h = await head("/olive/yard");
  expect(h).toContain("Public: anyone can read this; 1 person can change it.");
  expect(h).not.toContain("repo-audience");
});

test("the title badges only what is not the default: Private; Public is the audience line's sentence alone (#8719)", async () => {
  const cookie = await signIn("olive");
  const made = await createRepo(app, olive, { name: "vault", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const priv = await head("/olive/vault", cookie);
  expect(priv.match(/class="badge"/g)?.length).toBe(1);
  expect(priv).toContain(">Private</span");
  const pub = await head("/olive/yard", cookie);
  expect(pub.match(/class="badge"/g)?.length ?? 0).toBe(0);
  expect(pub).not.toContain(">Public</span");
  expect(pub).toContain("Public: anyone can read this");
});

test("the head draws the owner, separator and description with shared classes", async () => {
  const h = await head("/olive/yard");
  expect(h).toContain('<a class="muted" href="/olive">olive</a>');
  expect(h).toContain('<span class="sep">/</span');
  expect(h).toContain('<p class="muted small">Where the mowers sleep</p>');
  expect(h).not.toContain('class="owner"');
  expect(h).not.toContain('class="slash"');
});
