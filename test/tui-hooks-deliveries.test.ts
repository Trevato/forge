/**
 * Enter on a webhook in the terminal's Hooks screen opens its last 20
 * deliveries (#7873): state, status and why it failed, never a secret;
 * esc or q returns to the same row; losing admin closes it. `r` redelivers
 * a failed row (#8075); `p` sends the hook a ping (#7872).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createWebhook, enqueueForEvent, listWebhooks, PING_LIMIT } from "../src/core/webhooks.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { hooksScreen } from "../src/tui/screens/hooks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const SECRET = "s3cret-signing-key-0123456789";
const KEYS: Record<string, string> = { enter: "\r", esc: "\x1b" };

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deliveries-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const made = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;

  const mkHook = (url: string) => {
    const r = createWebhook(app.db, { repoId: repo.id, url, kinds: "*", secret: SECRET });
    if (!r.ok) throw new Error(r.error);
  };
  mkHook("https://example.com/a");
  mkHook("https://example.com/b");
  enqueueForEvent(app.db, app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: {} }));
  enqueueForEvent(app.db, app.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: alice.id, payload: {} }));
  mkHook("https://example.com/c");
  const rows = app.db
    .query<{ id: string }, [string]>("SELECT id FROM webhook_delivery WHERE webhook_id = ?1 ORDER BY id")
    .all(listWebhooks(app.db, repo.id)[1]!.id);
  app.db.run("UPDATE webhook_delivery SET state='ok', attempts=1, last_status=204 WHERE id = ?1", [rows[0]!.id]);
  app.db.run("UPDATE webhook_delivery SET state='failed', attempts=3, last_error='refused: private address' WHERE id = ?1", [
    rows[1]!.id,
  ]);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

function open() {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(hooksScreen(session, tui.ctx, repo));
  const frames: string[] = [];
  return {
    session,
    frames,
    text: (): string => {
      const t = tui.screen.toText();
      frames.push(t);
      return t;
    },
    feed: async (...keys: string[]) => {
      for (const k of keys) {
        terminal.feed(KEYS[k] ?? k);
        if (k === "esc") await new Promise<void>((r) => setTimeout(r, 40));
        await settleApp(tui);
      }
    },
    stop: () => tui.stop?.(),
  };
}

test("enter lists a hook's deliveries with status and reason; esc and q return to the same row", async () => {
  const h = open();
  await h.feed("j", "enter");
  const t = h.text();
  expect(t).toContain("Deliveries");
  expect(t).toMatch(/push · ok · 204 · 1/);
  expect(t).toMatch(/issue\.opened · failed · refused: private address · 3/);
  expect(h.frames.join("\n")).not.toContain(SECRET);

  for (const back of ["esc", "q"]) {
    await h.feed(back);
    expect(h.text()).not.toContain("Deliveries");
    await h.feed("enter");
    expect(h.text()).toContain("issue.opened · failed");
  }
  h.stop();
});

test("a hook with no deliveries says so", async () => {
  const h = open();
  await h.feed("j", "j", "enter");
  expect(h.text()).toContain("No deliveries yet.");
  h.stop();
});

test("losing admin closes the deliveries instead of showing them", async () => {
  const h = open();
  await h.feed("j", "enter");
  expect(h.text()).toContain("refused: private address");
  (h.session as { user: User }).user = bob;
  await h.feed("j");
  expect(h.text()).not.toContain("refused: private address");
  h.stop();
});

const states = (): string[] =>
  app.db
    .query<{ state: string }, []>(
      "SELECT d.state FROM webhook_delivery d JOIN event e ON e.id = d.event_id WHERE d.webhook_id = (SELECT id FROM webhook ORDER BY rowid LIMIT 1 OFFSET 1) ORDER BY d.rowid DESC",
    )
    .all()
    .map((r) => r.state);

test("r on a failed row queues it again; on a row that is not failed it does nothing", async () => {
  const h = open();
  await h.feed("j", "enter");
  // Newest first: issue.opened (failed) is on top, push (ok) below it.
  await h.feed("j", "r");
  expect(h.text()).toMatch(/push · ok · 204 · 1/);
  expect(h.text()).not.toContain("queued again");
  expect(states()).toEqual(["failed", "ok"]);
  await h.feed("k", "r");
  const t = h.text();
  expect(t).toContain("queued again");
  expect(t).toMatch(/issue\.opened · pending · — · 0/);
  expect(t).not.toContain("refused: private address");
  await h.feed("r");
  expect(h.text()).toMatch(/issue\.opened · pending/);
  h.stop();
});

test("a person who lost admin cannot redeliver with r: the row stays failed", async () => {
  app.db.run("UPDATE webhook_delivery SET state = 'failed' WHERE state = 'pending'");
  const h = open();
  await h.feed("j", "enter");
  (h.session as { user: User }).user = bob;
  await h.feed("r");
  expect(h.text()).not.toContain("queued again");
  expect(app.db.query("SELECT 1 FROM webhook_delivery WHERE state = 'pending'").get()).toBeNull();
  h.stop();
});

test("p sends the hook a ping that shows at once among its deliveries; past the limit it says how long to wait", async () => {
  const h = open();
  await h.feed("j", "j", "enter");
  expect(h.text()).toContain("No deliveries yet.");
  for (let i = 0; i < PING_LIMIT; i++) {
    await h.feed("p");
    expect(h.text()).toContain("ping queued");
  }
  expect(h.text()).toMatch(/ping · pending · — · 0/);
  await h.feed("p");
  expect(h.text()).toMatch(/too many pings: try again in \d+ s/);
  const hook = listWebhooks(app.db, repo.id)[2]!;
  expect(app.db.query("SELECT COUNT(*) AS n FROM webhook_ping WHERE webhook_id = ?1").get(hook.id)).toEqual({
    n: PING_LIMIT,
  });
  h.stop();
});

test("a person who lost admin cannot ping with p", async () => {
  const before = (app.db.query("SELECT COUNT(*) AS n FROM webhook_ping").get() as { n: number }).n;
  const h = open();
  await h.feed("enter");
  (h.session as { user: User }).user = bob;
  await h.feed("p");
  expect(h.text()).not.toContain("ping queued");
  expect((app.db.query("SELECT COUNT(*) AS n FROM webhook_ping").get() as { n: number }).n).toBe(before);
  h.stop();
});
