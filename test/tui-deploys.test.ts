/** The deploys screen: production deploys, each with the pulls it carries. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { recordAppVital } from "../src/apps/vitals.ts";
import { createRun } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploys-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const screenText = async (
  who: User | null = alice,
  of: Repo = repo,
): Promise<string> => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who?.username ?? "guest", remoteAddress: "127.0.0.1", ...(who === null ? {} : { user: who }) },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, of));
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
};

test("with no deploys the screen says so", async () => {
  expect(await screenText()).toContain("No deploys");
});

test("a production deploy with no issue is listed, with what it carries", async () => {
  const run = createRun(forge.db, {
    repoId: repo.id,
    kind: "deploy",
    env: "production",
    commitOid: "a".repeat(40),
    reason: "push",
  });
  createRun(forge.db, {
    repoId: repo.id,
    kind: "deploy",
    env: "pull-9",
    commitOid: "b".repeat(40),
    summary: "PREVIEW-MARKER",
  });
  forge.db
    .query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1,?2,?3,?4)")
    .run(run.id, "i3", 3, "c".repeat(40));
  forge.db
    .query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1,?2,?3,?4)")
    .run(run.id, "i5", 5, "d".repeat(40));
  const text = await screenText();
  expect(text).toContain("deploy production");
  expect(text).toContain("carries #3 #5");
  expect(text).not.toContain("PREVIEW-MARKER");
});

test("a non-reader sees nothing of a private repo's deploys", async () => {
  const b = await signUp(forge, {
    username: "bob",
    email: "bob@forge.test",
    password: "a-long-passphrase",
  }, { slot: fixtureSlot(forge) });
  if (!b.ok) throw new Error("signup failed");
  const r = await createRepo(forge, alice, { name: "vault", visibility: "private" });
  if (!r.ok) throw new Error("repo failed");
  const secret = createRun(forge.db, {
    repoId: r.value.id,
    kind: "deploy",
    env: "production",
    commitOid: "e".repeat(40),
    summary: "SECRET-MARKER",
  });
  forge.db
    .query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1,?2,?3,?4)")
    .run(secret.id, "i7", 77, "f".repeat(40));
  for (const who of [b.value]) {
    const text = await screenText(who, r.value);
    expect(text).toContain("No deploys");
    expect(text).not.toContain("SECRET-MARKER");
    expect(text).not.toContain("#77");
    expect(text).not.toContain("deploy production");
  }
  expect(await screenText(alice, r.value)).toContain("#77");
});

test("an admin sees the app's visitors and speed above the deploys, and a reader does not", async () => {
  const r = await createRepo(forge, alice, { name: "shop", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const made = createAppRecord(forge.db, { repoId: r.value.id, slug: "shop", access: "public" });
  if (!made.ok) throw new Error(made.error);
  const record = made.value;
  const at = Date.now();
  recordAppVital(forge.db, record.id, { path: "/", ttfb: 90, load: 420, lcp: 1300, inp: 80, cls: 0.05 }, "c", "u", at);
  expect(await screenText(alice, r.value)).toContain("visitors 1 today, 1 in 7 days · p75 TTFB 90 ms · load 420 ms · LCP 1.3 s · INP 80 ms · CLS 0.05");
  const c = await signUp(forge, {
    username: "carol",
    email: "carol@forge.test",
    password: "a-long-passphrase",
  }, { slot: fixtureSlot(forge) });
  if (!c.ok) throw new Error("signup failed");
  expect(await screenText(c.value, r.value)).not.toContain("visitors");
});

test("the app's open pulls list below the deploys with check word and preview, and a guest sees none", async () => {
  const r = await createRepo(forge, alice, { name: "kiosk", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const made = createAppRecord(forge.db, { repoId: r.value.id, slug: "kiosk", access: "public" });
  if (!made.ok) throw new Error(made.error);
  const id = crypto.randomUUID();
  forge.db
    .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?, ?, 4, 'pull', 'Add a lamp', ?)")
    .run(id, r.value.id, alice.id);
  forge.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'lamp', 'b', 'h4')")
    .run(id);
  forge.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, 'h4', 'ok')")
    .run(crypto.randomUUID(), r.value.id, id);
  expect(await screenText(alice, r.value)).toContain("#4 Add a lamp · check green · none");

  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "guest", remoteAddress: "127.0.0.1" },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, r.value));
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  expect(text).not.toContain("Add a lamp");
  expect(text).not.toContain("Open pulls");
});

test("production's terminal names the newest open preview to a reader, and a guest sees neither", async () => {
  const { AppsRuntime } = await import("../src/apps/runtime.ts");
  const { appSideLines } = await import("../src/actions/apps.ts");
  const runtime = new AppsRuntime(forge, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 });
  const r = await createRepo(forge, alice, { name: "beacon", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const made = createAppRecord(forge.db, { repoId: r.value.id, slug: "beacon", access: "public" });
  if (!made.ok) throw new Error(made.error);
  const id = crypto.randomUUID();
  forge.db
    .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?, ?, 7, 'pull', 'Dim the beacon', ?)")
    .run(id, r.value.id, alice.id);
  forge.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'dim', 'b', 'h7')")
    .run(id);
  const real = runtime.envStatus.bind(runtime);
  runtime.envStatus = ((rec, env) =>
    env === "pull-7" ? ({ state: "running" } as ReturnType<typeof real>) : real(rec, env)) as typeof runtime.envStatus;
  try {
    const lines = ["Production: https://beacon.apps.test", "Newest preview: #7 Dim the beacon https://beacon--7.apps.test"];
    expect(appSideLines(forge, alice, r.value)).toEqual(lines);
    const text = await screenText(alice, r.value);
    for (const l of lines) expect(text).toContain(l);
    expect(appSideLines(forge, undefined, r.value)).toEqual([]);
    const guest = await screenText(null, r.value);
    expect(guest).not.toContain("Production:");
    expect(guest).not.toContain("Newest preview");
  } finally {
    await runtime.stop();
  }
});

test("the app's admin lists, adds, checks and removes a domain; a reader is offered none of it", async () => {
  const { AppsRuntime } = await import("../src/apps/runtime.ts");
  const { listAppDomains } = await import("../src/actions/domains.ts");
  const none = () => Promise.reject(Object.assign(new Error("x"), { code: "ENODATA" }));
  const runtime = new AppsRuntime(forge, {
    domain: "apps.test",
    scheme: "https",
    forgeUrl: "https://forge.test",
    concurrency: 1,
    dns: { resolveTxt: none, resolveCname: none },
  });
  const r = await createRepo(forge, alice, { name: "parlour", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const made = createAppRecord(forge.db, { repoId: r.value.id, slug: "parlour", access: "public" });
  if (!made.ok) throw new Error(made.error);
  const drive = async (who: User, keys: string[], of: Repo = r.value): Promise<string> => {
    const terminal = headlessTerminal(140, 30);
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    app.push(deploysScreen(session, app.ctx, of));
    await settleApp(app);
    for (const k of keys) {
      terminal.feed(k === "enter" ? "\r" : k);
      await settleApp(app);
    }
    const text = app.screen.toText();
    app.stop();
    return text;
  };
  const hosts = () => {
    const listed = listAppDomains(forge, alice, r.value);
    return listed.ok ? listed.value.map((d) => d.host) : [];
  };
  try {
    // A bad name and a taken one are refused in the page's words, and nothing is added.
    expect(await drive(alice, ["n", "+", ..."not a host", "enter"])).toContain("A domain is a hostname");
    expect(hosts()).toEqual([]);

    expect(await drive(alice, ["n", "+", ..."parlour.example.com", "enter"])).toContain("parlour.example.com is added.");
    expect(hosts()).toEqual(["parlour.example.com"]);
    const listed = await drive(alice, []);
    expect(listed).toContain("Domains: parlour.example.com waiting for DNS");

    const other = await createRepo(forge, alice, { name: "salon", visibility: "public" });
    if (!other.ok) throw new Error("repo failed");
    const otherApp = createAppRecord(forge.db, { repoId: other.value.id, slug: "salon", access: "public" });
    if (!otherApp.ok) throw new Error(otherApp.error);
    expect(await drive(alice, ["n", "+", ..."parlour.example.com", "enter"], other.value)).toContain(
      "Another app already answers to that domain.",
    );

    const checked = await drive(alice, ["n", "c"]);
    expect(checked).toContain("No TXT record at _forge-verify.parlour.example.com yet.");
    expect(checked).toContain("Still needed: a TXT record at _forge-verify.parlour.example.com");

    // A reader sees neither the domains nor the key, and the screen refuses them in words.
    const d = await signUp(forge, {
      username: "dana",
      email: "dana@forge.test",
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(forge) });
    if (!d.ok) throw new Error("signup failed");
    const reader = await drive(d.value, ["n"]);
    expect(reader).not.toContain("parlour.example.com");
    expect(reader).not.toContain("the app's own domains");
    const { domainsScreen } = await import("../src/tui/screens/deploys.ts");
    const terminal = headlessTerminal(140, 30);
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: "dana", remoteAddress: "127.0.0.1", user: d.value },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    app.push(domainsScreen(session, app.ctx, r.value));
    await settleApp(app);
    terminal.feed("+");
    await settleApp(app);
    const refused = app.screen.toText();
    app.stop();
    expect(refused).toContain("Only the app's admin manages its domains.");
    expect(refused).not.toContain("Add a domain");

    // `-` asks first: `n` keeps it, `y` removes it.
    expect(await drive(alice, ["n", "-"])).toContain("remove parlour.example.com? y/n");
    await drive(alice, ["n", "-", "n"]);
    expect(hosts()).toEqual(["parlour.example.com"]);
    expect(await drive(alice, ["n", "-", "y"])).toContain("parlour.example.com is removed.");
    expect(hosts()).toEqual([]);
  } finally {
    await runtime.stop();
  }
});
