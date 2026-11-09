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
import { openIssue } from "../src/actions/issues.ts";
import { createLabel, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { labelsFor } from "../src/core/issues.ts";
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

test("the screen shows the same grammar as the web page, fields per kind (#566)", async () => {
  const t = boot(getUserByName(forge.db, "alice"));
  await t.select("run cost:abc");
  expect(t.text()).toContain("cost wants a number");
  expect(t.text()).toContain("a comma means any of");
  expect(t.text()).toMatch(/run +repo, [^\n]*cost, created/);
  expect(t.text()).toContain("e.g. run state:queued,running cost:>0.5");
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

test("v previews a verb, Apply writes it, u undoes it; a guest is offered none of it", async () => {
  const alice = getUserByName(forge.db, "alice")!;
  const repo = await createRepo(forge, alice, { name: "board", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  createLabel(forge, alice, repo.value, "urgent", "ff0000");
  const issue = openIssue(forge, alice, repo.value, { title: "Fix it" });
  if (!issue.ok) throw new Error(String(issue.error));
  const names = () => labelsFor(forge.db, issue.value.id).map((l) => l.name);

  const t = boot(alice);
  await t.select("issue repo:alice/board");
  await t.key("v");
  for (const ch of "label urgent") await t.key(ch);
  await t.key("enter");
  expect(t.text()).toContain("Preview: label");
  expect(t.text()).toContain("none -> urgent");
  expect(names()).toEqual([]);
  await t.key("enter");
  await Bun.sleep(20);
  await t.key("j");
  expect(names()).toEqual(["urgent"]);
  expect(t.text()).toContain("Applied");
  await t.key("u");
  await t.key("enter");
  await Bun.sleep(20);
  await t.key("j");
  expect(names()).toEqual([]);
  expect(t.text()).toContain("Undone.");

  const guest = boot(undefined);
  await guest.select("issue repo:alice/board");
  await guest.key("v");
  expect(guest.text()).not.toContain("Verb");
  expect(names()).toEqual([]);
});

test("x marks the top row in view; v then acts on the marked rows alone, and says so", async () => {
  const alice = getUserByName(forge.db, "alice")!;
  const repo = await createRepo(forge, alice, { name: "marks", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  createLabel(forge, alice, repo.value, "urgent", "ff0000");
  const ids = ["One", "Two", "Three"].map((title) => {
    const made = openIssue(forge, alice, repo.value, { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value.id;
  });
  const labelled = () => ids.map((id) => labelsFor(forge.db, id).map((l) => l.name));

  const t = boot(alice);
  await t.select("issue repo:alice/marks");
  await t.key("j");
  await t.key("x");
  expect(t.text()).toContain("3 rows, 1 marked");
  expect(t.text()).toMatch(/>\* alice\/marks\s+2\s+Two/);
  await t.key("v");
  for (const ch of "label urgent") await t.key(ch);
  await t.key("enter");
  expect(t.text()).toContain("1 picked of 3");
  expect(t.text()).toContain("Apply to 1 row");
  await t.key("enter");
  await Bun.sleep(20);
  await t.key("k");
  expect(labelled()).toEqual([[], ["urgent"], []]);

  // x again on the same row unmarks it.
  await t.key("j");
  await t.key("x");
  expect(t.text()).toContain("3 rows  ");
  expect(t.text()).not.toContain("marked");

  const guest = boot(undefined);
  await guest.select("issue repo:alice/marks");
  await guest.key("x");
  expect(guest.text()).not.toContain("marked");
});

test("fleetLines leads each row with its mark and the row x would mark", () => {
  const rows = [
    { id: "a", repo: "o/r", number: 1, title: "A", state: "open", assignee: "" },
    { id: "b", repo: "o/r", number: 2, title: "B", state: "open", assignee: "" },
  ];
  const [head, first, second] = fleetLines("issue", rows, undefined, { ids: new Set(["b"]), at: 0 });
  expect(head!.startsWith("   ")).toBe(true);
  expect(first!.startsWith(">  o/r")).toBe(true);
  expect(second!.startsWith(" * o/r")).toBe(true);
  expect(fleetLines("issue", rows, undefined)[1]!.startsWith("o/r")).toBe(true);
});
