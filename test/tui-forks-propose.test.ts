import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listPulls } from "../src/core/pulls.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createApp, type App } from "../src/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { forksScreen } from "../src/tui/screens/forks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("the terminal's forks screen proposes a fork's work upstream with u", () => {
  let dataDir: string;
  let app: App;
  let parent: Repo;
  let fork: Repo;
  const users: Record<string, User> = {};

  const open = async (who: string, as: User = users[who]!, name = "app") => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: who, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: as },
      { terminal, exitHooks: false },
    );
    tui.start();
    tui.ctx.push(forksScreen(session, tui.ctx, getRepo(app.db, "bob", name)!));
    await settleApp(tui);
    const press = async (keys: string) => {
      terminal.feed(keys);
      await settleApp(tui);
      await Bun.sleep(100);
      await settleApp(tui);
      return tui.screen.toText();
    };
    return { press, text: () => tui.screen.toText(), stop: () => tui.stop?.() };
  };
  const pulls = () => listPulls(app.db, parent.id, { sealed: true, state: "open", limit: 50 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-forks-propose-"));
    app = createApp({ dataDir, port: 0 });
    for (const name of ["alice", "bob", "carol"]) {
      users[name] = must(
        await createUser(app.db, {
          origin: "seed",
          trusted: true,
          username: name,
          email: `${name}@f.dev`,
          password: "a-good-passphrase",
          adminIfFirst: name === "alice",
        }),
      );
      promote(app.db, users[name]!);
    }
    parent = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
    must(await commitToBranch(app, users["alice"]!, parent, { message: "base", files: [{ path: "a.txt", content: "a\n" }] }));
    fork = must(await forkRepo(app, users["bob"]!, parent));
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("nothing ahead: u says so and opens no pull", async () => {
    const t = await open("bob");
    expect(await t.press("u")).toContain("Nothing here is ahead of alice/app.");
    expect(pulls()).toHaveLength(0);
    t.stop();
  });

  test("a writer confirms and one pull opens on the parent; a second u opens that pull", async () => {
    must(await commitToBranch(app, users["bob"]!, fork, { message: "bob work", files: [{ path: "b.txt", content: "b\n" }] }));
    const t = await open("bob");
    const asked = await t.press("u");
    expect(asked).toContain("1 commit ahead would go to alice/app");
    expect(pulls()).toHaveLength(0);
    // cancel leaves it alone
    await t.press("\x1b");
    expect(pulls()).toHaveLength(0);
    await t.press("u");
    const done = await t.press("\x1b[C\r");
    expect(pulls()).toHaveLength(1);
    const n = pulls()[0]!.number;
    expect(done).toContain(`#${n} is open on alice/app`);
    // u again opens the pull rather than making another
    const second = await t.press("u");
    expect(pulls()).toHaveLength(1);
    expect(second).toContain(`#${n} 1 commit from bob/app`);
    t.stop();
    const entered = await open("bob");
    expect(await entered.press("\r")).toContain(`#${n} 1 commit from bob/app`);
    entered.stop();
    const again = await open("bob");
    expect(again.text()).toContain(`#${n} is open on alice/app`);
    await again.press("u");
    expect(pulls()).toHaveLength(1);
    again.stop();
  });

  test("an agent is not offered u, nor a reader", async () => {
    const t = await open("bob", { ...users["bob"]!, kind: "agent" });
    expect(await t.press("u")).not.toContain("would go to");
    t.stop();
  });

  test("a writer who loses write before confirming is told they need it", async () => {
    const lib = must(await createRepo(app, users["alice"]!, { name: "lib", visibility: "public" }));
    must(await commitToBranch(app, users["alice"]!, lib, { message: "base", files: [{ path: "a.txt", content: "a\n" }] }));
    const mine = must(await forkRepo(app, users["bob"]!, lib));
    must(await commitToBranch(app, users["bob"]!, mine, { message: "bob lib", files: [{ path: "b.txt", content: "b\n" }] }));
    // carol writes to bob's fork only as an admin, and stops being one after the confirm shows
    const carol = { ...users["carol"]!, isAdmin: true };
    const t = await open("carol", carol, "lib");
    expect(await t.press("u")).toContain("would go to alice/lib");
    carol.isAdmin = false;
    const said = await t.press("\x1b[C\r");
    expect(said).toContain("You need write access to propose from here.");
    expect(listPulls(app.db, lib.id, { sealed: true, state: "open", limit: 50 })).toHaveLength(0);
    t.stop();
  });

  test("a reader is not offered u", async () => {
    const t = await open("carol");
    const text = await t.press("u");
    expect(text).not.toContain("would go to");
    expect(pulls()).toHaveLength(1);
    t.stop();
  });
});
