/**
 * The settings trail (#7653): a settings change says who made it and what it
 * moved, from what to what, and the outbox reads one kind of event at a time,
 * on the API and through MCP `events`, still paging with `next_cursor`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { eventsPage } from "../src/core/events_page.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { eventsScreen } from "../src/tui/screens/events.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

type Item = { kind: string; actorId: string | null; payload: Record<string, any> };

describe("the settings trail", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let token: string;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-settings-trail-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    token = createToken(app.db, alice.id, "t", "admin").token;
    const made = await createRepo(app, alice, { name: "yard", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const fresh = (): Repo => getRepoById(app.db, repo.id)!;

  test("requireReview flipped twice reads back newest first, with the actor and from/to", async () => {
    expect((await updateRepoSettings(app, alice, fresh(), { requireReview: true })).ok).toBe(true);
    expect((await updateRepoSettings(app, alice, fresh(), { requireReview: false, description: "a yard" })).ok).toBe(true);
    const page = eventsPage(app.db, repo.id, alice, 50, undefined, "repo.settings_updated");
    expect(page.items.map((e) => e.kind)).toEqual(["repo.settings_updated", "repo.settings_updated"]);
    const [off, on] = page.items;
    expect(off!.actorId).toBe(alice.id);
    expect(off!.payload["changed"]).toEqual({
      description: { from: "", to: "a yard" },
      requireReview: { from: true, to: false },
    });
    expect(on!.actorId).toBe(alice.id);
    expect(on!.payload["changed"]).toEqual({ requireReview: { from: false, to: true } });
  });

  test("the API takes kind and pages it with next_cursor; a bad kind is a 422", async () => {
    expect((await updateRepoSettings(app, alice, fresh(), { requireChecks: true })).ok).toBe(true);
    expect((await updateRepoSettings(app, alice, fresh(), { requireChecks: false })).ok).toBe(true);
    const get = (qs: string) =>
      fetch(`${servers.url}/api/v1/repos/alice/yard/events${qs}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const first = (await (await get("?kind=repo.settings_updated&limit=2")).json()) as {
      items: Item[];
      next_cursor: string | null;
    };
    expect(first.items.length).toBe(2);
    expect(first.items.every((e) => e.kind === "repo.settings_updated")).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    const rest = (await (await get(`?kind=repo.settings_updated&limit=2&cursor=${first.next_cursor}`)).json()) as {
      items: Item[];
    };
    expect(rest.items.length).toBe(2);
    expect(rest.items.every((e) => e.kind === "repo.settings_updated")).toBe(true);
    expect(rest.items.map((e) => e.payload["changed"])).toContainEqual({ requireReview: { from: false, to: true } });
    expect((await get("?kind=<script>")).status).toBe(422);
  });

  test("MCP `events` takes kind", async () => {
    const call = async (args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "events", arguments: args },
        }),
      });
      return ((await res.json()) as any).result as { isError?: boolean; content: { text: string }[] };
    };
    const got = await call({ repo: "alice/yard", kind: "repo.settings_updated", limit: 1 });
    expect(got.isError).not.toBe(true);
    const page = JSON.parse(got.content[0]!.text) as { items: Item[]; next_cursor: string | null };
    expect(page.items.map((e) => e.kind)).toEqual(["repo.settings_updated"]);
    expect(page.items[0]!.payload["changed"]).toEqual({ requireChecks: { from: true, to: false } });
    expect(page.next_cursor).not.toBeNull();
    expect((await call({ repo: "alice/yard", kind: "Not A Kind" })).isError).toBe(true);
  });

  test("the terminal's Events screen shows who and from/to, and `s` keeps only settings changes", async () => {
    app.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: alice.id, payload: { number: 4242 } });
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: alice.username, remoteAddress: "127.0.0.1", user: alice },
      { terminal: headlessTerminal(140, 30), exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(eventsScreen(session, tui.ctx, fresh()));
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("#4242");
    tui.dispatch({ type: "key", key: "s", ctrl: false, alt: false, shift: false });
    await settleApp(tui);
    const text = tui.screen.toText();
    expect(text).not.toContain("#4242");
    expect(text).toContain("alice changed repository settings: requireChecks true → false");
    expect(text).toContain("requireReview false → true");
    tui.dispatch({ type: "key", key: "s", ctrl: false, alt: false, shift: false });
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("#4242");
  });
});
