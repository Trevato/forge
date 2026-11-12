/**
 * A repository's webhooks in the terminal (#7243): an admin lists, adds and
 * removes; a short secret is refused in MCP `hooks`'s words; whoever does not
 * admin the repository is never offered the screen; no frame shows a secret.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, deleteWebhook, pauseWebhook } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { canAdmin, canWrite, type Repo } from "../src/core/repos.ts";
import { createOrg, createTeam, addTeamMember } from "../src/core/orgs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createWebhook, enqueueForEvent, getWebhook, listWebhooks } from "../src/core/webhooks.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { hooksCommands, hooksScreen } from "../src/tui/screens/hooks.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

/** Open Webhooks from the palette once its row has drawn. */
async function palette(h: ReturnType<typeof open>): Promise<void> {
  await h.feed(":", ..."Webhooks");
  for (let i = 0; i < 100 && !h.text().includes("list, add and remove webhooks"); i++)
    await new Promise<void>((r) => setTimeout(r, 10)), await h.feed();
  if (!h.text().includes("list, add and remove webhooks")) throw new Error(`never came: still waiting while !h.text().includes("list, add and remove webhooks")`);
  await h.feed("enter");
}

const SECRET = "s3cret-signing-key-0123456789";

const KEYS: Record<string, string> = { enter: "\r", right: "\x1b[C" };

function open(user: User, at: Repo = repo) {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, at)));
  const frames: string[] = [];
  const text = (): string => {
    const t = tui.screen.toText();
    frames.push(t);
    return t;
  };
  return {
    session,
    ctx: tui.ctx,
    frames,
    text,
    feed: async (...keys: string[]) => {
      for (const k of keys) {
        terminal.feed(KEYS[k] ?? k);
        await settleApp(tui);
      }
    },
    stop: () => tui.stop?.(),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-hooks-"));
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
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("webhooks in the terminal", () => {
  test("an admin lists, adds and removes a hook; no frame shows the secret", async () => {
    const h = open(alice);
    await palette(h);
    expect(h.text()).toContain("No webhooks");

    await h.feed("a", ..."https://example.com/hook", "enter");
    await h.feed(..."push", "enter");
    await h.feed(...SECRET, "enter");
    const hooks = listWebhooks(app.db, repo.id);
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.url).toBe("https://example.com/hook");
    expect(hooks[0]!.kinds).toBe("push");
    expect(h.text()).toContain("https://example.com/hook");
    expect(h.text()).toContain("kinds push");
    expect(h.text()).toContain("no delivery yet");

    await h.feed("d");
    expect(h.text()).toContain("Remove webhook");
    await h.feed("right", "enter");
    expect(listWebhooks(app.db, repo.id).length).toBe(0);
    expect(h.text()).toContain("No webhooks");
    expect(h.frames.join("\n")).not.toContain(SECRET);
    h.stop();
  });

  test("p pauses and resumes the selected hook; a paused hook is queued nothing", async () => {
    const h = open(alice);
    await palette(h);
    await h.feed("a", ..."https://example.com/pause", "enter", ..."push", "enter", ...SECRET, "enter");
    const find = () => listWebhooks(app.db, repo.id).find((x) => x.url.endsWith("/pause"))!;
    const row = listWebhooks(app.db, repo.id).findIndex((x) => x.url.endsWith("/pause"));
    for (let i = 0; i < row; i++) await h.feed("j");
    await h.feed("p");
    expect(find().active).toBe(false);
    expect(h.text()).toContain("paused");
    const before = app.db.query<{ n: number }, [string]>("SELECT count(*) n FROM webhook_delivery WHERE webhook_id = ?1").get(find().id)!.n;
    enqueueForEvent(app.db, app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: {} }));
    expect(app.db.query<{ n: number }, [string]>("SELECT count(*) n FROM webhook_delivery WHERE webhook_id = ?1").get(find().id)!.n).toBe(before);
    expect(listEvents(app.db, { limit: 1000 }).some((e) => e.kind === "webhook.paused")).toBe(true);
    await h.feed("p");
    expect(find().active).toBe(true);
    expect(listEvents(app.db, { limit: 1000 }).some((e) => e.kind === "webhook.resumed")).toBe(true);
    enqueueForEvent(app.db, app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: {} }));
    expect(app.db.query<{ n: number }, [string]>("SELECT count(*) n FROM webhook_delivery WHERE webhook_id = ?1").get(find().id)!.n).toBe(before + 1);
    await h.feed("d", "right", "enter");
    expect(listWebhooks(app.db, repo.id).length).toBe(0);
    h.stop();
  });

  test("a short secret is refused in MCP's words and nothing is added", async () => {
    const h = open(alice);
    await palette(h);
    await h.feed("a", ..."https://example.com/x", "enter", "enter");
    await h.feed(..."tooshort", "enter");
    expect(h.text()).toContain("secret is required: 16 to 200 characters");
    expect(listWebhooks(app.db, repo.id).length).toBe(0);
    expect(h.frames.join("\n")).not.toContain("tooshort");
    h.stop();
  });

  test("a refused url says so and nothing is added", async () => {
    const h = open(alice);
    await palette(h);
    await h.feed("a", ..."http://example.com/x", "enter", "enter");
    await h.feed(...SECRET, "enter");
    expect(h.text()).toContain("a webhook url is https://…");
    expect(listWebhooks(app.db, repo.id).length).toBe(0);
    h.stop();
  });

  test("someone who does not admin the repository is never offered it", async () => {
    const h = open(bob);
    await h.feed(":", ..."Webhooks");
    for (let i = 0; i < 100 && h.text().includes("searching…"); i++)
      await new Promise<void>((r) => setTimeout(r, 10)), await h.feed();
    expect(h.text()).not.toContain("list, add and remove webhooks");
    h.stop();
  });

  test("comma- or space-separated kinds are stored space-separated", async () => {
    const h = open(alice);
    await palette(h);
    await h.feed("a", ..."https://example.com/two", "enter", ..."push,issue.*", "enter", ...SECRET, "enter");
    const hook = listWebhooks(app.db, repo.id).find((x) => x.url.endsWith("/two"))!;
    expect(hook.kinds).toBe("push issue.*");
    expect(h.text()).toContain("kinds push issue.*");
    h.stop();
  });

  test("a url, kinds or secret over its length is refused and nothing is added", async () => {
    const before = listWebhooks(app.db, repo.id).length;
    let h = open(alice);
    await palette(h);
    await h.feed("a", "https://example.com/" + "x".repeat(2040), "enter");
    expect(h.text()).toContain("url is text of at most 2048 characters");
    h.stop();
    h = open(alice);
    await palette(h);
    await h.feed("a", ..."https://example.com/k", "enter", "k".repeat(201), "enter");
    expect(h.text()).toContain("kinds is text of at most 200 characters");
    h.stop();
    h = open(alice);
    await palette(h);
    await h.feed("a", ..."https://example.com/s", "enter", "enter", "s".repeat(201), "enter");
    expect(h.text()).toContain("secret is required: 16 to 200 characters");
    expect(listWebhooks(app.db, repo.id).length).toBe(before);
    expect(h.frames.join("\n")).not.toContain("sssssssssss");
    h.stop();
  });

  test("a delivery row shows as the last delivery", async () => {
    const event = app.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: {} });
    enqueueForEvent(app.db, event);
    const h = open(alice);
    await palette(h);
    expect(h.text()).toContain("last push: pending");
    h.stop();
  });

  test("a writer who is not an admin is never offered it and cannot reach it", async () => {
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "devs", "write");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, bob.id);
    const made = await createRepo(app, alice, { owner: "acme", name: "shop", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    expect(canWrite(app.db, made.value, bob)).toBe(true);
    expect(canAdmin(app.db, made.value, bob)).toBe(false);
    const h = open(bob, made.value);
    await h.feed(":", ..."Webhooks");
    for (let i = 0; i < 100 && h.text().includes("searching…"); i++)
      await new Promise<void>((r) => setTimeout(r, 10)), await h.feed();
    expect(h.text()).not.toContain("list, add and remove webhooks");
    expect(hooksCommands(h.session, h.ctx, made.value)).toEqual([]);
    h.stop();
  });

  test("a non-admin pressing p changes nothing, and pauseWebhook refuses them and another repo's admin", async () => {
    const mine = createWebhook(app.db, { repoId: repo.id, url: "https://example.com/neg", kinds: "push", secret: SECRET });
    if (!mine.ok) throw new Error(mine.error);
    const id = mine.value.webhook.id;
    const paused = () => listEvents(app.db, { limit: 1000 }).filter((e) => e.kind === "webhook.paused").length;
    const before = paused();
    // bob does not admin the repo: the screen, pushed directly, shows him nothing and p does nothing.
    const h = open(bob);
    h.ctx.push(hooksScreen(h.session, h.ctx, repo));
    await h.feed("p");
    expect(h.text()).toContain("Not available");
    h.stop();
    expect(getWebhook(app.db, repo.id, id)!.active).toBe(true);

    const refused = pauseWebhook(app, bob, repo, id, true);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("not_found");
    const guest = pauseWebhook(app, undefined, repo, id, true);
    expect(guest.ok).toBe(false);

    // an admin of another repository, naming this repository's hook there
    const other = await createRepo(app, alice, { name: "elsewhere", visibility: "public" });
    if (!other.ok) throw new Error(String(other.error));
    const cross = pauseWebhook(app, alice, other.value, id, true);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error).toBe("not_found");
    expect(getWebhook(app.db, repo.id, id)!.active).toBe(true);
    expect(paused()).toBe(before);
    expect(deleteWebhook(app, alice, repo, id).ok).toBe(true);
  });
});
