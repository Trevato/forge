/** Another forge as an origin, in the terminal: connected by `c`, shown with what it does not carry. */

import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { listOrigins } from "../src/core/origins.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dirs: string[] = [];
let mine: Forge;
let friend: Forge;
let friendServers: Servers;
let friendToken = "";

async function seed(app: Forge, name: string): Promise<void> {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: name,
    email: `${name}@forge.local`,
    password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(made.error);
}

beforeAll(async () => {
  const make = async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-tui-forge-origin-"));
    dirs.push(dir);
    return dir;
  };
  friend = createApp({ dataDir: await make(), port: 0 });
  everyoneIsAMember(friend.db);
  friendServers = await serve(friend);
  await seed(friend, "bob");
  friendToken = createToken(friend.db, getUserByName(friend.db, "bob")!.id, "alice", "ro").token;
  mine = createApp({ dataDir: await make(), port: 0 });
  everyoneIsAMember(mine.db);
  await seed(mine, "alice");
});

afterAll(async () => {
  friendServers.stop();
  mine.close();
  friend.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

test("c connects another forge by address and token, and the list says what did not come", async () => {
  const terminal = headlessTerminal(140, 32);
  const identity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(mine.db, "alice")! } as TuiIdentity;
  const { app } = createForgeApp(mine, identity, { terminal, exitHooks: false });
  app.start();
  const key = async (k: string) => {
    app.dispatch({ type: "key", key: k, ctrl: k === "k", alt: false, shift: false });
    await settleApp(app);
  };
  const type = async (t: string) => {
    for (const ch of t) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  try {
    await key("k");
    await type("Origins");
    await key("enter");
    expect(app.screen.toText()).toContain("Press c to connect one.");
    // A forge has no device sign-in: the terminal says so and points at the page.
    expect(app.screen.toText().replace(/\s+/g, " ")).toContain("Another forge signs in with one click on the web page; here, with a token.");

    await key("c");
    await type(friendServers.url);
    await key("enter");
    expect(app.screen.toText()).toContain("Access token for");
    await type(friendToken);
    expect(app.screen.toText()).not.toContain(friendToken);
    await key("enter");
    expect(app.screen.toText()).toContain("Read-only?");
    await key("enter");
    for (let i = 0; i < 50 && listOrigins(mine.db, getUserByName(mine.db, "alice")!.id).length === 0; i++) await Bun.sleep(100);
    if (listOrigins(mine.db, getUserByName(mine.db, "alice")!.id).length === 0) throw new Error(`never came: still waiting while listOrigins(mine.db, getUserByName(mine.db, "alice")!.id).length === 0`);
    await settleApp(app);

    const [origin] = listOrigins(mine.db, getUserByName(mine.db, "alice")!.id);
    expect(origin?.software).toBe("forge");
    expect(origin?.login).toBe("bob");
    const text = app.screen.toText().replace(/\s+/g, " ");
    expect(text).toContain("another forge");
    expect(text).toContain("Another forge. Code comes across");
    expect(text).not.toContain(friendToken);
  } finally {
    app.stop();
  }
});

test("a token the forge refuses connects nothing and says so", async () => {
  await seed(mine, "carol");
  const carol = getUserByName(mine.db, "carol")!;
  const terminal = headlessTerminal(140, 32);
  const { app } = createForgeApp(mine, { sshUsername: "t", remoteAddress: "127.0.0.1", user: carol } as TuiIdentity, {
    terminal,
    exitHooks: false,
  });
  app.start();
  const press = async (k: string, ctrl = false) => {
    app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(app);
  };
  const type = async (t: string) => {
    for (const ch of t) app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  try {
    await press("k", true);
    await type("Origins");
    await press("enter");
    await press("c");
    await type(friendServers.url);
    await press("enter");
    await type("forge_not_a_token");
    await press("enter");
    await press("enter");
    for (let i = 0; i < 30 && !app.screen.toText().includes("refused"); i++) {
      await Bun.sleep(100);
      await settleApp(app);
    }
    expect(app.screen.toText()).toContain("That token was refused by the origin.");
    expect(listOrigins(mine.db, carol.id)).toHaveLength(0);
  } finally {
    app.stop();
  }
});
