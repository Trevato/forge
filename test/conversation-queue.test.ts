/**
 * A message sent while a turn runs (#8819): Send queues it for after the turn,
 * in order, with Cancel; Steer stops the turn, keeps its partial answer, and
 * sends the message at once; Stop forgets what waited.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listTurns, openConversation } from "../src/core/conversations.ts";
import { createUser, type User } from "../src/core/users.ts";
import { cancelQueued, queuedOf, say, STOPPED_LINE, stopTurn, turnRunning, type ConversationOptions } from "../src/crew/conversation.ts";

let dir: string;
let app: App;
let alice: User;

const options = (binary: string): ConversationOptions => ({ binary, localUrl: "http://127.0.0.1:9", budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
const turns = (u: User) => {
  const r = listTurns(app.db, u.id, openConversation(app.db, u.id).id);
  return r.ok ? r.value.map((t) => `${t.role}:${t.text}`) : [];
};

/** A stand-in that logs each message it is given and holds until `<name>.gate.<n>` exists, n being its place among the runs. */
function chain(name: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s\\n' "$first" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/' >> "${dir}/${name}.log"
n=$(wc -l < "${dir}/${name}.log" | tr -d ' ')
echo '{"type":"system","subtype":"init","session_id":"sess-chain","model":"fake"}'
echo '{"type":"assistant","session_id":"sess-chain","message":{"id":"m'$n'","content":[{"type":"text","text":"partial '$n'"}],"usage":{"input_tokens":1,"output_tokens":1}}}'
while [ ! -f "${dir}/${name}.gate.$n" ]; do sleep 0.05; done
echo '{"type":"result","subtype":"success","is_error":false,"result":"partial '$n'","total_cost_usd":0.1,"num_turns":1,"session_id":"sess-chain","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
  );
  chmodSync(path, 0o755);
  return path;
}
const logged = (name: string): string[] => (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8").trim().split("\n") : []);
/** Waits on the thing itself, and fails saying so when it never comes, instead of carrying on into a wrong answer. */
const until = async (ok: () => boolean, what = "the condition"): Promise<void> => {
  for (let i = 0; i < 500 && !ok(); i++) await Bun.sleep(20);
  if (!ok()) throw new Error(`timed out waiting for ${what}`);
};
/** The stand-in logs a message before the forge has read its partial answer; stopping in that gap would lose the partial. */
const saidPartial = (base: number, n: number): boolean => turns(alice).slice(base).includes(`agent:partial ${n}`);


beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-conv-queue-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  alice = a.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a message sent during a turn", () => {
  test("two messages sent during a turn queue, can be cancelled, and run in order after it (#8819)", async () => {
    const bin = chain("queue");
    const base = turns(alice).length;
    const o = options(bin);
    const first = say(app, o, alice.id, "first", [], "queue");
    expect(first.ok && first.value.how).toBe("started");
    await until(() => logged("queue").length === 1);
    const two = say(app, o, alice.id, "second", [], "queue");
    const three = say(app, o, alice.id, "third", [], "queue");
    const gone = say(app, o, alice.id, "never", [], "queue");
    expect(two.ok && two.value.how).toBe("queued");
    expect(three.ok && three.value.how).toBe("queued");
    // Waiting messages are not turns yet; the running turn is not disturbed.
    expect(queuedOf(app, alice.id).map((q) => q.text)).toEqual(["second", "third", "never"]);
    expect(turns(alice).some((t) => t === "person:second")).toBe(false);
    expect(gone.ok && gone.value.queued && cancelQueued(app, alice.id, gone.value.queued)).toBe(true);
    expect(cancelQueued(app, alice.id, "nope")).toBe(false);
    writeFileSync(join(dir, "queue.gate.1"), "");
    await until(() => logged("queue").length === 2);
    expect(logged("queue")).toEqual(["first", "second"]);
    expect(queuedOf(app, alice.id).map((q) => q.text)).toEqual(["third"]);
    writeFileSync(join(dir, "queue.gate.2"), "");
    await until(() => logged("queue").length === 3);
    writeFileSync(join(dir, "queue.gate.3"), "");
    await until(() => !turnRunning(app, alice.id));
    expect(logged("queue")).toEqual(["first", "second", "third"]);
    const mine = turns(alice).slice(base).filter((t) => /^(person:(first|second|third|never)|agent:partial)/.test(t));
    expect(mine).toEqual(["person:first", "agent:partial 1", "person:second", "agent:partial 2", "person:third", "agent:partial 3"]);
  });

  test("steer stops the turn, keeps its partial answer, and starts a new turn with the message at once (#8819)", async () => {
    const bin = chain("steer-now");
    const base = turns(alice).length;
    const o = options(bin);
    const first = say(app, o, alice.id, "long job", [], "queue");
    expect(first.ok && first.value.how).toBe("started");
    await until(() => logged("steer-now").length === 1 && saidPartial(base, 1), "the first partial answer");
    const queued = say(app, o, alice.id, "later", [], "queue");
    expect(queued.ok && queued.value.how).toBe("queued");
    const steered = say(app, o, alice.id, "do this instead", [], "interrupt");
    expect(steered.ok && steered.value.how).toBe("interrupted");
    // The stopped turn ends; the steering message runs ahead of the one already waiting.
    await until(() => logged("steer-now").length === 2);
    expect(logged("steer-now")).toEqual(["long job", "do this instead"]);
    writeFileSync(join(dir, "steer-now.gate.2"), "");
    await until(() => logged("steer-now").length === 3);
    writeFileSync(join(dir, "steer-now.gate.3"), "");
    await until(() => !turnRunning(app, alice.id));
    expect(logged("steer-now")).toEqual(["long job", "do this instead", "later"]);
    const mine = turns(alice).slice(base).filter((t) => /^(person:(long job|do this instead|later)|agent:(partial|Stopped))/.test(t));
    expect(mine).toEqual(["person:long job", "agent:partial 1", `agent:${STOPPED_LINE}`, "person:do this instead", "agent:partial 2", "person:later", "agent:partial 3"]);
  });

  test("Stop forgets what waited behind the turn", async () => {
    const bin = chain("stop-queue");
    const o = options(bin);
    const base = turns(alice).length;
    say(app, o, alice.id, "running", [], "queue");
    await until(() => logged("stop-queue").length === 1 && saidPartial(base, 1), "the first partial answer");
    say(app, o, alice.id, "waiting", [], "queue");
    expect(stopTurn(app, alice.id)).toBe(true);
    await until(() => !turnRunning(app, alice.id), "the stopped turn to end");
    expect(queuedOf(app, alice.id)).toEqual([]);
    expect(logged("stop-queue")).toEqual(["running"]);
  });
});
