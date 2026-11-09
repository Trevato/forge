/**
 * Atlas in the terminal (#439): the door the API has. A writer opens the
 * repository's "Atlas plan" command, pastes the body the API takes, sees the
 * dry run with nothing opened, and opens the issues with a second ctrl+d —
 * once, however often it is pressed. A reader is offered no command and is
 * refused if the step is reached anyway; a pillar the repository lacks is
 * refused here as at the API.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { atlasCommands, atlasStep } from "../src/tui/screens/atlas.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const body = {
  plan: {
    description: "A bakery that takes orders online and is paid by card.",
    apps: [{ slug: "orders", purpose: "Customers place and track orders" }],
    adapters: [{ system: "Stripe", data: "Card payments" }],
    edges: [{ from: "orders", waitsFor: "Stripe" }],
  },
};

describe("Atlas in the terminal", () => {
  let dataDir: string;
  let forge: Forge;
  let ada: User;
  let bob: User;
  let repo: Repo;
  const issues = () => listIssues(forge.db, repo.id, {});
  const session = (user: User) => new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });

  function boot(user: User) {
    const terminal = headlessTerminal(120, 32);
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
    const paste = async (text: string) => {
      app.dispatch({ type: "paste", text });
      await settleApp(app);
    };
    const open = async () => {
      await settleApp(app);
      await press("ctrl+k");
      await type("Open a repository");
      await press("enter");
      await type("ada/shop");
      await press("enter");
      await press("ctrl+k");
      await type("Atlas plan");
      await press("enter");
    };
    return { text: () => app.screen.toText(), press, paste, open, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-atlas-"));
    forge = createApp({ dataDir, port: 0 });
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    bob = await make("bob", false);
    promote(forge.db, ada, bob);
    const made = await createRepo(forge, ada, { name: "shop", visibility: "public", description: "" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    repo = made.value;
  }, 60_000);

  afterAll(async () => {
    forge?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader is offered no Atlas command, and the step refuses them", () => {
    const f = session(bob);
    expect(atlasCommands(f, {} as Ctx, repo)).toEqual([]);
    expect(atlasStep(f, repo, JSON.stringify(body)).kind).toBe("error");
    expect(atlasCommands(session(ada), {} as Ctx, repo).map((c) => c.id)).toEqual(["atlas-plan"]);
  });

  test("a pillar the repository lacks is refused, as at the API", () => {
    const step = atlasStep(session(ada), repo, JSON.stringify({ ...body, pillar: "P9 Nothing" }));
    expect(step).toMatchObject({ kind: "error" });
    expect(issues().length).toBe(0);
  });

  test("a writer previews, then opens the plan once", async () => {
    const h = boot(ada);
    await h.open();
    await h.paste(JSON.stringify(body));
    await h.press("ctrl+d");
    expect(h.text()).toContain("Dry run: 2 issues");
    expect(h.text()).toContain("App orders");
    expect(issues().length).toBe(0);
    await h.press("ctrl+d");
    expect(h.text()).toContain("opened #");
    expect(issues().length).toBe(2);
    // Again: the same plan is previewed and then found, not opened twice.
    await h.press("ctrl+d", "ctrl+d");
    expect(h.text()).toContain("already opened");
    expect(issues().length).toBe(2);
    h.stop();
  });
});
