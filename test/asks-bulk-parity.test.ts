/**
 * The same action has the same shape for a person and an agent (#10700):
 * settling three asks and undoing them says one sentence, from
 * src/actions/asks_words.ts, on the web form, in the terminal and over MCP;
 * each door's undo restores exactly those three, and a second undo is
 * refused in the same words. The asks are seeded directly: the doors
 * authenticate differently, the deed does not.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAsksBulk, receiptOf } from "../src/actions/asks_bulk.ts";
import { ALREADY_UNDONE, NO_SUCH_OPERATION, receiptSentence } from "../src/actions/asks_words.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssueById, setAssignee } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

const PASSWORD = "a-long-parity-passphrase";
const SETTLED = receiptSentence("close", 3, false);
const UNDONE = receiptSentence("close", 3, true);

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let token = "";
let cookie = "";
let repoRow: Repo;
let round = 0;

/** Five open asks assigned to alice; the first three are the selection. */
function seed(): { picked: string[]; others: string[]; all: string[] } {
  round++;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const made = openIssue(app, alice, repoRow, { title: `Ask ${round}.${i}`, body: "" });
    if (!made.ok) throw new Error(String(made.error));
    setAssignee(app.db, made.value.id, alice.id);
    ids.push(made.value.id);
  }
  return { picked: ids.slice(0, 3), others: ids.slice(3), all: ids };
}

const states = (ids: string[]): string[] => ids.map((id) => getIssueById(app.db, id)!.state);
const items = (ids: string[]): string[] => ids.map((id) => `assigned:${id}`);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-asks-parity-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: PASSWORD,
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  token = createToken(app.db, alice.id, "rw", "rw").token;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: PASSWORD }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const repo = await createRepo(app, alice, { name: "parity", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoRow = repo.value;
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the sentence reads as it always has", () => {
  expect(SETTLED).toBe("Close: 3 done");
  expect(UNDONE).toBe("Close undone: 3");
});

test("the web form settles three asks, undoes them, and refuses a second undo", async () => {
  const { picked, others } = seed();
  const headers = { cookie: `${cookie}; forge_mode=studio`, origin: servers.url };
  const post = async (path: string, fields: [string, string][]): Promise<{ page: string; location: string }> => {
    const res = await fetch(`${servers.url}${path}`, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    const target = res.status === 303 ? await fetch(`${servers.url}${location}`, { headers, redirect: "manual" }) : res;
    return { page: (await target.text()).replace(/\s+/g, " "), location };
  };
  const done = await post("/asks/bulk", [
    ["action", "close"],
    ["apply", "1"],
    ["reason", "done"],
    ...items(picked).map((i): [string, string] => ["item", i]),
  ]);
  expect(done.page).toContain(`>${SETTLED}<`);
  expect(states(picked)).toEqual(["closed", "closed", "closed"]);
  expect(states(others)).toEqual(["open", "open"]);
  const op = done.location.match(/op=([^#]+)/)![1]!;
  const undone = await post(`/asks/bulk/${op}/undo`, []);
  expect(undone.page).toContain(`>${UNDONE}<`);
  expect(states(picked)).toEqual(["open", "open", "open"]);
  expect(states(others)).toEqual(["open", "open"]);
  const again = await post(`/asks/bulk/${op}/undo`, []);
  expect(again.page).toContain(ALREADY_UNDONE);
  expect(states(picked)).toEqual(["open", "open", "open"]);
});

test("MCP asks_act settles three asks, undoes them, and refuses a second undo", async () => {
  const { picked, others } = seed();
  const dry = await mcpTool(servers.url, token, "asks_act", { action: "close", items: items(picked), reason: "done" });
  expect(dry.value.receipt).toBeUndefined();
  expect(states(picked)).toEqual(["open", "open", "open"]);
  const done = await mcpTool(servers.url, token, "asks_act", { action: "close", items: items(picked), reason: "done", dryRun: false });
  expect(done.value.receipt).toBe(SETTLED);
  expect(states(picked)).toEqual(["closed", "closed", "closed"]);
  expect(states(others)).toEqual(["open", "open"]);
  const planned = await mcpTool(servers.url, token, "asks_act", { action: "undo", operation: done.value.id });
  expect(planned.value.wouldUndo).toBe(done.value.id);
  expect(states(picked)).toEqual(["closed", "closed", "closed"]);
  const undone = await mcpTool(servers.url, token, "asks_act", { action: "undo", operation: done.value.id, dryRun: false });
  expect(undone.value.receipt).toBe(UNDONE);
  expect(states(picked)).toEqual(["open", "open", "open"]);
  expect(states(others)).toEqual(["open", "open"]);
  const again = await mcpTool(servers.url, token, "asks_act", { action: "undo", operation: done.value.id, dryRun: false });
  expect(again.error).toContain(ALREADY_UNDONE);
});

test("MCP asks_act plans no undo for an operation that is not there", async () => {
  const planned = await mcpTool(servers.url, token, "asks_act", { action: "undo", operation: "no-such-operation" });
  expect(planned.value).toBeUndefined();
  expect(planned.error).toContain(NO_SUCH_OPERATION);
});

test("the terminal's bulk screen names the same receipt and undoes in the same words", async () => {
  const { picked, others } = seed();
  const op = await applyAsksBulk(app, alice, "close", items(picked), "done");
  if (!op.ok) throw new Error(op.error.message);
  expect(receiptOf(op.value)).toBe(SETTLED);
  expect(states(picked)).toEqual(["closed", "closed", "closed"]);
  const terminal = headlessTerminal(140, 32);
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: getUserByName(app.db, "alice")! },
    { terminal, exitHooks: false },
  );
  tui.start();
  const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  const press = async (...keys: string[]) => {
    keys.forEach((k) => key(k));
    await settleApp(tui);
  };
  try {
    key("k", true);
    await settleApp(tui);
    for (const ch of "Bulk actions") key(ch);
    key("enter");
    await settleApp(tui);
    await press("enter");
    expect(tui.screen.toText()).toContain(SETTLED);
    await press("esc");
    await press("u");
    await settleUntil(tui, UNDONE);
    expect(states(picked)).toEqual(["open", "open", "open"]);
    expect(states(others)).toEqual(["open", "open"]);
    await press("j", "u");
    expect(tui.screen.toText()).toContain(ALREADY_UNDONE);
    expect(states(picked)).toEqual(["open", "open", "open"]);
  } finally {
    tui.stop();
  }
});
