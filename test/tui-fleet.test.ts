/**
 * The terminal's fleet rows (#565): the palette's "Fleet rows" asks for a
 * query line and shows the rows `viewFleet` selects — the web page's read,
 * so a private repository is absent for a guest and present for its owner;
 * a line that does not parse keeps the prompt open with its error; `s`
 * sorts by the next column and `r` reverses it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { fleetLines, nextSort } from "../src/tui/screens/fleet.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;

function boot(user: User | undefined) {
  const { app } = createForgeApp(
    forge,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 32), exitHooks: false },
  );
  app.start();
  const key = async (k: string, ctrl = false) => {
    app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(app);
  };
  const type = async (text: string) => {
    for (const ch of text) await key(ch);
  };
  return {
    text: () => app.screen.toText(),
    key,
    /** Open "Fleet rows" from the palette and submit `line`. */
    select: async (line: string) => {
      await key("k", true);
      await type("Fleet rows");
      await key("enter");
      await type(line);
      await key("enter");
    },
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-fleet-"));
  forge = createApp({ dataDir, port: 0 });
  for (const [name, admin] of [["root", true], ["alice", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: name,
      allowReserved: true,
      email: `${name}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: admin,
    });
    if (!made.ok) throw new Error(made.error);
    promote(forge.db, made.value);
  }
  const alice = getUserByName(forge.db, "alice")!;
  for (const [name, visibility] of [["engine", "private"], ["tools", "public"], ["atlas", "public"]] as const) {
    const made = await createRepo(forge, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
  }
}, 30_000);

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the owner sees all three rows; a guest does not see the private one", async () => {
  const owner = boot(getUserByName(forge.db, "alice"));
  await owner.select("repo owner:alice");
  expect(owner.text()).toContain("3 rows");
  for (const name of ["alice/engine", "alice/tools", "alice/atlas"]) expect(owner.text()).toContain(name);

  const guest = boot(undefined);
  await guest.select("repo owner:alice");
  expect(guest.text()).toContain("2 rows");
  expect(guest.text()).not.toContain("alice/engine");
  expect(guest.text()).toContain("alice/tools");
});

test("a line that does not parse keeps the prompt open with its error", async () => {
  const t = boot(getUserByName(forge.db, "alice"));
  await t.select("repo spent:4");
  expect(t.text()).toContain('repo has no field "spent"');
  expect(t.text()).toContain("Fleet query");
});

test("s sorts by the next column, r reverses it", async () => {
  const t = boot(getUserByName(forge.db, "alice"));
  await t.select("repo owner:alice");
  const order = () =>
    ["alice/atlas", "alice/engine", "alice/tools"].sort((a, b) => t.text().indexOf(a) - t.text().indexOf(b));
  await t.key("s");
  expect(t.text()).toContain("repository ^");
  expect(order()).toEqual(["alice/atlas", "alice/engine", "alice/tools"]);
  await t.key("r");
  expect(t.text()).toContain("repository v");
  expect(order()).toEqual(["alice/tools", "alice/engine", "alice/atlas"]);
});

test("fleetLines draws a header and one line a row, in the shared columns", () => {
  const lines = fleetLines(
    "issue",
    [
      { id: "a", repo: "o/r", number: 2, title: "second", state: "open", assignee: "" },
      { id: "b", repo: "o/r", number: 1, title: "first", state: "open", assignee: "bo" },
    ],
    { key: "number", descending: false },
  );
  expect(lines[0]).toMatch(/^repository\s+# \^\s+title\s+state\s+assignee$/);
  expect(lines[1]).toContain("first");
  expect(lines[2]).toMatch(/second\s+open\s+-$/);
  expect(nextSort("issue", undefined)).toEqual({ key: "repo", descending: false });
  expect(nextSort("issue", { key: "assignee", descending: true })).toEqual({ key: "repo", descending: false });
});
