/** The crew scorecard's spend column (#7349): each agent's cost over 5h · today · 7d, `—` for none. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { spendByAgent } from "../src/tui/screens/scorecard.ts";

quietLogs();

const dir = await mkdtemp(join(tmpdir(), "forge-tui-scorecard-spend-"));
const app = createApp({ dataDir: dir, port: 0 });
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("each agent's row carries its own spend, and an agent that spent nothing shows —", async () => {
  for (const [username, adminIfFirst] of [["ada", true], ["bob", false]] as const) {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  const ada = getUserByName(app.db, "ada");
  const repo = await createRepo(app, ada, { name: "hello", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const ids: Record<string, string> = {};
  for (const name of ["smith", "jones", "idle"]) {
    const a = await createAgent(app, ada, { username: name });
    if (!a.ok) throw new Error(String(a.error));
    ids[name] = a.value.user.id;
  }
  const spend = (agent: string, costUsd: number, ageMs: number) =>
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: repo.value.id, kind: "agent" }).id,
      repoId: repo.value.id, issueId: null, agentId: ids[agent]!, subscriptionId: null,
      tokensIn: 1, tokensOut: 1, costUsd, wallMs: 1, outcome: "ok",
      at: new Date(Date.now() - ageMs).toISOString(),
    });
  spend("smith", 1.5, 60_000);
  spend("smith", 2, 6 * 86_400_000);
  spend("jones", 7.25, 60_000);

  const open = async (username: string) => {
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, username)! },
      { terminal: headlessTerminal(200, 40), exitHooks: false },
    );
    tui.start();
    const key = (k: string) => tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    key(":");
    for (const ch of "Crew scorecard per agent") key(ch);
    await settleApp(tui);
    key("enter");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop();
    return text;
  };
  const text = await open("ada");
  expect(text).toContain("spend $ 7.25 · 7.25 · 7.25");
  expect(text).toContain("spend $ 1.50 · 1.50 · 3.50");
  expect(text).toContain("spend —");
  expect(text).not.toContain("$0.00");
  expect(await open("bob")).not.toContain("spend");
});

test("spans are matched by name, so a reordered readSpend still lands each figure under its label", () => {
  const span = (name: "5h" | "today" | "week", costUsd: number) => ({
    span: name,
    since: "",
    total: { units: 0, tokensIn: 0, tokensOut: 0, costUsd },
    byCredential: [], byApp: [], byIssue: [], byKind: [],
    byAgent: [{ name: "smith", units: 1, tokensIn: 1, tokensOut: 1, costUsd }],
  });
  const got = spendByAgent([span("week", 7), span("5h", 1), span("today", 2)]);
  expect(got.get("smith")).toEqual([1, 2, 7]);
});
