/**
 * The asked screen narrows as MCP `asked` does (#7303): `s` cycles
 * unshipped → flagged → all, `o` flips oldest/newest, the title says the
 * choice, and each row says its state and stale or flagged in MCP's words.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";
import { tool } from "../src/http/mcp/tools/asked.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { askedLines, askedScreen, type AskedView } from "../src/tui/screens/asked.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const DAY = 86_400_000;
let dir: string;
let app: App;
let alice: User;

const ask = (repoId: string, title: string, daysAgo: number, kind: "issue" | "pull" = "issue", body = "") => {
  const r = createIssue(app.db, { repoId, authorId: alice.id, title, body, kind });
  if (!r.ok) throw new Error(r.error);
  app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(new Date(Date.now() - daysAgo * DAY).toISOString(), r.value.id);
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-asked-view-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  promote(app.db, alice);
  const repo = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const id = repo.value.id;
  ask(id, "Flagged ask", 5);
  const shipped = ask(id, "Shipped ask", 4);
  const pull = ask(id, "Answers it", 4, "pull", `Closes #${shipped.number}`);
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
            VALUES (?1, 'main', 'answer', 'a', 'b', ?2)`)
    .run(pull.id, new Date().toISOString());
  app.db.query("UPDATE issue SET state = 'closed' WHERE id IN (?1, ?2)").run(shipped.id, pull.id);
  ask(id, "Fresh ask", 1);
  // Stale and not flagged: older than the stale window, with an open pull on it.
  const building = ask(id, "Building ask", 6);
  const draft = ask(id, "Works on it", 1, "pull", `Closes #${building.number}`);
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
            VALUES (?1, 'main', 'work', 'a', 'b')`)
    .run(draft.id);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const titles = (view?: AskedView) => askedLines(app.db, alice, view).asks.map((a) => a.title);

/** What MCP `asked` answers for the same choice. */
const mcp = async (args: Record<string, string>) => {
  const answer = await tool.run({ app } as never, alice, args);
  if (!answer.ok) throw new Error(answer.message);
  return (answer.value as { asked: { title: string }[] }).asked.map((a) => a.title);
};

test("the defaults are MCP's: unshipped, oldest first, in the same order", async () => {
  expect(titles()).toEqual(["Building ask", "Flagged ask", "Fresh ask"]);
  expect(titles()).toEqual(await mcp({}));
});

test("each choice of show lists what MCP lists", async () => {
  expect(titles({ show: "flagged", order: "oldest" })).toEqual(["Flagged ask"]);
  expect(titles({ show: "flagged", order: "oldest" })).toEqual(await mcp({ show: "flagged" }));
  // Exactly MCP's order: /asked's grouping would put the shipped ask after the fresh one.
  expect(titles({ show: "all", order: "oldest" })).toEqual(["Building ask", "Flagged ask", "Shipped ask", "Fresh ask"]);
  expect(titles({ show: "all", order: "oldest" })).toEqual(await mcp({ show: "all" }));
  expect(titles({ show: "all", order: "newest" })).toEqual(["Fresh ask", "Shipped ask", "Flagged ask", "Building ask"]);
  expect(titles({ show: "all", order: "newest" })).toEqual(await mcp({ show: "all", order: "newest" }));
});

test("newest first reverses them, as MCP does", async () => {
  expect(titles({ show: "unshipped", order: "newest" })).toEqual(["Fresh ask", "Flagged ask", "Building ask"]);
  expect(titles({ show: "unshipped", order: "newest" })).toEqual(await mcp({ order: "newest" }));
});

test("a row says its state and marks it flagged, in MCP's words", () => {
  const rows = askedLines(app.db, alice, { show: "all", order: "oldest" }).asks;
  const meta = (t: string) => rows.find((r) => r.title === t)!.meta ?? "";
  expect(meta("Flagged ask")).toStartWith("waiting  flagged");
  expect(meta("Fresh ask")).toStartWith("waiting");
  expect(meta("Fresh ask")).not.toContain("flagged");
  expect(meta("Fresh ask")).not.toContain("stale");
  expect(meta("Shipped ask")).toStartWith("shipped");
  expect(meta("Building ask")).toStartWith("building  stale");
  expect(meta("Building ask")).not.toContain("flagged");
});

test("s cycles unshipped, flagged, all and o flips the order, the title saying which", async () => {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(askedScreen(session, tui.ctx));
  await settleApp(tui);
  const screen = () => tui.screen.toText();
  const press = async (key: string) => {
    terminal.feed(key);
    await settleApp(tui);
  };
  expect(screen()).toContain("Asked · not shipped, oldest first");
  expect(screen()).toContain("· 3 asks");
  expect(screen()).not.toContain("asks not shipped");
  expect(screen()).not.toContain("Shipped ask");
  expect(screen().indexOf("Flagged ask")).toBeLessThan(screen().indexOf("Fresh ask"));
  await press("s");
  expect(screen()).toContain("flagged, oldest first");
  expect(screen()).toContain("Flagged ask");
  expect(screen()).not.toContain("Fresh ask");
  await press("s");
  expect(screen()).toContain("all, oldest first");
  expect(screen()).toContain("Shipped ask");
  await press("s");
  await press("o");
  expect(screen()).toContain("not shipped, newest first");
  expect(screen().indexOf("Fresh ask")).toBeLessThan(screen().indexOf("Flagged ask"));
  tui.stop?.();
});
