/** The weekly model review in the terminal's crew scorecard (#7815): the verdicts, the trail, and the Move / Leave decision, for a forge admin only. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { getAgent } from "../src/core/agents.ts";
import { recordChange, getChange, type ModelStats } from "../src/core/model_review.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const TITLE = "Crew scorecard per agent";
const before: ModelStats = {
  model: "opus", opened: 10, landed: 10, costPerLanded: 25, redRate: 0.1, reworkRounds: 0.2, reverts: 0, hardShare: 0.1,
};
let dir = "";
let app: App;
let agentId = "";
let changeId = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-review-"));
  app = createApp({ dataDir: dir, port: 0 });
  for (const [username, adminIfFirst] of [["ada", true], ["bob", false]] as const) {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  const made = await createAgent(app, getUserByName(app.db, "ada"), { username: "smith", model: "opus" });
  if (!made.ok) throw new Error(String(made.error));
  agentId = made.value.user.id;
  changeId = recordChange(app.db, {
    agentId, fromModel: "opus", toModel: "sonnet", state: "asked", why: "cheaper and holds", before, at: new Date(),
  });
});
afterEach(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function open(username: string) {
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, username)! },
    { terminal: headlessTerminal(200, 40), exitHooks: false },
  );
  tui.start();
  const key = (k: string) => tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
  key(":");
  for (const ch of TITLE) key(ch);
  await settleApp(tui);
  key("enter");
  await settleApp(tui);
  return { key, text: () => tui.screen.toText(), settle: () => settleApp(tui), stop: () => tui.stop() };
}

test("an admin sees the verdicts and the waiting change, and `m` then `y` moves the agent", async () => {
  const t = await open("ada");
  expect(t.text()).toContain("model review · smith on opus");
  expect(t.text()).toContain("waiting · smith: opus → sonnet (asked)");
  t.key("j");
  t.key("j");
  t.key("m");
  await t.settle();
  expect(t.text()).toContain("Move smith to sonnet");
  t.key("y");
  await t.settle();
  expect(getAgent(app.db, agentId)!.model).toBe("sonnet");
  expect(getChange(app.db, changeId)!.state).toBe("applied");
  expect(t.text()).toContain("trail · smith: opus → sonnet (applied)");
  t.stop();
});

test("`n` then `y` leaves the model where it was and declines the change", async () => {
  const t = await open("ada");
  t.key("j");
  t.key("j");
  t.key("n");
  await t.settle();
  t.key("y");
  await t.settle();
  expect(getAgent(app.db, agentId)!.model).toBe("opus");
  expect(getChange(app.db, changeId)!.state).toBe("declined");
  t.stop();
});

test("cancelling the confirm changes nothing, and a row that is not waiting has no button", async () => {
  const t = await open("ada");
  t.key("m"); // on the first scorecard row: nothing waits there
  await t.settle();
  expect(t.text()).not.toContain("Move smith");
  t.key("j");
  t.key("j");
  t.key("m");
  await t.settle();
  t.key("n");
  await t.settle();
  expect(getChange(app.db, changeId)!.state).toBe("asked");
  expect(getAgent(app.db, agentId)!.model).toBe("opus");
  t.stop();
});

test("a non-admin sees no review and cannot decide", async () => {
  const t = await open("bob");
  expect(t.text()).not.toContain("model review");
  t.key("m");
  t.key("y");
  await t.settle();
  expect(getChange(app.db, changeId)!.state).toBe("asked");
  t.stop();
});
