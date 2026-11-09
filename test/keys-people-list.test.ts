/** The people list joins the shell's j/k row traversal (#10353): one data-nav per person, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

async function signIn(username: string): Promise<string> {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!set) throw new Error(`no session: ${res.status}`);
  return set;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-people-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const username of ["alice", "bob", "carol"]) {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
  }
  cookie = await signIn("alice");
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("each person row is one data-nav row whose first link is the person's page", async () => {
  const res = await fetch(`${servers.url}/settings/people`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const text = await res.text();
  const rows = [...text.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].filter((m) => m[1]!.includes("data-nav")).map((m) => m[1]!);
  expect(rows.length).toBe(3);
  const table = text.slice(text.indexOf(`id="people"`));
  expect(table.match(/data-nav/g)!.length).toBe(3);
  const firsts = rows.map((r) => /<a href="([^"]+)" data-nav/.exec(r)![1]);
  for (const name of ["alice", "bob", "carol"]) expect(firsts).toContain(`/${name}`);
});

test("the empty page has no data-nav: nobody listed, nothing to traverse", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "forge-keys-people-empty-"));
  const fresh = createApp({ dataDir: emptyDir, port: 0 });
  const up = await serve(fresh);
  try {
    const made = await createUser(fresh.db, {
      origin: "seed", trusted: true, username: "ada", email: "ada@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const res0 = await fetch(`${up.url}/signin`, {
      method: "POST", redirect: "manual", headers: { origin: up.url },
      body: new URLSearchParams({ username: "ada", password: "a-good-passphrase" }),
    });
    const own = res0.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    // The list hides agents; an admin session outlives the flag for this one request.
    fresh.db.run("UPDATE user SET is_agent = 1 WHERE username = 'ada'");
    const res = await fetch(`${up.url}/settings/people`, { headers: { cookie: own } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("Nobody has joined yet.");
    // The settings sidebar has its own data-nav links; the people block is what follows its heading.
    const block = text.slice(text.indexOf("Guests, members and admins"));
    expect(block.length).toBeLessThan(text.length);
    expect(block).not.toContain("data-nav");
    expect(block).not.toContain(`id="people"`);
  } finally {
    await up.stop();
    await rm(emptyDir, { recursive: true, force: true });
  }
});
