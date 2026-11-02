/**
 * "First" in the terminal (#7808): `f` on a ready line of the plan screen puts
 * that issue first through the same action the map page posts to, a reader is
 * refused in the same words, and the web hears the write as `issue.first`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { FIRST_FORBIDDEN } from "../src/actions/first.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("first, in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let repo: Repo;
  let alpha = 0;
  let beta = 0;

  const ready = () => readyNow(repoGraph(forge.db, repo.id)).map((r) => r.issue.number);

  function boot(user: User) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        const ctrl = key.startsWith("ctrl+");
        app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
      }
      await settleApp(app);
    };
    const typeText = async (text: string) => {
      for (const ch of text)
        app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const toPlan = async () => {
      await settleApp(app);
      await press("ctrl+k");
      await typeText("Issues in a repository");
      await press("enter");
      await typeText("alice/plan");
      await press("enter");
      await press("m");
    };
    return { text: () => app.screen.toText(), press, toPlan, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-first-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    const alice = getUserByName(forge.db, "alice")!;
    const made = await createRepo(forge, alice, { name: "plan", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
    for (const title of ["Alpha work", "Beta work"]) {
      const o = openIssue(forge, alice, getRepoById(forge.db, repo.id)!, { title });
      if (!o.ok) throw new Error(String(o.error));
      if (title === "Alpha work") alpha = o.value.number;
      else beta = o.value.number;
    }
  }, 60_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader's f is refused and changes nothing", async () => {
    const h = boot(getUserByName(forge.db, "bob")!);
    await h.toPlan();
    expect(h.text()).toContain("Ready now 2");
    await h.press("f");
    expect(h.text()).toContain(FIRST_FORBIDDEN);
    expect(ready()).toEqual([alpha, beta]);
    h.stop();
  });

  test("a writer's f on the second ready line puts it first, by name, and the web hears it", async () => {
    const heard: string[] = [];
    const off = forge.bus.subscribe((e) => {
      if (e.kind === "issue.first" && e.repoId === repo.id) heard.push(e.kind);
    });
    const h = boot(getUserByName(forge.db, "alice")!);
    await h.toPlan();
    await h.press("j", "f");
    expect(ready()).toEqual([beta, alpha]);
    expect(heard).toEqual(["issue.first"]);
    expect(h.text()).toContain("first, by alice");
    off();
    h.stop();
  });
});
