/**
 * The queue in the terminal (#11604): the owner sees the panel and flips the planner's switch with
 * keys, through the page's own action; a reader sees the panel and no keys; a sealed issue's title
 * is in no line for someone who may not see it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { pausedUntil } from "../src/core/planner_pause.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { queueLines } from "../src/tui/screens/queuegrowth.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settlePalette } from "./helpers/tui.ts";

quietLogs();

describe("the queue in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let ada: User;
  let dave: User;
  let repo: Repo;

  function boot(user: User | undefined) {
    const terminal = headlessTerminal(120, 40);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => {
      const ctrl = k.startsWith("ctrl+");
      app.dispatch({ type: "key", key: ctrl ? k.slice(5) : k, ctrl, alt: false, shift: false });
    };
    const press = async (...keys: string[]) => {
      for (const k of keys) key(k);
      await settleApp(app);
    };
    const type = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
    };
    const ask = async (text: string) => {
      await press("ctrl+k");
      await type(text);
      await settlePalette(app);
      await press("enter");
    };
    const open = async () => {
      await settleApp(app);
      await ask("Open a repository");
      await type("ada/shop");
      await settlePalette(app);
      await press("enter");
      await ask("Queue");
    };
    return { text: () => app.screen.toText(), press, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-queue-"));
    forge = createApp({ dataDir, port: 0 });
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    dave = await make("dave", false);
    const made = await createRepo(forge, ada, { name: "shop", visibility: "public", description: "" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    repo = made.value;
  }, 60_000);

  afterAll(async () => {
    forge?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("the owner reads the panel and pauses and resumes the planner with keys", async () => {
    const h = boot(ada);
    await h.open();
    expect(h.text()).toContain("The planner is on.");
    expect(h.text()).toContain("Issues opened");
    await h.press("o");
    expect(pausedUntil(forge.db, repo.id, new Date())).not.toBeNull();
    expect(h.text()).toContain("The planner is paused until you switch it on.");
    await h.press("n");
    expect(pausedUntil(forge.db, repo.id, new Date())).toBeNull();
    h.stop();
  });

  test("a reader sees the panel and no key changes the switch", async () => {
    const h = boot(dave);
    await h.open();
    expect(h.text()).toContain("The planner is on.");
    await h.press("o");
    expect(pausedUntil(forge.db, repo.id, new Date())).toBeNull();
    h.stop();
  });

  test("a sealed issue's title is in no line for a guest, and is for the writer", () => {
    forge.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, sealed) VALUES ('sx1', ?1, 900, 'issue', 'secret hole in login', ?2, 'open', 1)`,
      )
      .run(repo.id, ada.id);
    const session = (user: User | undefined) => ({ db: forge.db, user }) as never;
    expect(queueLines(session(undefined), repo).join("\n")).not.toContain("secret hole in login");
    expect(queueLines(session(ada), repo).join("\n")).toContain("secret hole in login");
  });
});
