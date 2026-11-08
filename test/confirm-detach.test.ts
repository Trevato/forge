/**
 * #7978: "Detach from parent" has no undo, so the fork's danger zone links
 * it to /-/confirm, which names the fork and posts the detach on the second
 * step exactly as the button used to.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo, type Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let fork: Repo;
let cookie: string;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-confirm-detach-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const user = async (username: string) =>
    ok(await signUp(app, { username, email: `${username}@forge.test`, password: "a-long-passphrase" }));
  const owner = await user("upstreamer");
  const forker = await user("forker");
  const parent = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "up", visibility: "public" }));
  ok(
    await commitFiles(repoDir(app.reposRoot, parent.ownerName, parent.name), {
      branch: "main",
      message: "one",
      files: [{ path: "one.txt", content: "one" }],
      author: { name: "T", email: "t@forge.test" },
    }),
  );
  fork = ok(await forkRepo(app.db, app.reposRoot, parent, forker.id, "down"));
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "forker", password: "a-long-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the fork's danger zone sends Detach from parent through the confirm page", async () => {
  const base = `/${fork.ownerName}/${fork.name}`;
  const to = `${base}/settings/detach`;
  const danger = await (await fetch(`${servers.url}${base}/settings/danger`, { headers: { cookie } })).text();
  expect(danger).toContain(`href="/-/confirm?to=${encodeURIComponent(to)}"`);
  expect(danger).not.toContain(`action="${to}"`);

  const confirm = await fetch(`${servers.url}/-/confirm?to=${encodeURIComponent(to)}`, { headers: { cookie } });
  expect(confirm.status).toBe(200);
  const body = await confirm.text();
  expect(body).toContain(`Detach forker/down from its parent?`);
  expect(body).toContain("There is no undo.");
  expect(body).toContain(`action="${to}"`);
});

test("the confirm page is a heading, a sentence and a form, not a box (#9860)", async () => {
  const to = `/${fork.ownerName}/${fork.name}/settings/detach`;
  const body = await (await fetch(`${servers.url}/-/confirm?to=${encodeURIComponent(to)}`, { headers: { cookie } })).text();
  expect(body.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(body).not.toContain('class="card');
  expect(body).toMatch(new RegExp(`<form method="post" action="${to}"`));
});
