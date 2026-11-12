/**
 * The terminal's variants screen (src/tui/screens/variants.ts): the board the
 * page draws, behind the same gates. A reader sees the variants and no
 * controls; a writer registers a branch, sets and drops a value, and retires
 * after a confirm; an agent changes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { variantValues } from "../src/actions/app_variants.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { listVariants } from "../src/core/variants.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

const RIGHT = "\x1b[C";
const open = [":", "Variants", "\r"];

let dir: string;
let app: App;
let alice: User;
let reader: User;
let scout: User;
let shop: Repo;

const variants = () => listVariants(app.db, getAppByRepo(app.db, shop.id)!.id);

async function drive(user: User, keys: string[], until?: string): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, shop)));
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
  }
  // A save commits to the branch: wait for the note it ends in, not for a frame.
  for (let i = 0; until !== undefined && i < 100 && !tui.screen.toText().includes(until); i++) {
    await new Promise((r) => setTimeout(r, 30));
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-variants-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  reader = await mk("rita");
  proveAll(app);
  const made = await newApp(app, alice, { name: "shop", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  shop = getRepo(app.db, alice.username, "shop")!;
  const c = await commitToBranch(app, alice, shop, {
    branch: "print", base: "main", message: "print", files: [{ path: "note.txt", content: "x" }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const agent = await createAgent(app, alice, { username: "scout", brief: "I ship." });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, shop, "scout").ok).toBe(true);
  scout = getUserByName(app.db, "scout")!;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the terminal's variants screen", () => {
  test("a reader is offered the screen, sees no controls, and changes nothing", async () => {
    const text = await drive(reader, [...open, "r"]);
    expect(text).toContain("No variants yet.");
    expect(text).not.toContain("Press r");
    expect(text).not.toContain("Run a branch as a variant");
    expect(variants()).toEqual([]);
  });

  test("an agent is not offered the controls either", async () => {
    const text = await drive(scout, [...open, "r"]);
    expect(text).not.toContain("Run a branch as a variant");
    expect(variants()).toEqual([]);
  });

  test("a writer registers a branch, and a missing one is refused in the page's words", async () => {
    const refused = await drive(alice, [...open, "r", "nope", "\r", "\r"]);
    expect(refused).toContain("That branch does not exist in this repository.");
    expect(variants()).toEqual([]);
    const text = await drive(alice, [...open, "r", "print", "\r", "\r"]);
    expect(text).toContain("Running print as the print variant.");
    expect(variants().map((v) => [v.label, v.branch])).toEqual([["print", "print"]]);
  });

  test("s sets a value onto the branch's variant.json, u drops it", async () => {
    const text = await drive(alice, [...open, "s", "PRINT=true", "\r"], "PRINT is set for print.");
    expect(text).toContain("PRINT is set for print.");
    const v = variants()[0]!;
    expect(await variantValues(app, shop, v)).toEqual({ PRINT: "true" });
    const bad = await drive(alice, [...open, "s", "PORT=1", "\r"]);
    expect(bad).toContain("PORT");
    expect(await variantValues(app, shop, v)).toEqual({ PRINT: "true" });
    await drive(alice, [...open, "u", "PRINT", "\r"], "PRINT is dropped from print.");
    expect(await variantValues(app, shop, v)).toEqual({});
  });

  test("m opens the pull that makes it main", async () => {
    const text = await drive(alice, [...open, "m"]);
    expect(text).toMatch(/Pull #\d+ makes print main/);
  });

  test("x asks first; keeping it leaves it, confirming retires it", async () => {
    const asked = await drive(alice, [...open, "x"]);
    expect(asked).toContain("Retire this variant");
    expect(variants().length).toBe(1);
    await drive(alice, [...open, "x", "\r"]);
    expect(variants().length).toBe(1);
    const text = await drive(alice, [...open, "x", RIGHT, "\r"]);
    expect(variants()).toEqual([]);
    expect(text).toContain("print is retired.");
  });
});
