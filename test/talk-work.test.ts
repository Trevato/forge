/**
 * /talk shows the agent's work (#8821): thinking folded to one line, a steps
 * line, and links to what a turn opened or changed, from a recorded run's events.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { appendTurn, listTurns, openConversation } from "../src/core/conversations.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { CHANGES, LINKS_MAX, lookupFrom, workBefore, workOf, worksOf } from "../src/core/talk_work.ts";
import { createUser } from "../src/core/users.ts";
import { say, withHistory, type ConversationOptions } from "../src/crew/conversation.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { turnHtml } from "../src/web/pages/talk.ts";
import { promote } from "./helpers/members.ts";

let dir: string;
let app: App;
let userId: string;
let servers: Servers;
let cookie: string;
let repoId: string;

const options = (binary: string): ConversationOptions => ({ binary, localUrl: "http://127.0.0.1:9", budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });

/** The events of a recorded run, replayed by a fake `claude`. */
const EVENTS = [
  { type: "system", subtype: "init", session_id: "s", model: "fake" },
  { type: "assistant", session_id: "s", message: { id: "1", content: [{ type: "thinking", thinking: "I should <b>look</b> first." }, { type: "tool_use", name: "mcp__forge__read_file", input: { repo: "alice/x", path: "src/a.ts" } }] } },
  { type: "assistant", session_id: "s", message: { id: "2", content: [{ type: "tool_use", name: "mcp__forge__read_file", input: { repo: "alice/x", path: "src/b.ts" } }, { type: "tool_use", name: "mcp__forge__issue", input: { repo: "alice/x", number: 12 } }, { type: "tool_use", name: "mcp__forge__read_file", input: { repo: "../evil", path: "../../etc" } }] } },
  { type: "assistant", session_id: "s", message: { id: "3", content: [{ type: "text", text: "Done." }] } },
  { type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0, num_turns: 1, session_id: "s", terminal_reason: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-talk-work-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  userId = a.value.id;
  promote(app.db, a.value);
  servers = await serve(app);
  cookie = `forge_session=${createSession(app.db, a.value.id).token}`;
  const repo = await createRepo(app, a.value, { name: "x", visibility: "public" });
  if (!repo.ok) throw new Error(repo.error);
  repoId = repo.value.id;
  const made = await commitToBranch(app, a.value, repo.value, { message: "start", files: [{ path: "README.md", content: "# x\n" }] });
  if (!made.ok) throw new Error("commit");
});
afterAll(async () => {
  servers.stop();
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("a recorded run's thinking, steps and links are drawn under the reply", async () => {
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nIFS= read -r first\n${EVENTS.map((e) => `echo '${JSON.stringify(e)}'`).join("\n")}\n`);
  chmodSync(path, 0o755);
  const said = say(app, options(path), userId, "look at it");
  if (!said.ok) throw new Error(said.error);
  await said.value.done;
  const conversation = openConversation(app.db, userId);
  const listed = listTurns(app.db, userId, conversation.id);
  if (!listed.ok) throw new Error("turns");
  const turns = listed.value;
  const thought = turns.find((t) => t.text.startsWith('{"thinking"'));
  expect(thought).toBeDefined();
  const folded = turnHtml(thought!, new Set()).text;
  expect(folded).toContain("<details><summary>Thinking");
  expect(folded).not.toContain("<details open");
  expect(folded).toContain("I should &lt;b&gt;look&lt;/b&gt; first.");
  const at = turns.findIndex((t) => t.role === "agent");
  const reply = turnHtml(turns[at]!, new Set(), undefined, undefined, workBefore(turns, at, lookupFrom(app.db))).text;
  // The read with a bad repo and path still counts as a file read, with no link.
  expect(reply).toContain("read 3 files, opened #12");
  expect(reply).toContain('href="/alice/x/blob/main/src/a.ts"');
  expect(reply).toContain('href="/alice/x/issues/12"');
  expect(reply).not.toContain("evil");
});

test("a reply with no tool calls before it has no steps line", () => {
  const turn = { id: "1", conversationId: "c", role: "agent", text: "hi", createdAt: new Date().toISOString(), replaced: false, failed: false } as const;
  const html = turnHtml(turn, new Set(), undefined, undefined, workBefore([turn], 0)).text;
  expect(html).not.toContain("talk-steps");
});

const call = (tool: string, args: object) => ({ role: "tool", text: `mcp__forge__${tool} ${JSON.stringify(args)}` });

test("a link without a ref points at the default branch, and that route answers", async () => {
  const work = workOf([call("read_file", { repo: "alice/x", path: "README.md" })], lookupFrom(app.db));
  expect(work?.links).toEqual([{ href: "/alice/x/blob/main/README.md", label: "alice/x/README.md" }]);
  const res = await fetch(servers.url + work!.links[0]!.href, { headers: { cookie } });
  expect(res.status).toBe(200);
  // A repo nobody knows has no default branch, so no file link is drawn for it.
  expect(workOf([call("read_file", { repo: "alice/none", path: "a.ts" })], lookupFrom(app.db))?.links).toEqual([]);
  // A write names its branch.
  expect(workOf([call("write_file", { repo: "alice/x", branch: "feat", path: "a.ts" })])?.links[0]?.href).toBe("/alice/x/blob/feat/a.ts");
});

test("a pull and an app are links; one other kind of call is named", () => {
  const pull = workOf([call("pull", { repo: "alice/x", number: 4 })]);
  expect(pull?.links).toEqual([{ href: "/alice/x/pulls/4", label: "alice/x #4" }]);
  expect(pull?.steps).toBe("opened #4");
  const app1 = workOf([call("new_app", { repo: "alice/x" })]);
  expect(app1?.links).toEqual([{ href: "/alice/x", label: "alice/x" }]);
  expect(app1?.steps).toBe("new app");
  expect(workOf([call("runs", {}), call("crew", {})])?.steps).toBe("2 other steps");
});

test("links stop at LINKS_MAX", () => {
  const calls = Array.from({ length: LINKS_MAX + 5 }, (_, i) => call("issue", { repo: "alice/x", number: i + 1 }));
  expect(workOf(calls)?.links).toHaveLength(LINKS_MAX);
});

test("a call cut at the stored length is a step with no link", () => {
  const work = workOf([{ role: "tool", text: 'mcp__forge__read_file {"repo":"alice/x","pa' }]);
  expect(work?.links).toEqual([]);
  expect(work?.steps).toBe("read 1 file");
});

test("a thought is kept to 4,000 characters", async () => {
  const path = join(dir, "claude-long");
  const long = { type: "assistant", session_id: "s", message: { id: "1", content: [{ type: "thinking", thinking: "x".repeat(10_000) }, { type: "text", text: "ok" }] } };
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nIFS= read -r first\necho '${JSON.stringify(long)}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0,"num_turns":1,"session_id":"s","usage":{"input_tokens":1,"output_tokens":1}}'\n`);
  chmodSync(path, 0o755);
  const said = say(app, options(path), userId, "think long");
  if (!said.ok) throw new Error(said.error);
  await said.value.done;
  const conversation = openConversation(app.db, userId);
  const listed = listTurns(app.db, userId, conversation.id);
  if (!listed.ok) throw new Error("turns");
  const mine = listed.value.filter((t) => t.text.startsWith('{"thinking"')).at(-1)!;
  expect(JSON.parse(mine.text).thinking).toHaveLength(4_000);
});

test("history replayed to a new session leaves a thought out", () => {
  const conversation = openConversation(app.db, userId);
  appendTurn(app.db, userId, conversation.id, { role: "tool", text: JSON.stringify({ thinking: "secret musings" }) });
  appendTurn(app.db, userId, conversation.id, { role: "tool", text: 'mcp__forge__issue {"repo":"alice/x","number":3}' });
  const prompt = withHistory(app, conversation, "and now?");
  expect(prompt).not.toContain("secret musings");
  expect(prompt).not.toContain('{"thinking"');
  expect(prompt).toContain("mcp__forge__issue");
});

test("the stream draws a reply with the same steps and links as the page", async () => {
  const conversation = openConversation(app.db, userId);
  appendTurn(app.db, userId, conversation.id, { role: "person", text: "what is open" });
  appendTurn(app.db, userId, conversation.id, { role: "tool", text: 'mcp__forge__issue {"repo":"alice/x","number":7}' });
  const reply = appendTurn(app.db, userId, conversation.id, { role: "agent", text: "Seven is open." });
  if (!reply.ok) throw new Error("turn");
  const live = worksOf(app.db, userId, conversation.id, [reply.value]).get(reply.value.id);
  const fromStream = await (await fetch(`${servers.url}/talk/stream?after=${reply.value.id}`, { headers: { cookie } })).text();
  expect(fromStream).not.toContain("Seven is open.");
  const listed = listTurns(app.db, userId, conversation.id);
  if (!listed.ok) throw new Error("turns");
  const turns = listed.value;
  const at = turns.findIndex((t) => t.id === reply.value.id);
  const drawn = turnHtml(reply.value, new Set(), undefined, undefined, live).text;
  expect(drawn).toBe(turnHtml(reply.value, new Set(), undefined, undefined, workBefore(turns, at, lookupFrom(app.db))).text);
  expect(drawn).toContain("opened #7");
  expect(drawn).toContain('href="/alice/x/issues/7"');
  // The wire: a client resuming from the person's turn is sent the reply drawn the same way.
  const person = turns[at - 2]!;
  const wire = await (await fetch(`${servers.url}/talk/stream?after=${person.id}`, { headers: { cookie } })).text();
  expect(wire).toContain("opened #7");
});

test("the API's agent turns carry the steps and links for the terminal", async () => {
  const res = await fetch(`${servers.url}/api/v1/conversation/turns?limit=5`, { headers: { cookie } });
  const body = (await res.json()) as { turns: { role: string; text: string; work?: { steps: string; links: { href: string }[] } | null }[] };
  const reply = body.turns.findLast((t) => t.role === "agent")!;
  expect(reply.work?.steps).toBe("opened #7");
  expect(reply.work?.links.map((l) => l.href)).toEqual(["/alice/x/issues/7"]);
  expect(body.turns.filter((t) => t.role !== "agent").every((t) => t.work === undefined)).toBe(true);
});

test("a tool that changes an issue or pull says changed, not opened", () => {
  const work = workOf([call("issue", { repo: "alice/x", number: 3 }), call("say", { repo: "alice/x", number: 4, body: "hi" }), call("close", { repo: "alice/x", number: 5 })]);
  expect(work?.steps).toBe("opened #3, changed #4, #5");
  // A tool that is neither is a step with no number link.
  expect(workOf([call("vision", { repo: "alice/x", number: 2 })])).toEqual({ steps: "vision", links: [] });
});

test("the tools said to change an issue or pull are the ones that write by repo and number", () => {
  const numbered = TOOLS.filter((t) => ["repo", "number"].every((k) => Object.keys(t.inputSchema.properties ?? {}).includes(k)));
  expect(new Set(numbered.filter((t) => t.writes).map((t) => t.name))).toEqual(CHANGES);
});

test("numbers from more than one repo say whose they are", () => {
  expect(workOf([call("issue", { repo: "alice/x", number: 12 }), call("issue", { repo: "bob/y", number: 12 })])?.steps).toBe("opened alice/x#12, bob/y#12");
  expect(workOf([call("issue", { repo: "alice/x", number: 12 }), call("say", { repo: "alice/x", number: 12 })])?.steps).toBe("opened #12, changed #12");
});

test("a number link goes where the forge says it is, an issue or a pull", async () => {
  const pull = createIssue(app.db, { repoId, authorId: userId, title: "a pull", kind: "pull" });
  const issue = createIssue(app.db, { repoId, authorId: userId, title: "an issue" });
  if (!pull.ok || !issue.ok) throw new Error("issue");
  const look = lookupFrom(app.db);
  const work = workOf([call("say", { repo: "alice/x", number: pull.value.number }), call("merge", { repo: "alice/x", number: issue.value.number })], look);
  expect(work?.links.map((l) => l.href)).toEqual([`/alice/x/pulls/${String(pull.value.number)}`, `/alice/x/issues/${String(issue.value.number)}`]);
  const res = await fetch(servers.url + work!.links[1]!.href, { headers: { cookie } });
  expect(res.status).toBe(200);
  // Unknown to the forge, the tool's own kind decides.
  expect(workOf([call("merge", { repo: "alice/x", number: 999 })], look)?.links[0]?.href).toBe("/alice/x/pulls/999");
});

test("a reply first on an older page keeps the steps of the calls on the page before", async () => {
  const conversation = openConversation(app.db, userId);
  appendTurn(app.db, userId, conversation.id, { role: "person", text: "and nine?" });
  appendTurn(app.db, userId, conversation.id, { role: "tool", text: 'mcp__forge__issue {"repo":"alice/x","number":9}' });
  const reply = appendTurn(app.db, userId, conversation.id, { role: "agent", text: "Nine is open." });
  const after = appendTurn(app.db, userId, conversation.id, { role: "person", text: "thanks" });
  if (!reply.ok || !after.ok) throw new Error("turn");
  const res = await fetch(`${servers.url}/api/v1/conversation/turns?limit=1&before=${after.value.id}`, { headers: { cookie } });
  const body = (await res.json()) as { turns: { id: string; work?: { steps: string } | null }[] };
  expect(body.turns.map((t) => t.id)).toEqual([reply.value.id]);
  expect(body.turns[0]?.work?.steps).toBe("opened #9");
});
