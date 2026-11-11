/**
 * Settings › Danger zone speaks the home page's language (#9952): the delete
 * and the detach are each a settings-block under an h2, no card. The typed
 * name still guards the delete; the detach still shows its plan, its running
 * state with since-when, and its failure.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { detachBlock } from "../src/web/pages/detach.ts";
import { quietLogs } from "./helpers/globals.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
let fork: Repo;
let forker = "", stranger = "";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const signIn = async (username: string) => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-long-passphrase" }),
    redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-danger-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const user = async (username: string) =>
    ok(await signUp(app, { username, email: `${username}@forge.test`, password: "a-long-passphrase" }));
  const owner = await user("upstreamer");
  const down = await user("forker");
  await user("stranger");
  const parent = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "up", visibility: "public" }));
  ok(
    await commitFiles(repoDir(app.reposRoot, parent.ownerName, parent.name), {
      branch: "main",
      message: "one",
      files: [{ path: "one.txt", content: "one" }],
      author: { name: "T", email: "t@forge.test" },
    }),
  );
  fork = ok(await forkRepo(app.db, app.reposRoot, parent, down.id, "down"));
  forker = await signIn("forker");
  stranger = await signIn("stranger");
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const base = () => `/${fork.ownerName}/${fork.name}`;
const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const danger = async (cookie: string) => fetch(`${servers.url}${base()}/settings/danger`, { headers: { cookie } });

test("the danger zone is two settings-blocks under h2s, no card", async () => {
  const m = main(await (await danger(forker)).text());
  expect(m).not.toContain('class="card');
  expect(m).toMatch(/<section class="settings-block" id="detach">\s*<h2>Detach from parent<\/h2>/);
  expect(m).toMatch(/<section class="settings-block" id="delete">\s*<h2>Delete this repository<\/h2>/);
  // what goes and what survives
  expect(m).toMatch(/Forks survive; this repository does\s+not\./);
  expect(m).toContain(`href="/-/confirm?to=${encodeURIComponent(`${base()}/settings/delete`)}"`);
});

test("the detach shows its plan with its parent named", async () => {
  const m = main(await (await danger(forker)).text());
  const detach = m.slice(m.indexOf('id="detach"'), m.indexOf('id="delete"'));
  expect(detach).toContain("<strong>upstreamer/up</strong>");
  expect(detach).toContain("There is no undo.");
  expect(detach).toContain(`href="/-/confirm?to=${encodeURIComponent(`${base()}/settings/detach`)}"`);
});

test("the detach shows its running state since when, and its failure over the plan", () => {
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const done = Promise.resolve();
  const action = `${base()}/settings/detach`;
  const running = String(detachBlock({ name: "upstreamer/up", action, job: { phase: "repacking", startedAt, message: "", done } }));
  expect(running).toContain('<section class="settings-block" id="detach">');
  expect(running).toContain("data-detach-progress");
  expect(running).toContain("started 5m ago");
  expect(running).not.toContain("/-/confirm");

  const failed = String(
    detachBlock({ name: "upstreamer/up", action, job: { phase: "failed", startedAt, message: "repack died", done } }),
  );
  expect(failed).toContain("data-detach-failed");
  expect(failed).toContain("The last detach stopped: repack died.");
  expect(failed).toContain(`href="/-/confirm?to=${encodeURIComponent(action)}"`);
  expect(failed).not.toContain('class="card');
});

test("the delete refuses unless the full name is typed back", async () => {
  const res = await fetch(`${servers.url}${base()}/settings/delete`, {
    method: "POST",
    headers: { cookie: forker, origin: servers.url },
    body: new URLSearchParams({ confirm: fork.name }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`${base()}/settings/danger`);
  expect(getRepoById(app.db, fork.id)).toBeDefined();
});

test("a non-admin gets the one 404", async () => {
  expect((await danger(stranger)).status).toBe(404);
});
