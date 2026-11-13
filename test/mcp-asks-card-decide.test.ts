/**
 * The inbox card decides (#11816): `asks` lists what waits, the card's Decline
 * is a plan whose card carries the page's confirm, pressing it settles with
 * the page's receipt, and the page then shows the result. The token's scope
 * is the only authority: a read-only token plans but cannot confirm.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptSentence } from "../src/actions/asks_words.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssueById, setAssignee } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let rw = "";
let ro = "";
let cookie = "";
let issueId = "";
let owner: any;
let repoRow: any;

const rpc = async (token: string, name: string, args: Record<string, unknown>) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()) as any;
};
const page = async (): Promise<string> =>
  (await (await fetch(`${servers.url}/asks`, { headers: { cookie: `${cookie}; forge_mode=studio` } })).text()).replace(/\s+/g, " ");

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-asks-card-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-long-card-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  rw = createToken(app.db, made.value.id, "rw", "rw").token;
  ro = createToken(app.db, made.value.id, "ro", "ro").token;
  const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-long-card-passphrase" }), redirect: "manual" });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const repo = await createRepo(app, made.value, { name: "inbox", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const issue = openIssue(app, made.value, repo.value, { title: "Wipe the board", body: "" });
  if (!issue.ok) throw new Error(String(issue.error));
  setAssignee(app.db, issue.value.id, made.value.id);
  issueId = issue.value.id;
  owner = made.value;
  repoRow = repo.value;
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("list, plan, confirm from the card, and the page shows the result", async () => {
  const listed = await rpc(rw, "asks", {});
  const row = listed.result.structuredContent.card.rows.find((r: any) => r.actions?.[0]?.args?.items?.includes(`assigned:${issueId}`));
  expect(row.actions[0].label).toBe("Decline");
  expect(await page()).toContain("Wipe the board");

  // Pressing Decline plans: nothing changes, and the card is the page's confirm.
  const press = row.actions[0];
  const planned = await rpc(rw, press.tool, press.args);
  expect(getIssueById(app.db, issueId)!.state).toBe("open");
  const confirm = planned.result.structuredContent.card;
  expect(confirm.title).toBe("Confirm");
  expect(confirm.status).toBe("Close: 1 of 1 · 0 refused or skipped · undo afterwards");
  expect(confirm.rows[0].value).toContain("change");
  expect(confirm.actions.map((a: any) => a.label)).toEqual(["Close 1"]);
  expect(confirm.actions[0].args).toEqual({ action: "close", items: [`assigned:${issueId}`], dryRun: false });

  // A read-only token may plan, but the confirm is refused: the card widens nothing.
  const refused = await rpc(ro, confirm.actions[0].tool, confirm.actions[0].args);
  expect(refused.result.isError).toBe(true);
  expect(getIssueById(app.db, issueId)!.state).toBe("open");

  // Confirming returns the page's receipt and the page shows it.
  const done = await rpc(rw, confirm.actions[0].tool, confirm.actions[0].args);
  const receipt = receiptSentence("close", 1, false);
  expect(JSON.parse(done.result.content[0].text).receipt).toBe(receipt);
  expect(done.result.structuredContent.card.status).toBe(receipt);
  expect(getIssueById(app.db, issueId)!.state).toBe("closed");
  expect(await page()).not.toContain("Wipe the board");
});

test("review: reason, nothing-changes, ok:false, the 100 cap, and the page's words", async () => {
  const fresh = openIssue(app, owner, repoRow, { title: "Second chore", body: "" });
  if (!fresh.ok) throw new Error(String(fresh.error));
  setAssignee(app.db, fresh.value.id, owner.id);
  issueId = fresh.value.id;
  // Box 5: the card's row says what the page says for the same ask.
  const listed = await rpc(rw, "asks", {});
  const row = listed.result.structuredContent.card.rows.find((r: any) => r.actions?.[0]?.args?.items?.includes(`assigned:${issueId}`));
  const html = await page();
  expect(row.label).toContain("Second chore");
  expect(html).toContain("Second chore");
  expect(row.label.toLowerCase()).toContain("assigned to you");
  expect(html).toContain("Assigned to you");

  // Box 1: a reason rides on the Confirm args.
  const withReason = await rpc(rw, "asks_act", { action: "close", items: [`assigned:${issueId}`], reason: "not now" });
  const c1 = withReason.result.structuredContent.card;
  expect(c1.actions[0].args).toEqual({ action: "close", items: [`assigned:${issueId}`], reason: "not now", dryRun: false });

  // Box 2: nothing changes -> skipped rows, the count, no button.
  const none = await rpc(rw, "asks_act", { action: "close", items: ["assigned:nosuchask"] });
  const c2 = none.result.structuredContent.card;
  expect(c2.actions).toEqual([]);
  expect(c2.status).toMatch(/^Close: 0 of 1 · [1-9]\d* refused or skipped · /);
  expect(c2.status).not.toContain("NaN");
  expect(c2.rows.length).toBeGreaterThan(0);

  // Box 3: a refused plan returns the error and no card.
  const bad = await rpc(rw, "asks_act", { action: "close", items: [] });
  expect(bad.result.isError).toBe(true);
  expect(bad.result.structuredContent?.card).toBeUndefined();

  // Box 4: the confirm hands back at most 100 items, none empty.
  const { cardFor } = await import("../src/web/studio/cards.ts");
  const many = Array.from({ length: 150 }, (_, n) => (n % 10 === 0 ? "" : `assigned:x${n}`));
  const plan = { counts: { change: 1, refused: 0 }, rows: [{ label: "a", before: "x", after: "y", outcome: "change" }], skipped: [], reversible: true };
  const capped = cardFor("asks_act", plan, "", { action: "close", items: many })!;
  const sent = capped.actions[0]!.args!["items"] as string[];
  expect(sent.length).toBe(100);
  expect(sent.includes("")).toBe(false);
  // A missing `refused` count never prints NaN.
  const noCount = cardFor("asks_act", { ...plan, counts: { change: 1 } }, "", { action: "close", items: ["assigned:a"] })!;
  expect(noCount.status).toContain("0 refused or skipped");
});
