/**
 * Each /talk turn records whether it resumed its stored session or took the
 * fresh-start fallback, with the running version and nothing else; the flow
 * vitals say it in words (#8795).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { say, type ConversationOptions } from "../src/crew/conversation.ts";
import { readTalkResumes, talkResumesWords } from "../src/flow/talk_resumes.ts";
import { running } from "../src/kernel/version.ts";
import { flowFor } from "../src/system/telemetry.ts";

let dir: string;
let app: App;
let userId: string;

const options = (binary: string): ConversationOptions => ({
  binary,
  localUrl: "http://127.0.0.1:9",
  budgetUsd: 1,
  timeoutMs: 30_000,
  signal: new AbortController().signal,
});

/** A fake `claude` that answers; with `lost`, a resume is refused as Claude Code refuses a session whose file is gone. */
function fake(name: string, lost: boolean): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"sess-count","model":"fake"}'
${lost ? `case " $* " in *" --resume "*)
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","errors":["No conversation found with session ID: sess-count"],"total_cost_usd":0,"num_turns":0,"session_id":"sess-count"}'
  exit 1 ;; esac` : ""}
echo '{"type":"assistant","session_id":"sess-count","message":{"id":"m","content":[{"type":"text","text":"All quiet."}],"usage":{"input_tokens":1,"output_tokens":1}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"All quiet.","total_cost_usd":0.1,"num_turns":1,"session_id":"sess-count","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const turn = async (binary: string, text: string): Promise<void> => {
  const said = say(app, options(binary), userId, text);
  if (said.ok) await said.value.done;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-resume-count-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  userId = a.value.id;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("a first message has no session to resume and counts for neither", async () => {
  await turn(fake("a", false), "hello");
  const t = readTalkResumes(app.db, running().version);
  expect([t.resumed, t.fellBack]).toEqual([0, 0]);
  expect(talkResumesWords(t)).toBe("");
});

test("a turn that resumes its session counts as resumed", async () => {
  await turn(fake("b", false), "again");
  const t = readTalkResumes(app.db, running().version);
  expect([t.resumed, t.fellBack]).toEqual([1, 0]);
  expect(talkResumesWords(t)).toBe(`1 conversation resumed after release ${running().version}, 0 fell back`);
});

test("a turn fed “No conversation found” counts as a fallback and shows in the vitals words", async () => {
  await turn(fake("c", true), "still there?");
  const t = readTalkResumes(app.db, running().version);
  expect([t.resumed, t.fellBack]).toEqual([1, 1]);
  for (const reader of [{ kind: "owner" }, { kind: "agent" }] as const) {
    const vitals = flowFor(app, reader).vitals;
    expect(vitals.says).toContain(`1 conversation resumed after release ${running().version}, 1 fell back`);
    expect(vitals.talk).toEqual(t);
  }
});

test("another version's turns are not this version's, and nothing but outcome and version is kept", () => {
  expect(readTalkResumes(app.db, "0.0.0-other")).toEqual({ version: "0.0.0-other", resumed: 0, fellBack: 0 });
  const rows = app.db.query<{ resume_outcome: string; version: string }, []>("SELECT resume_outcome, version FROM conversation_run WHERE resume_outcome != ''").all();
  expect(rows.map((r) => r.resume_outcome).sort()).toEqual(["fallback", "resumed"]);
  expect(JSON.stringify(rows)).not.toContain("sess-count");
});
