/** Flows in the terminal (#9434): the page's gates, from the same reads. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { refreshRadar } from "../src/flows/radar.ts";
import { readPins } from "../src/flows/pins.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("flows in the terminal", () => {
  let dir: string;
  let forge: Forge;
  let ada: User;
  let eve: User;
  let repo: Repo;

  function boot(user: User | undefined) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: k.startsWith("ctrl+"), alt: false, shift: false });
    const press = async (...keys: string[]) => {
      for (const k of keys) key(k.startsWith("ctrl+") ? k.slice(5) : k);
      await settleApp(app);
    };
    const open = async () => {
      await settleApp(app);
      for (const k of ["ctrl+k"]) app.dispatch({ type: "key", key: k.slice(5), ctrl: true, alt: false, shift: false });
      await settleApp(app);
      for (const ch of "Flows of a repository") key(ch);
      await press("enter");
      for (const ch of "ada/arm") key(ch);
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-flows-tui-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    eve = await make("eve", false);
    const made = await createRepo(forge, ada, { name: "arm", owner: "ada", visibility: "public", description: "" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    repo = made.value;
    forge.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at) VALUES ('s1', ?1, 'https://u:tok3n@example.com/x.git', 'main', ?2, '2026-11-01T00:00:00Z')").run(repo.id, ada.id);
    const pkg = JSON.stringify({ dependencies: { leftish: "1.0.0" } });
    const c = await commitFiles(repoDir(forge.reposRoot, "ada", "arm"), { branch: repo.defaultBranch, message: "pins", files: [{ path: "package.json", content: pkg }], author: { name: "T", email: "t@forge.test" } });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    await refreshRadar(forge.db, repo.id, readPins(pkg), async () => ({ latest: "1.4.0", advisory: "high: prototype pollution (+1 more)" }));
  }, 60_000);
  afterAll(async () => {
    forge?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("an admin sees the lines without userinfo and the radar key; a reader does not get the key", async () => {
    const admin = boot(ada);
    await admin.open();
    expect(admin.text()).toContain("example.com/x.git");
    expect(admin.text()).not.toContain("tok3n");
    admin.stop();
    const reader = boot(eve);
    await reader.open();
    expect(reader.text()).toContain("example.com/x.git");
    await reader.press("r");
    expect(reader.text()).toContain("Only an admin of this repository can do this.");
    reader.stop();
  });

  test("a package with an advisory says so, with its text; forks and following forges read as on the page", async () => {
    const kid = await createRepo(forge, ada, { name: "kid", owner: "ada", visibility: "public", description: "" });
    if (!kid.ok) throw new Error(JSON.stringify(kid.error));
    forge.db.query("UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2").run(repo.id, kid.value.id);
    forge.db.exec("PRAGMA foreign_keys = OFF");
    forge.db.query("INSERT INTO token (id, token_hash, user_id, name, scope, created_at) VALUES ('t1', 'h1', ?1, 'proposal:child-forge', 'rw', '2026-11-04T00:00:00Z')").run(ada.id);
    forge.db.query("INSERT INTO proposal_token (token_id, repo_id, child, origin) VALUES ('t1', ?1, 'child-forge', 'https://child.example')").run(repo.id);
    forge.db.exec("PRAGMA foreign_keys = ON");
    const admin = boot(ada);
    await admin.open();
    for (const want of ["leftish", "advisory", "high: prototype pollution (+1 more)", "ada/kid", "fork, told of updates", "child-forge", "forge follows"])
      expect(admin.text()).toContain(want);
    admin.stop();
    const reader = boot(eve);
    await reader.open();
    expect(reader.text()).toContain("advisory");
    expect(reader.text()).not.toContain("child-forge");
    reader.stop();
  });

  test("compare heads is offered to an admin and not to a reader or a guest", async () => {
    const admin = boot(ada);
    await admin.open();
    expect(admin.text()).toContain("compare heads now");
    admin.stop();
    for (const who of [eve, undefined]) {
      const other = boot(who);
      await other.open();
      expect(other.text()).not.toContain("compare heads now");
      await other.press("c");
      expect(other.text()).not.toContain("Compared");
      other.stop();
    }
  });

  test("a private repository shows a guest nothing", async () => {
    forge.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?").run(repo.id);
    const guest = boot(undefined);
    await guest.open();
    expect(guest.text()).not.toContain("example.com/x.git");
    guest.stop();
    forge.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?").run(repo.id);
  });
});
