/** The access wall's two answers reach a writer on both pages and in the terminal, and nobody else (#7847). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull } from "../src/core/pulls.ts";
import { listReviews } from "../src/core/reviews.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { wallCard } from "../src/web/studio/change.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const contract = (read: string) =>
  JSON.stringify({
    roles: {
      anon: { above: [], held: { by: "everyone" } },
      user: { above: ["anon"], held: { by: "identity", role: "user" } },
      admin: { above: ["user"], held: { by: "identity", role: "admin" } },
    },
    resources: {
      address: { can: { create: "user", read, update: "admin", delete: "admin", list: read } },
    },
  });

describe("the wall's answers, by door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let aliceCookie: string;
  let bobCookie: string;
  let n = 0;

  const wallPull = async () => {
    const branch = `open-${++n}`;
    const made = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [{ path: "contract.json", content: contract("anon") }],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const page = async (path: string, cookie?: string) =>
    (await fetch(`${servers.url}/alice/notes${path}`, { headers: cookie ? { cookie } : {} })).text();
  const drive = async (who: User, number: number, keys: string[]) => {
    const terminal = headlessTerminal(160, 44);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: who.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: who },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(pullScreen(session, tui.ctx, local(session, repo), number));
    await settleApp(tui);
    const frames = [tui.screen.toText()];
    for (const k of keys) {
      terminal.feed(k);
      await settleApp(tui);
      frames.push(tui.screen.toText());
    }
    tui.stop();
    return frames;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wall-doors-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await mk("alice");
    bob = await mk("bob");
    aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "a contract",
      files: [{ path: "contract.json", content: contract("user") }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the pull page and the Files tab hand the forms to a writer alone", async () => {
    const p = await wallPull();
    for (const path of [`/pulls/${p.number}`, `/pulls/${p.number}/files`]) {
      const mine = await page(path, aliceCookie);
      expect(mine).toContain("anyone signed out could read address records");
      expect(mine).toContain(`action="/alice/notes/pulls/${p.number}/merge"`);
      expect(mine).toContain(`action="/alice/notes/pulls/${p.number}/review-state"`);
      expect(mine).toContain("Allow it and merge");
      expect(mine).toContain('name="body"');
      expect(mine).not.toContain("Sent back at the access wall");
      for (const reader of [await page(path, bobCookie), await page(path)]) {
        expect(reader).toContain("address.read as anon");
        expect(reader).not.toContain("Allow it and merge");
        expect(reader).not.toContain("Send it back");
      }
    }
  });

  test("a contract that does not read is worded as unsound", () => {
    const html = String(wallCard({ loosened: [], unsound: ["contract.json is not JSON"] }, "/a/b/pulls/1"));
    expect(html).toContain("does not boot");
    expect(html).toContain("contract.json is not JSON");
    expect(html).not.toContain("If you allow it");
  });

  test("the terminal: w offers both answers to a writer, sends back, and offers nothing to a reader", async () => {
    const p = await wallPull();
    expect((await drive(bob, p.number, ["w"])).at(-1)).not.toContain("Send it back");
    const dialog = (await drive(alice, p.number, ["w"])).at(-1)!;
    expect(dialog).toContain("Send it back");
    expect(dialog).toContain("Allow it and merge");
    expect(dialog).toContain("anyone signed out could read address records");
    await drive(alice, p.number, ["w", "\x1b[C", "\r"]);
    expect(listReviews(app.db, getPull(app.db, repo.id, p.number)!.id).map((r) => r.state)).toEqual(["changes_requested"]);
  }, 60_000);

  test("the terminal: Allow it and merge lands the pull", async () => {
    const p = await wallPull();
    await drive(alice, p.number, ["w", "\x1b[C", "\x1b[C", "\r"]);
    expect(getPull(app.db, repo.id, p.number)!.mergedAt).not.toBeNull();
  }, 60_000);
});
