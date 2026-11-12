/**
 * The new-app line at each door (#10295): the app page's head card, its
 * state fragment, the live client, the terminal, the guest, and the
 * notifier's event wiring.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setNotifyUrl, startNotifier } from "../src/crew/notify.ts";
import { liveClientJs, liveMount } from "../src/web/live.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let alice: User;
let bearer = "";
const repos: Record<string, Repo> = {};
const OID = (c: string) => c.repeat(40);

function giveAPull(repo: Repo, n: number): void {
  app.db.run("INSERT OR IGNORE INTO user (id, username, email, password_hash, is_agent) VALUES ('mason-id', 'mason', 'm@x', '', 1)");
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, 1, 'pull', 'Make it run', 'mason-id')", [`i${n}`, repo.id]);
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'mason/run', ?2, ?3)", [`i${n}`, OID("a"), OID("b")]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-onboarding-doors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  alice = admin.value;
  let n = 0;
  for (const [name, visibility] of [["open", "public"], ["sealed", "private"]] as const) {
    const made = await createRepo(app, alice, { name, visibility, description: "" });
    if (!made.ok) throw new Error(String(made.error));
    const row = insertApp(app.db, { repoId: made.value.id, slug: name, access: visibility });
    if (!row.ok) throw new Error(row.error);
    repos[name] = made.value;
    giveAPull(made.value, ++n);
  }
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string, auth: boolean) =>
  fetch(`${servers.url}${path}`, {
    headers: { ...(auth ? { authorization: `Bearer ${bearer}` } : {}), cookie: "forge_mode=studio" },
  });
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const headOf = (text: string): string => {
  const at = text.indexOf('id="app-head"');
  return at < 0 ? "" : text.slice(at, text.indexOf('id="app-previews"', at));
};

test("the line is the head card's facts row, once, on the page and in its state fragment", async () => {
  const page = await (await get("/alice/open/app", true)).text();
  expect(page).not.toContain('id="app-onboarding"');
  expect(count(page, "data-onboarding=")).toBe(1);
  expect(headOf(page)).toContain('data-onboarding="making"');
  expect(headOf(page)).toContain("The crew is making it run (pull #1 by mason).");
  const fragment = await (await get("/alice/open/app/state", true)).text();
  expect(count(fragment, "data-onboarding=")).toBe(1);
  expect(headOf(fragment)).toContain("pull #1 by mason");
});

test("a guest on a public app reads 'the crew', never the agent's name", async () => {
  const page = await (await get("/alice/open/app", false)).text();
  expect(page).toContain("by the crew");
  expect(page).not.toContain("by mason");
  const fragment = await (await get("/alice/open/app/state", false)).text();
  expect(fragment).not.toContain("mason");
});

test("a guest on a private app learns nothing from the line", async () => {
  for (const path of ["/alice/sealed/app", "/alice/sealed/app/state"]) {
    const res = await get(path, false);
    const text = await res.text();
    expect(res.status).not.toBe(200);
    expect(text).not.toContain("making it run");
    expect(text).not.toContain("pull #1");
    expect(text).not.toContain("mason");
  }
});

const frame = async (who: User | null, repo: Repo): Promise<string> => {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: who?.username ?? "guest", remoteAddress: "127.0.0.1", ...(who === null ? {} : { user: who }) },
    { terminal: headlessTerminal(200, 40), exitHooks: false },
  );
  tui.start();
  await settleApp(tui);
  tui.push(deploysScreen(session, tui.ctx, repo));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop();
  return text;
};

test("the terminal's deploys screen says where the app stands; a guest reads 'the crew'", async () => {
  const owner = await frame(alice, repos.open!);
  expect(owner).toContain("The crew is making it run (pull #1 by mason).");
  const guest = await frame(null, repos.open!);
  expect(guest).toContain("by the crew");
  expect(guest).not.toContain("mason");
});

test("a failed check: the owner reads its failing line and log; a guest on the public app reads only that a check failed", async () => {
  const run = createRun(app.db, { repoId: repos.open!.id, kind: "check", env: "pull-1", issueId: "i1", commitOid: OID("b"), reason: "push" });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "failed", summary: "check failed: 1 test failed", checkDetail: { passed: 3, failed: 1, names: ["boots on its port"] } });

  for (const path of ["/alice/open/app", "/alice/open/app/state"]) {
    const owner = headOf(await (await get(path, true)).text());
    expect(owner).toContain("Check failed: boots on its port");
    expect(owner).toContain(`href="/alice/open/runs/${run.id}">Failing run log</a>`);

    const guest = headOf(await (await get(path, false)).text());
    expect(guest).toContain("A check failed.");
    expect(guest).not.toContain("boots on its port");
    expect(guest).not.toContain(run.id);
    expect(guest).not.toContain("Failing run log");
  }
  const guestTui = await frame(null, repos.open!);
  expect(guestTui).toContain("A check failed.");
  expect(guestTui).not.toContain("boots on its port");
});

/** Runs the live client on an app page; returns its stream listeners and what it fetched. */
async function liveClient(row: boolean) {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "http://forge.test/alice/open/app" });
  win.document.body.innerHTML = `${String(liveMount({ repo: "/alice/open", app: true }))}
    <div id="app-head">${row ? '<p class="muted" data-onboarding="making">The crew is making it run.</p>' : ""}</div>
    <div id="app-previews"></div>`;
  const listeners = new Map<string, (e: { data: string }) => void>();
  class FakeSource {
    addEventListener(kind: string, f: (e: { data: string }) => void) {
      listeners.set(kind, f);
    }
    close() {}
  }
  const fetched: string[] = [];
  const fakeFetch = async (url: string) => {
    fetched.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
  };
  new Function("document", "window", "location", "EventSource", "fetch", liveClientJs)(
    win.document, win, win.location, FakeSource, fakeFetch,
  );
  const send = async (kind: string, payload: Record<string, unknown> = {}) => {
    listeners.get(kind)?.({ data: JSON.stringify({ kind, payload }) });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { listeners, fetched, send, win };
}

test("the live client refreshes the head on the crew's runs and pulls only while the head carries the line", async () => {
  const onboarding = await liveClient(true);
  await onboarding.send("run.started", { kind: "agent" });
  expect(onboarding.fetched).toEqual(["/alice/open/app/state"]);
  await onboarding.send("pull.closed");
  expect(onboarding.fetched.length).toBe(2);
  // Not subscribed: a push to a pull is followed through the runs it starts.
  expect(onboarding.listeners.has("pull.pushed")).toBe(false);

  const settled = await liveClient(false);
  await settled.send("run.started", { kind: "agent" });
  await settled.send("pull.closed");
  expect(settled.fetched).toEqual([]);
});

test("the notifier judges a new app afresh on a pull event and tells its owner once it needs them", async () => {
  setNotifyUrl(app.db, alice.id, "https://ntfy.example.test/onboarding");
  const posts: string[] = [];
  const notifier = startNotifier(app, {
    forgeUrl: "https://forge.example.test",
    drainingSince: () => null,
    send: async (_u, body) => {
      posts.push(body);
      return true;
    },
  });
  try {
    await notifier.settled();
    expect(posts.filter((p) => p.includes("needs you"))).toEqual([]);
    app.db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    app.bus.append({ kind: "pull.closed", repoId: repos.open!.id, actorId: alice.id, payload: { number: 1 } });
    await notifier.settled();
    expect(posts.filter((p) => p.includes("open needs you")).length).toBe(1);
  } finally {
    notifier.stop();
  }
});
