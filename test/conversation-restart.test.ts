/**
 * A /talk conversation resumes its own session across a real forge restart
 * (#8776): the first message goes through the real `claude`, the forge is
 * stopped and started again on the same data directory, and the second
 * message resumes the same `claude_session_id` instead of taking the
 * fresh-start fallback. The session files are under the data directory, and
 * nothing is written under HOME.
 *
 * Skipped, with the reason on the console, where there is no `claude` binary
 * or no credential in the environment (`ANTHROPIC_API_KEY` or
 * `CLAUDE_CODE_OAUTH_TOKEN`): the check's cells have both. Two tiny turns on
 * the smallest model, each capped at $0.25.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listTurns, openConversation } from "../src/core/conversations.ts";
import { createUser } from "../src/core/users.ts";
import { say, sessionsDir, type ConversationOptions } from "../src/crew/conversation.ts";
import { serve } from "../src/http/server.ts";
import { runLogPath } from "../src/runs/log.ts";

const binary = Bun.which("claude");
const credential = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;
const why = binary === null ? "no `claude` binary on PATH" : !credential ? "no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment" : undefined;
if (why !== undefined) console.warn(`skipped: conversation-restart needs the real claude: ${why}`);

/** Every file under `dir`, relative, depth-first. */
const files = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)).map((f) => join(e.name, f)) : [e.name],
      );

const realHome = process.env.HOME;
let dataDir = "";
let home = "";

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
  if (home !== "") await rm(home, { recursive: true, force: true });
});

/** One forge process's life: boot on the data directory, say one message, stop. */
async function lifetime(userId: string | undefined, message: string) {
  const app: App = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    let id = userId;
    if (id === undefined) {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
      if (!u.ok) throw new Error(u.error);
      id = u.value.id;
    }
    const options: ConversationOptions = {
      binary: binary!,
      localUrl: servers.url,
      budgetUsd: 0.25,
      timeoutMs: 120_000,
      model: "haiku",
      signal: new AbortController().signal,
    };
    const said = say(app, options, id, message);
    if (!said.ok) throw new Error(said.error);
    await said.value.done;
    const conversation = openConversation(app.db, id);
    const run = app.db.query<{ id: string; state: string }, [string]>("SELECT id, state FROM conversation_run WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1").get(conversation.id)!;
    const log = existsSync(runLogPath(dataDir, run.id)) ? readFileSync(runLogPath(dataDir, run.id), "utf8") : "";
    const t = listTurns(app.db, id, conversation.id);
    const agent = t.ok ? t.value.filter((x) => x.role === "agent").map((x) => x.text).join(" ") : "";
    return { userId: id, session: conversation.claudeSessionId, state: run.state, log, agent };
  } finally {
    servers.stop();
    app.close();
  }
}

describe("a conversation across a forge restart", () => {
  test.skipIf(why !== undefined)(
    "the second message resumes the first's session, kept under the data directory",
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), "forge-conv-restart-"));
      home = await mkdtemp(join(tmpdir(), "forge-conv-home-"));
      mkdirSync(join(home, ".claude"), { recursive: true });
      process.env.HOME = home; // a session written there would show

      const first = await lifetime(undefined, "Remember the word PELICAN. Reply with only: ok");
      console.log(`first turn: state=${first.state} session=${first.session}\n${first.log}`);
      expect(first.state).toBe("ok");
      expect(first.session).not.toBe("");
      expect(first.log).not.toContain("resuming session");

      const second = await lifetime(first.userId, "What word did I ask you to remember? Reply with only that word.");
      console.log(`second turn (after restart): state=${second.state} session=${second.session}\n${second.log}`);
      expect(second.state).toBe("ok");
      expect(second.log).toContain(`resuming session ${first.session}`);
      expect(second.log).not.toContain("no session to resume");
      expect(second.session).toBe(first.session);
      expect(second.agent.toLowerCase()).toContain("pelican");

      // The session files are under the data directory...
      const kept = files(sessionsDir(dataDir)).filter((f) => f.endsWith(`${first.session}.jsonl`));
      console.log(`session files under data dir: ${kept.join(", ")}`);
      expect(kept.length).toBeGreaterThan(0);
      expect(statSync(join(dataDir, "claude-config")).mode & 0o077).toBe(0);
      // ...and none under HOME.
      expect(files(home).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
    },
    300_000,
  );
});
