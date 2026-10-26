/** The toolbar page's link to the app's other side (#6288). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { getAppByRepo, updateApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let envs: EnvStatus[] = [];
const pulls: number[] = [];
const cookies: Record<string, string> = {};

const env = (name: string, state: EnvStatus["state"] = "running"): EnvStatus =>
  ({ env: name, state, commitOid: "a".repeat(40), url: `http://${name}.apps.test` }) as EnvStatus;

async function signIn(username: string): Promise<string> {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST", headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }), redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-toolbar-side-"));
  app = createApp({ dataDir: root, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
  await runtime.start();
  runtime.status = () => envs;
  const users = [];
  for (const [username, first] of [["alice", true], ["carol", false]] as const) {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    users.push(u.value);
  }
  proveAll(app);
  for (const [name, visibility] of [["pub", "public"], ["priv", "private"]] as const) {
    const made = await newApp(app, users[0]!, { name, description: "x", visibility });
    if (!made.ok) throw new Error(String(made.error));
  }
  for (const n of [1, 2]) {
    const repo = getRepo(app.db, "alice", "pub")!;
    // Pull numbers come from the issue counter; the open "pulls" below are enough for titles.
    const made = createIssue(app.db, { repoId: repo.id, authorId: users[0]!.id, title: `Change ${n}`, kind: "pull" });
    if (!made.ok) throw new Error(made.error);
    pulls.push(made.value.number);
  }
  cookies.alice = await signIn("alice");
  cookies.carol = await signIn("carol");
}, 60_000);
afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const toolbar = async (repo: string, query: string, who?: string) => {
  const res = await fetch(`${servers.url}/alice/${repo}/toolbar?${query}`, { headers: who ? { cookie: cookies[who]! } : {} });
  return { res, text: await res.text() };
};
const hrefOf = (text: string, label: string): string | undefined =>
  new RegExp(`<a[^>]*href="([^"]*)"[^>]*>\\s*(?:<[^>]*>\\s*)*${label}`).exec(text)?.[1]?.replaceAll("&amp;", "&");

test("a reader on a preview is offered production, at this page's path", async () => {
  envs = [env("production"), env(`pull-${pulls[0]}`)];
  const page = encodeURIComponent(`http://pull-${pulls[0]}.apps.test/a/b?token=1`);
  const { text } = await toolbar("pub", `env=pull-${pulls[0]}&page=${page}`, "carol");
  expect(hrefOf(text, "Open on production")).toBe(`${runtime.urlFor(getAppRecord(), "production")}/a/b`);
});

test("a reader on production is offered the newest open preview", async () => {
  envs = [env("production"), env(`pull-${pulls[0]}`), env(`pull-${pulls[1]}`), env("pull-999", "failed")];
  const { text } = await toolbar("pub", "env=production", undefined);
  const label = /Newest preview: #(\d+) Change \d/.exec(text);
  expect(label).not.toBeNull();
  expect(label![1]).toBe(String(pulls[1]));
  expect(hrefOf(text, `Newest preview: #${pulls[1]}`)).toBe(`http://pull-${pulls[1]}.apps.test/`);
});

test("production with no open preview has no link", async () => {
  envs = [env("production")];
  expect((await toolbar("pub", "env=production", "carol")).text).not.toContain("Newest preview");
});

test("a public repository's private app shows a stranger no link, and a writer the link", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const made = await newApp(app, alice, { name: "gated", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  updateApp(app.db, made.value.app.id, { access: "private" });
  const repo = getRepo(app.db, "alice", "gated")!;
  const pull = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "Secret change", kind: "pull" });
  if (!pull.ok) throw new Error(pull.error);
  const n = pull.value.number;
  envs = [env("production"), env(`pull-${n}`)];
  for (const who of [undefined, "carol"]) {
    const onProduction = await toolbar("gated", "env=production", who);
    expect(onProduction.res.status).toBe(200);
    expect(onProduction.text).not.toContain("Newest preview");
    const onPreview = await toolbar("gated", `env=pull-${n}`, who);
    expect(onPreview.res.status).toBe(200);
    expect(onPreview.text).not.toContain("Open on production");
  }
  expect((await toolbar("gated", "env=production", "alice")).text).toContain(`Newest preview: #${n} Secret change`);
  expect((await toolbar("gated", `env=pull-${n}`, "alice")).text).toContain("Open on production");
});

test("a // page path stays on the app", async () => {
  envs = [env("production"), env(`pull-${pulls[0]}`)];
  const page = encodeURIComponent(`http://pull-${pulls[0]}.apps.test//evil.test/x`);
  const { text } = await toolbar("pub", `env=pull-${pulls[0]}&page=${page}`, "carol");
  expect(hrefOf(text, "Open on production")).toBe(`${runtime.urlFor(getAppRecord(), "production")}//evil.test/x`);
});

test("the read is named side in Server-Timing", async () => {
  envs = [env("production")];
  const { res } = await toolbar("pub", "env=production", "carol");
  expect(res.headers.get("server-timing")).toContain("side");
});

function getAppRecord() {
  return getAppByRepo(app.db, getRepo(app.db, "alice", "pub")!.id)!;
}
