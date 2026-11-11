/**
 * A Talk turn carries the owner's memory in its system prompt, and a thread
 * whose context is nearly full continues in a fresh session from its record
 * instead of resuming (#11011).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listTurns, openConversation } from "../src/core/conversations.ts";
import { addMemory } from "../src/core/talk_memory.ts";
import { createUser, type User } from "../src/core/users.ts";
import { configureConversation, conversationOptions, CONTEXT_RENEWED_LINE, say } from "../src/crew/conversation.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let owner: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-captain-turn-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "captainowner", email: "c@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  owner = made.value;
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
n=$(ls "${dir}"/call-*.args 2>/dev/null | wc -l)
printf '%s\\n' "$@" > "${dir}/call-$n.args"
printf '%s' "$first" > "${dir}/call-$n.first"
echo '{"type":"system","subtype":"init","session_id":"sess-'$n'","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.01,"num_turns":1,"session_id":"sess-'$n'","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  chmodSync(bin, 0o755);
  configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
}, 30_000);

afterAll(async () => {
  servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const ask = async (text: string) => {
  const said = say(app, conversationOptions(app)!, owner.id, text);
  if (!said.ok) throw new Error(said.error);
  await said.value.done;
};

test("memory rides every turn; a full thread continues fresh, a roomy one resumes", async () => {
  addMemory(app.db, owner.id, "Never run rm.");
  await ask("first");
  expect(readFileSync(join(dir, "call-0.args"), "utf8")).toContain("Never run rm.");

  // Roomy: the second turn resumes the first's session.
  await ask("second");
  expect(readFileSync(join(dir, "call-1.args"), "utf8")).toContain("--resume\nsess-0");

  // Nearly full: the third starts a new session from the record, and says so.
  app.db.query("UPDATE conversation_run SET context_tokens = 180000, context_window = 200000").run();
  await ask("third");
  expect(readFileSync(join(dir, "call-2.args"), "utf8")).not.toContain("--resume");
  expect(readFileSync(join(dir, "call-2.first"), "utf8")).toContain("What was said so far");
  expect(readFileSync(join(dir, "call-2.args"), "utf8")).toContain("Never run rm.");
  const turns = listTurns(app.db, owner.id, openConversation(app.db, owner.id).id, { limit: 50 });
  if (!turns.ok) throw new Error("turns");
  expect(turns.value.some((t) => t.text === CONTEXT_RENEWED_LINE)).toBe(true);
});
