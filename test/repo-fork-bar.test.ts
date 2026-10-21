/**
 * The fork bar on a repository's home is drawn with the design's row, badge
 * and btn: none of `.fork-bar` in the markup, and the count link and the Fork
 * form (same action, no fields) still there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRole } from "../src/actions/roles.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
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

const page = async (path: string, cookie = ""): Promise<string> => {
  const r = await fetch(`${servers.url}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  expect(r.status).toBe(200);
  return r.text();
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fork-bar-"));
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
  const promoted2 = setRole(app, users[0]!, "ravi", "member");
  if (!promoted2.ok) throw new Error(promoted2.error);
  const r = await createRepo(app, users[1]!, { name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  await commitToBranch(app, users[1]!, r.value, {
    message: "first",
    files: [{ path: "a.txt", content: "a\n" }],
  });
  const f = await forkRepo(app, users[2]!, r.value);
  if (!f.ok) throw new Error(String(f.error));
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("a visitor who can fork sees the count link and the Fork form in the design's classes", async () => {
  const h = await page("/olive/yard", await signIn("hank"));
  expect(h).not.toContain("fork-bar");
  expect(h).toContain('href="/olive/yard/forks"');
  expect(h).toMatch(/class="badge"[^>]*>\s*1 fork\s*</);
  const form = h.match(/<form method="post" action="\/olive\/yard\/fork">[\s\S]*?<\/form>/)?.[0] ?? "";
  expect(form).toContain("Fork");
  expect(form).toContain('class="btn');
  expect(form).not.toContain("<input");
  expect(h).toContain('class="row"');
});

test("the owner sees the count but no Fork form", async () => {
  const h = await page("/olive/yard", await signIn("olive"));
  expect(h).not.toContain("fork-bar");
  expect(h).toContain('href="/olive/yard/forks"');
  expect(h).not.toContain('action="/olive/yard/fork"');
});
