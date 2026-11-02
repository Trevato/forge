/**
 * "New forge" in the terminal (#1782): the page's fields through `spawnDoor`,
 * the plan before the spawn, the claim link once, any signed-in person's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { newForgeScreen } from "../src/tui/screens/newforge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let admin: User;
let bob: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});
const NAME_REASON = "name must be 1-39 characters of a-z";
const BUDGET_REASON = "a budget is for a model key";
const children = async () => (await readdir(join(dir, "spawn")).catch(() => [] as string[])).length;

function open(user: User) {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(newForgeScreen(session, tui.ctx));
  return { tui, terminal };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-newforge-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const mk = async (username: string, isAdmin: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", isAdmin,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  admin = await mk("alice", true);
  bob = await mk("bob", false);
  const repo = await createRepo(app, admin, { name: "bakery", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  useProbe(app, () => async () => true);
  usePlacement(app, hostedPlacement({ host: "forge.test" }));
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Open the screen, run `body`, and always stop the terminal. */
async function withScreen(user: User, body: (h: ReturnType<typeof open>) => Promise<void>) {
  const h = open(user);
  try {
    await settleApp(h.tui);
    await body(h);
  } finally {
    h.tui.stop?.();
  }
}

describe("the new forge screen", () => {
  test("the palette offers it to any signed-in person, as the page is", () => {
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
    expect(ids(admin)).toContain("new-forge");
    expect(ids(bob)).toContain("new-forge");
    expect(ids()).not.toContain("new-forge");
  });

  test("the screen and its plan promise no update that does not happen", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      const form = tui.screen.toText();
      expect(form).toContain("tell-me (default) tells the owner in their inbox");
      terminal.feed("kai\x10");
      await settleApp(tui);
      const text = form + tui.screen.toText();
      expect(tui.screen.toText()).toContain("It follows this forge's code as tell-me: it tells the owner in their inbox");
      expect(text).not.toMatch(/recorded for now/i);
      expect(text).not.toMatch(/keeps? (itself )?up to date|updates itself|automatically/i);
    }));

  test("the plan is shown first and makes nothing; enter spawns and shows the claim link once", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      const before = await children();
      terminal.feed("kai\t\t\talice/bakery\r");
      terminal.feed("\x10"); // ctrl+p
      await settleApp(tui);
      const plan = tui.screen.toText();
      expect(plan).toContain("The plan");
      expect(plan).toContain("kai--forge.test");
      expect(await children()).toBe(before);
      terminal.feed("\r");
      await settleApp(tui);
      expect(await children()).toBe(before + 1);
      expect(tui.screen.toText()).toMatch(/https:\/\/kai--forge\.test\/claim#/);
    }));

  test("the door's refusal lands on the field it names, with focus there, and nothing is made", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      const before = await children();
      terminal.feed("Bad Name!\t\t\t"); // focus on "Apps to fork", name is wrong
      terminal.feed("\x10");
      await settleApp(tui);
      const text = tui.screen.toText();
      expect(text).not.toContain("The plan");
      expect(text).toContain(NAME_REASON);
      terminal.feed("Z"); // focus went back to Name
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Bad Name!Z");
      expect(await children()).toBe(before);
    }));

  test("a key without a budget is refused by the door, naming the budget", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      const before = await children();
      terminal.feed("lee\t\t\t\t\tsk-ant-api03-child-key-AAAAAAAAAAAAAAAAAAAAAAAA\x10");
      await settleApp(tui);
      const text = tui.screen.toText();
      expect(text).not.toContain("The plan");
      expect(text).toContain("budget");
      expect(text).not.toContain("sk-ant-api03");
      expect(await children()).toBe(before);
    }));

  test("a budget without a key is refused, with the door's reason", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      const before = await children();
      terminal.feed("max\t\t\t\t\t\t\t5\x10");
      await settleApp(tui);
      const text = tui.screen.toText();
      expect(text).not.toContain("The plan");
      expect(text).toContain(BUDGET_REASON);
      expect(await children()).toBe(before);
    }));

  test("a refused key is cleared from the form", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      terminal.feed("Bad Name!\t\t\t\t\tsk-ant-api03-child-key-AAAAAAAAAAAAAAAAAAAAAAAA\x10");
      await settleApp(tui);
      terminal.feed("\t\t\t\t\t"); // back to the key field, past the name
      await settleApp(tui);
      expect(tui.screen.toText()).not.toContain("••••");
    }));

  test("a person who is not an admin gets a plan and spawns, as on the page", () =>
    withScreen(bob, async ({ tui, terminal }) => {
      const before = await children();
      terminal.feed("zed");
      terminal.feed("\x10");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("The plan");
      expect(await children()).toBe(before);
      terminal.feed("\r");
      await settleApp(tui);
      expect(await children()).toBe(before + 1);
      expect(tui.screen.toText()).toMatch(/https:\/\/zed--forge\.test\/claim#/);
    }));

  test("the follow mode is a field: take-updates reaches parent.json", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      (app.config as { forgeRepo?: string }).forgeRepo = "alice/bakery";
      try {
        terminal.feed("tuifollow" + "\t".repeat(8) + "take-updates\x10");
        await settleApp(tui);
        expect(tui.screen.toText()).toContain("take-updates");
        terminal.feed("\r");
        await settleApp(tui);
        const docs = await Promise.all(
          (await readdir(join(dir, "children"))).map((d) =>
            Bun.file(join(dir, "children", d, "parent.json")).json().catch(() => undefined),
          ),
        );
        expect(docs.find((d) => d?.name === "tuifollow")?.forgeCode?.mode).toBe("take-updates");
      } finally {
        delete (app.config as { forgeRepo?: string }).forgeRepo;
      }
    }));

  test("the size is a field: medium reaches parent.json, small is not sent", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      terminal.feed("tuisize" + "\t".repeat(9) + "medium\x10");
      await settleApp(tui);
      terminal.feed("\r");
      await settleApp(tui);
      const docs = await Promise.all(
        (await readdir(join(dir, "children"))).map((d) =>
          Bun.file(join(dir, "children", d, "parent.json")).json().catch(() => undefined),
        ),
      );
      expect(docs.find((d) => d?.name === "tuisize")?.size).toBe("medium");
    }));

  test("Blank is the default: the plan names no template", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      terminal.feed("tuiblank" + "\t".repeat(10));
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Only the apps you fork");
      terminal.feed("\x10");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("The plan");
      expect(tui.screen.toText()).not.toContain("Template:");
    }));

  test("choosing starter shows its sentence and the plan names it", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      terminal.feed("tuistart" + "\t".repeat(10) + "\x1b[C"); // right arrow
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("A server, a page, tests and a forge.json");
      terminal.feed("\x10");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Template: Starter app.");
    }));

  test("an unknown template is refused beside the field", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      terminal.feed("tuitpl" + "\t".repeat(10) + "nope\x10");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("template must be blank or starter");
    }));

  test("an unknown size is refused beside the field", () =>
    withScreen(admin, async ({ tui, terminal }) => {
      terminal.feed("tuibig" + "\t".repeat(9) + "huge\x10");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("size must be small, medium or large");
    }));
});
