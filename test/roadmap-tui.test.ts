/** The roadmap in the terminal (#10303): lines from the model, gated like the page. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getRepo } from "../src/core/repos.ts";
import { setHold } from "../src/core/holds.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { roadmapLines } from "../src/tui/screens/roadmap.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { roadmapOf } from "../src/web/roadmap.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("roadmap in the terminal", () => {
  let dir: string;
  let forge: App;
  let ada: User;
  let eve: User;

  function boot(user: User | undefined) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", ...(user ? { user } : {}) };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      async open(spec: string) {
        await settleApp(app);
        app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
        await settleApp(app);
        for (const ch of "Roadmap of") key(ch);
        await settleApp(app);
        key("enter");
        await settleApp(app);
        for (const ch of spec) key(ch);
        key("enter");
        await settleApp(app);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-roadmap-tui-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const make = async (username: string, adminIfFirst: boolean) => {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    eve = await make("eve", false);
    const made = await createRepo(forge, ada, { name: "road", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const mk = (title: string, kind?: "pull") => {
      const i = createIssue(forge.db, { repoId: made.value.id, authorId: ada.id, title, body: "", ...(kind ? { kind } : {}) });
      if (!i.ok) throw new Error(i.error);
      return i.value;
    };
    const umbrella = mk("P0 Trust: contained");
    const work = mk("Startable thing");
    if (!addDependency(forge.db, umbrella, work, ada.id).ok) throw new Error("dep");
    setHold(forge.db, mk("Held pull", "pull").id, ada.id, "look twice");
  }, 30_000);
  afterAll(async () => {
    forge?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a writer's screen names the pillar, its work and what waits on them", async () => {
    const t = boot(ada);
    await t.open("ada/road");
    const text = t.text();
    expect(text).toContain("P0 Trust");
    expect(text).toContain("Startable thing");
    expect(text).toContain("Needs you");
    expect(text).toContain("look twice");
    t.stop();
  });

  test("a reader's screen has the pillars and no Needs you", async () => {
    const t = boot(eve);
    await t.open("ada/road");
    expect(t.text()).toContain("Startable thing");
    expect(t.text()).not.toContain("Needs you");
    t.stop();
  });

  test("lines come from the model", () => {
    const repo = getRepo(forge.db, "ada", "road")!;
    const lines = roadmapLines(roadmapOf(forge.db, repo, ada)!, 80);
    expect(lines[0]).toContain("P0 Trust has no date yet.");
    expect(lines.some((l) => l.includes("Up next"))).toBe(true);
  });
});
