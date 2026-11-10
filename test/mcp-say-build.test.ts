/** `say` drives a talk build through /mcp (#11071): the same functions and words as the API. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { BUILD_WORDS, BUILDS_PER_HOUR } from "../src/actions/build.ts";
import { setTemplateMark } from "../src/core/app_templates.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { configureConversation } from "../src/crew/conversation.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
const tok: Record<string, string> = {};

async function say(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "say", arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-say-build-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const make = async (username: string) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  alice = await make("alice");
  const bob = await make("bob");
  tok["rw"] = createToken(app.db, alice.id, "rw", "rw").token;
  tok["ro"] = createToken(app.db, alice.id, "ro", "ro").token;
  tok["bob"] = createToken(app.db, bob.id, "rw", "rw").token;
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Built.","total_cost_usd":0.01,"num_turns":1,"session_id":"s1","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  chmodSync(bin, 0o755);
  configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
}, 30_000);
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("build, state, diff, restore, publish through say", async () => {
  const tpl = await createRepo(app, alice, { name: "kit", visibility: "public", description: "" });
  if (!tpl.ok) throw new Error(tpl.error);
  const seeded = await commitToBranch(app, alice, tpl.value, { message: "t", files: [{ path: "README.md", content: "# kit\n" }] });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  setTemplateMark(app.db, tpl.value, true, alice.id);

  // Bad input and a refused template use the API's words.
  expect((await say(tok["rw"]!, { action: "build" })).error).toContain("invalid_prompt");
  expect((await say(tok["rw"]!, { action: "build", text: "a thing", template: "nope" })).error).toContain("invalid_template");
  expect((await say(tok["rw"]!, { action: "build", text: "a thing", template: "bob/none" })).error).toContain(BUILD_WORDS["bad_template"]!);

  const started = await say(tok["rw"]!, { action: "build", text: "a tip calculator for friends", template: "alice/kit" });
  const { conversation, repo, branch } = started.value;
  expect(repo).toBe("alice/tip-calculator");
  expect(branch).toBe(`talk-${conversation}`);
  await Bun.sleep(300);

  const empty = await say(tok["rw"]!, { action: "build_state", conversation });
  expect(empty.value.versions).toEqual([]);
  const r = getRepo(app.db, "alice", "tip-calculator")!;
  for (const [m, c] of [["Add the form", "one\n"], ["Round up", "two\n"]] as const) {
    const done = await commitToBranch(app, alice, r, { branch, message: m, files: [{ path: "page.txt", content: c }] });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  const two = await say(tok["rw"]!, { action: "build_state", conversation });
  expect(two.value.versions.map((v: { number: number }) => v.number)).toEqual([1, 2]);

  // A read-only token reads state and diffs, and writes nothing.
  expect((await say(tok["ro"]!, { action: "build_state", conversation })).value.versions.length).toBe(2);
  expect(JSON.stringify((await say(tok["ro"]!, { action: "build_diff", conversation, version: 2 })).value)).toContain("two");
  expect((await say(tok["rw"]!, { action: "build_diff", conversation, version: 9 })).error).toContain(BUILD_WORDS["no_version"]!);
  expect((await say(tok["rw"]!, { action: "build_diff", conversation })).error).toContain("invalid_version");

  // Another person's conversation is not found, for every action.
  for (const action of ["build_state", "build_diff", "build_restore", "build_publish"])
    expect((await say(tok["bob"]!, { action, conversation, version: 1 })).error).toContain(BUILD_WORDS["not_found"]!);

  // ro is refused on every writing action.
  for (const args of [{ action: "build", text: "x" }, { action: "build_restore", conversation, version: 1 }, { action: "build_publish", conversation }])
    expect((await say(tok["ro"]!, args)).error).toContain("forbidden");
  expect(getRepo(app.db, "alice", "x")).toBeUndefined();

  expect((await say(tok["rw"]!, { action: "build_restore", conversation, version: 1 })).value.version.number).toBe(3);
  expect((await say(tok["rw"]!, { action: "build_restore", conversation, version: 7 })).error).toContain(BUILD_WORDS["no_version"]!);
  expect((await say(tok["rw"]!, { action: "build_publish", conversation })).value.published).toBe(true);
});

test("the hourly limit speaks the API's words", async () => {
  let last = "";
  for (let i = 0; i < BUILDS_PER_HOUR + 1; i++) last = (await say(tok["rw"]!, { action: "build", text: `thing number ${i} here` })).error ?? "";
  expect(last).toContain(BUILD_WORDS["rate_limited"]!);
});
