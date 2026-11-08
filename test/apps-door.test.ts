/** `/__forge/` on an app's host: the forge's own small page, no script (#3308). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { doorPage } from "../src/apps/door.ts";
import type { PillWhere } from "../src/apps/toolbar.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { setSealed } from "../src/core/sealed.ts";
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
  expect(html).toContain(`preview of <a href="${servers.url}/alice/notes/pulls/${pull}">pull #${pull}</a>`);
  expect(html).toContain(`href="${servers.url}/alice/notes/tell"`);
  expect(html).toContain(">Tell the crew<");
  expect(html).not.toContain("<b>t</b>");
});

test("a preview links the pull and shows its escaped title to a reader; a private repo shows neither", async () => {
  const html = await (await door(`notes--${pull}.${DOMAIN}`)).text();
  expect(html).toContain(
    `<a href="${servers.url}/alice/notes/pulls/${pull}">pull #${pull}</a>: &lt;b&gt;t&lt;/b&gt;`,
  );
  const owner = getUserById(app.db, alice)!;
  const made = await newApp(app, owner, { name: "hush", description: "x", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const hush = getAppByRepo(app.db, made.value.repo.id)!;
  const p = createIssue(app.db, {
    repoId: made.value.repo.id,
    authorId: alice,
    title: "secret plan",
    kind: "pull",
  });
  if (!p.ok) throw new Error(p.error);
  const n = p.value.number;
  const target = { app: hush, env: `pull-${n}` } as AppTarget;
  const grant = signGrant(dataDir, target, 60_000, Date.now(), {
    id: alice,
    name: "alice",
    role: "admin",
  });
  const mine = await (
    await door(`hush--${n}.${DOMAIN}`, `forge_grant_${hush.id.slice(-8)}=${grant}`)
  ).text();
  expect(mine).toContain("secret plan");
  // Same facts without the reader's rights: number only.
  const bare = doorPage(
    { where: { app: "hush", env: `pull-${n}`, pull: n }, forgeUrl: servers.url },
    false,
  );
  const text = await bare.text();
  expect(text).toContain(`<p>preview of pull #${n}</p>`);
  expect(text).not.toContain("<a href=\"" + servers.url + "/alice/hush/pulls");
  expect(text).not.toContain("secret plan");
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
  const secret = createIssue(app.db, {
    repoId: vault.repoId,
    authorId: alice,
    title: "secret plan",
    kind: "pull",
  });
  if (!secret.ok) throw new Error(secret.error);
  app.db
    .query(
      "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'h', 'b', 'x')",
    )
    .run(secret.value.id);
  // The newest run is the one the door words; the runtime's own preview
  // deploy of this head races to fail, so pin a running one that sorts last.
  app.db
    .query(
      "INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES ('zzzz-pinned', ?, 'check', ?, 'x', 'running')",
    )
    .run(vault.repoId, secret.value.id);
  const target = { app: vault, env: "production" } as AppTarget;
  const cookie = `forge_grant_${vault.id.slice(-8)}`;
  const as = (id: string, name: string, role: "admin" | "user") =>
    `${cookie}=${signGrant(dataDir, target, 60_000, Date.now(), { id, name, role })}`;
  const host = `vault.${DOMAIN}`;

  // Not here to a stranger: the very answer a name nobody holds gets.
  const unknown = await door(`nothing.${DOMAIN}`);
  const unknownBody = await unknown.text();
  expect(unknown.status).toBe(404);
  for (const cookies of [undefined, as(b.value.id, "bob", "user")]) {
    const res = await door(host, cookies);
    const body = await res.text();
    expect(res.status).toBe(unknown.status);
    expect(body).toBe(unknownBody);
    expect(body).not.toContain("vault");
    expect(body).not.toContain("secret plan");
    expect([...res.headers].filter(([k]) => k !== "date")).toEqual(
      [...unknown.headers].filter(([k]) => k !== "date"),
    );
    const post = await fetch(`${servers.url}/__forge/`, { method: "POST", headers: { host } });
    expect(post.status).toBe(404);
  }
  const mine = await (await door(host, as(alice, "alice", "admin"))).text();
  expect(mine).toContain(`href="${servers.url}/alice/vault"`);
  expect(mine).toContain("alice/vault");
  // Which word depends on whether the runtime has started this pull's preview
  // yet, a race the test does not own; the check word has its own test below.
  expect(mine).toMatch(/>#\d+ secret plan · check (none|running|green|red)</);
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

test("the terminal: a writer sees the exact command, a reader and a visitor see nothing", async () => {
  const cfg = app.config as { sshPort?: number | undefined };
  const was = cfg.sshPort;
  const b = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "carol",
    email: "carol@forge.local",
    password: "a-good-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  const cookieFor = (env: string, id: string, name: string, role: "admin" | "user") =>
    `forge_grant_${record.id.slice(-8)}=${signGrant(dataDir, { app: record, env } as AppTarget, 60_000, Date.now(), { id, name, role })}`;
  try {
    cfg.sshPort = 2222;
    const prod = await (
      await door(`notes.${DOMAIN}`, cookieFor("production", alice, "alice", "admin"))
    ).text();
    expect(prod).toContain("<code>ssh -p 2222 notes@forge.test</code>");
    const prev = await (
      await door(`notes--${pull}.${DOMAIN}`, cookieFor(`pull-${pull}`, alice, "alice", "admin"))
    ).text();
    expect(prev).toContain(`<code>ssh -p 2222 notes--${pull}@forge.test</code>`);
    for (const cookie of [undefined, cookieFor("production", b.value.id, "carol", "user")]) {
      const html = await (await door(`notes.${DOMAIN}`, cookie)).text();
      expect(html).not.toContain("ssh");
      expect(html).not.toContain("terminal is off");
    }
    cfg.sshPort = undefined;
    const off = await (
      await door(`notes.${DOMAIN}`, cookieFor("production", alice, "alice", "admin"))
    ).text();
    expect(off).toContain("The terminal is off.");
    expect(off).not.toContain("ssh");
  } finally {
    cfg.sshPort = was;
  }
});

test("every name the door draws is escaped, for production and a preview", () => {
  const evil = `<script>alert("x")</script>'`;
  const out = (where: PillWhere) =>
    doorPage({ where, forgeUrl: "http://forge.test", signin: "/s" }, false).text();
  return Promise.all([
    out({ app: evil, env: "production", repo: evil }),
    out({ app: evil, env: `pull-${evil}`, repo: evil, pull: evil as unknown as number }),
  ]).then((pages) => {
    for (const html of pages) {
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;");
    }
  });
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
    "/__forge/": ["session", "app", "pull", "serving", "pulls", "working", "render"],
    "/__forge/crew": ["session", "app", "pull", "working", "side", "render"],
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
    expect([...page.keys()].sort()).toEqual(["app", "pull", "pulls", "render", "serving", "session"]);
  }
});

test("the door lists open pulls with their check word: a preview link when it is up or asleep, the forge's page otherwise, titles escaped", async () => {
  const repoId = record.repoId;
  const addPull = (n: number, head: string) => {
    const id = (
      app.db.query("SELECT id FROM issue WHERE repo_id = ? AND number = ?").get(repoId, n) as {
        id: string;
      }
    ).id;
    app.db
      .query(
        "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', ?)",
      )
      .run(id, `h${n}`, head);
    return id;
  };
  const sleeping = addPull(pull, "head1");
  app.db
    .query(
      "INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, 'head1', 'ok')",
    )
    .run(crypto.randomUUID(), repoId, sleeping);
  const cold = createIssue(app.db, {
    repoId,
    authorId: alice,
    title: "cold <i>one</i>",
    kind: "pull",
  });
  if (!cold.ok) throw new Error(cold.error);
  addPull(cold.value.number, "head2");
  (runtime as unknown as { envs: Map<string, unknown> }).envs.set(
    `${record.id}/pull-${pull}`,
    {
      app: record,
      env: `pull-${pull}`,
      chain: Promise.resolve(),
      restarts: [],
      asleep: { commitOid: "head1", runId: "r", since: new Date().toISOString() },
    },
  );
  const html = await (await door(`notes.${DOMAIN}`)).text();
  const live = runtime.urlFor(record, `pull-${pull}`);
  expect(html).toContain(
    `<a href="${live}">#${pull} &lt;b&gt;t&lt;/b&gt; · check green</a>`,
  );
  expect(html).toContain(
    `<a href="${servers.url}/alice/notes/pulls/${cold.value.number}">#${cold.value.number} cold &lt;i&gt;one&lt;/i&gt; · check none</a>`,
  );
  expect(html).not.toContain("<b>t</b>");
  expect(html).not.toContain("<i>");
});

test("the door links a dormant preview to itself, and says so when more than five pulls are open", async () => {
  const repoId = record.repoId;
  const mk = (title: string) => {
    const r = createIssue(app.db, { repoId, authorId: alice, title, kind: "pull" });
    if (!r.ok) throw new Error(r.error);
    const id = (
      app.db.query("SELECT id FROM issue WHERE repo_id = ? AND number = ?").get(repoId, r.value.number) as {
        id: string;
      }
    ).id;
    app.db
      .query(
        "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', 'h')",
      )
      .run(id, `d${r.value.number}`);
    return r.value.number;
  };
  const dormant = mk("quiet one");
  (runtime as unknown as { envs: Map<string, unknown> }).envs.set(
    `${record.id}/pull-${dormant}`,
    {
      app: record,
      env: `pull-${dormant}`,
      chain: Promise.resolve(),
      restarts: [],
      dormant: { since: new Date().toISOString(), idleSince: new Date().toISOString(), commitOid: "h" },
    },
  );
  let html = await (await door(`notes.${DOMAIN}`)).text();
  expect(html).toContain(`<a href="${runtime.urlFor(record, `pull-${dormant}`)}">#${dormant} quiet one`);
  expect(html).not.toContain("More pulls are open");
  for (let i = 0; i < 5; i++) mk(`extra ${i}`);
  html = await (await door(`notes.${DOMAIN}`)).text();
  expect(html).toContain("More pulls are open on the forge.");
  expect((html.match(/ · check /g) ?? []).length).toBe(5);
});

test("a preview links What changed for a reader only, never on production or for a guest", async () => {
  const forgeUrl = "http://forge.test";
  const text = (where: PillWhere) => doorPage({ where, forgeUrl }, false).text();
  const reader = await text({ app: "notes", env: "pull-7", pull: 7, repo: "alice/notes" });
  expect(reader).toContain('<li><a href="http://forge.test/alice/notes/pulls/7/files">What changed</a></li>');
  expect(reader.indexOf("The repository")).toBeLessThan(reader.indexOf("What changed"));
  expect(reader.indexOf("What changed")).toBeLessThan(reader.indexOf("Make it yours"));
  expect(await text({ app: "notes", env: "pull-7", pull: 7 })).not.toContain("What changed");
  expect(await text({ app: "notes", env: "production", repo: "alice/notes" })).not.toContain("What changed");
});

test("a preview's door links the live app and marks its own pull; production's has neither", async () => {
  const live = runtime.urlFor(record, "production");
  const preview = doorPage(
    {
      where: { app: "notes", env: "pull-7", pull: 7, repo: "alice/notes" },
      forgeUrl: "http://forge.test",
      live,
      pulls: [
        { number: 7, title: "mine", check: "none", href: "http://x/7", self: true },
        { number: 8, title: "other", check: "none", href: "http://x/8" },
      ],
    },
    false,
  );
  const html = await preview.text();
  expect(html).toContain(`<li><a href="${live}">The live app</a></li>`);
  expect(html).toContain("#7 mine · check none (this preview)");
  expect(html).not.toContain('href="http://x/7"');
  expect(html).toContain('href="http://x/8"');
  const prod = await doorPage(
    { where: { app: "notes", env: "production" }, forgeUrl: "http://forge.test", pulls: [] },
    false,
  ).text();
  expect(prod).not.toContain("The live app");
  expect(prod).not.toContain("this preview");
  // Without the repository to read, no production address either.
  const bare = await doorPage(
    { where: { app: "notes", env: "pull-7", pull: 7 }, forgeUrl: "http://forge.test", live },
    false,
  ).text();
  expect(bare).not.toContain("The live app");
  // The newest pull is among the five the door lists, so the proxy marks it.
  const fresh = createIssue(app.db, { repoId: record.repoId, authorId: alice, title: "newest", kind: "pull" });
  if (!fresh.ok) throw new Error(fresh.error);
  app.db
    .query(
      "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'h', 'b', 'x')",
    )
    .run(fresh.value.id);
  const real = await (await door(`notes--${fresh.value.number}.${DOMAIN}`)).text();
  expect(real).toContain(">The live app</a>");
  expect(real).toContain(`#${fresh.value.number} newest · check none (this preview)</li>`);
  expect(await (await door(`notes.${DOMAIN}`)).text()).not.toContain("The live app");
});

test("the door names the crew run working here, linked, to who may see it", async () => {
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "scoutbot",
    email: "scoutbot@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  const repoId = record.repoId;
  const open = createIssue(app.db, { repoId, authorId: alice, title: "o", kind: "pull" });
  const sealed = createIssue(app.db, { repoId, authorId: alice, title: "s", kind: "issue" });
  if (!open.ok || !sealed.ok) throw new Error("issue");
  setSealed(app.db, sealed.value.id, true);
  const target = { app: record, env: "production" } as AppTarget;
  const cookie = `forge_grant_${record.id.slice(-8)}=${signGrant(dataDir, target, 60_000, Date.now(), { id: alice, name: "alice", role: "admin" })}`;
  const start = (issueId: string) => {
    const run = createRun(app.db, { repoId, kind: "agent", issueId, actorId: bob.value.id, reason: "assigned" });
    claimRun(app.db, run.id);
    return run;
  };
  const idle = await (await door(`notes.${DOMAIN}`, cookie)).text();
  expect(idle).not.toContain("is working on this");
  const hidden = start(sealed.value.id);
  // A signed-in reader who may not see the sealed issue is not told of its run.
  const other = signGrant(dataDir, target, 60_000, Date.now(), { id: bob.value.id, name: "scoutbot", role: "user" });
  const otherCookie = `forge_grant_${record.id.slice(-8)}=${other}`;
  expect(await (await door(`notes.${DOMAIN}`, otherCookie)).text()).not.toContain("is working on this");
  expect(await (await door(`notes.${DOMAIN}`)).text()).not.toContain("is working on this");
  const run = start(open.value.id);
  const html = await (await door(`notes.${DOMAIN}`, cookie)).text();
  expect(html).toContain(`<a href="${servers.url}/alice/notes/runs/${run.id}">scoutbot is working on this</a>`);
  expect(html).not.toContain("<script");
  finishRun(app.db, run.id, { state: "ok", summary: "d" });
  finishRun(app.db, hidden.id, { state: "ok", summary: "d" });
  expect(await (await door(`notes.${DOMAIN}`, cookie)).text()).not.toContain("is working on this");
});

test("a public app's door links the report form on its own host; a private one's does not", async () => {
  const html = await (await door(`notes.${DOMAIN}`)).text();
  expect(html).toContain('<a href="/__forge/report">Report a problem, no account needed</a>');
  // The link resolves: the same public host answers it with the forge's form.
  const gone = await fetch(`${servers.url}/__forge/report`, {
    headers: { host: `notes.${DOMAIN}` },
    redirect: "manual",
  });
  expect(gone.status).toBe(303);
  const to = new URL(gone.headers.get("location")!);
  expect(`${to.origin}${to.pathname}`).toBe(`${servers.url}/alice/notes/report`);
  const owner = getUserById(app.db, alice)!;
  const made = await newApp(app, owner, { name: "closed", description: "x", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const closed = getAppByRepo(app.db, made.value.repo.id)!;
  const target = { app: closed, env: "production" } as AppTarget;
  const grant = signGrant(dataDir, target, 60_000, Date.now(), { id: alice, name: "alice", role: "admin" });
  const mine = await (
    await door(`closed.${DOMAIN}`, `forge_grant_${closed.id.slice(-8)}=${grant}`)
  ).text();
  expect(mine).toContain("<h1>closed</h1>");
  expect(mine).not.toContain("/__forge/report");
});
