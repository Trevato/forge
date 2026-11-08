/** The data explorer in the terminal (#9440): the page's gate, questions, sentence and one-line description. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { exploreRows, resultLines } from "../src/tui/screens/ask_data.ts";
import { entry } from "../src/tui/screens/ask_data.ts";
import { readParams } from "../src/boards/params.ts";
import { useModel } from "../src/boards/model_fill.ts";
import { ok } from "../src/kernel/result.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();
let dir: string, app: App, carol: User, bob: User;
const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-askdata-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  carol = await mk("carol", true);
  bob = await mk("bob");
}, 30_000);
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function typed(user: User | undefined, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  entry.run(session, tui.ctx);
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("an admin person sees the plain names and ready questions", async () => {
  const text = await typed(carol, []);
  expect(text).toContain("CPU over the last week");
  expect(text).toContain("Slowest pages today");
  const rows = exploreRows(new Session(app, identity(carol)), Date.now());
  expect(rows.some((r) => r.title === "Machine readings")).toBe(true);
});

test("enter opens a chart with its one-line description", async () => {
  const text = await typed(carol, ["\r"]);
  expect(text).toContain("Average CPU cores per hour, where target is forge");
});

test("a sentence is read by parseSentence, and one it cannot read is an error and nothing more", async () => {
  const ok = await typed(carol, ["/", ..."memory over the last 3 days", "\r"]);
  expect(ok).toContain("Average memory bytes per hour");
  const bad = await typed(carol, ["/", ..."zzz qqq", "\r"]);
  expect(bad).toContain("I could not read that");
});

test("nobody else has the door, the rows or a query", async () => {
  for (const who of [bob, undefined]) {
    const session = new Session(app, identity(who));
    expect(exploreRows(session, Date.now())).toEqual([]);
    expect(resultLines(session, readParams(new URLSearchParams("source=runs")))).toEqual([]);
    const { app: tui, session: s2 } = createForgeApp(app, identity(who), { terminal: headlessTerminal(80, 24), exitHooks: false });
    expect(forgeCommands(s2)(tui.ctx).map((c) => c.id)).not.toContain("ask-data");
    tui.stop?.();
    expect(await typed(who, [])).not.toContain("CPU over the last week");
  }
  expect(resultLines(new Session(app, identity(carol)), readParams(new URLSearchParams("source=runs"))).length).toBeGreaterThan(0);
});

test("a sentence the rules cannot read goes to the model, and the result says so; a hit never does", async () => {
  const asked: string[] = [];
  useModel(async (_a, _u, _s, prompt) => (asked.push(prompt), ok(JSON.stringify({ source: "spend", aggregate: "sum", column: "cost_usd", by: "day", chart: "bar" }))));
  try {
    const hit = await typed(carol, ["/", ..."memory over the last 3 days", "\r"]);
    expect(hit).toContain("Average memory bytes per hour");
    expect(asked).toEqual([]);
    const filled = await typed(carol, ["/", ..."how pricey were the robots", "\r"]);
    expect(asked.length).toBe(1);
    expect(filled).toContain("Total cost USD per day");
    expect(filled).toContain("The model filled this form");
    useModel(async () => ok(JSON.stringify({ source: "users", aggregate: "count" })));
    expect(await typed(carol, ["/", ..."how pricey were the robots", "\r"])).toContain("not a query this explorer can run");
  } finally {
    useModel();
  }
});
