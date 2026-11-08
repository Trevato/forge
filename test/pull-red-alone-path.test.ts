/**
 * A pull the merge queue hands back red alone says so on every door that
 * draws its checks (#6494): the page, its live checks line, the terminal.
 * The mark is made the real way — a red gate in the queue — and read back.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { enqueue } from "../src/checks/queue.ts";
import { getPull, pullDir, type Pull } from "../src/core/pulls.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";
const made: { repo: Awaited<ReturnType<typeof setup>>["repo"]; marked: Pull; plain: Pull }[] = [];
const cells = process.env["FORGE_CELLS"];

async function setup() {
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const repo = r.value;
  const base = await commitToBranch(app, alice, repo, { message: "base", files: [{ path: "forge.json", content: "{}" }] });
  if (!base.ok) throw new Error(JSON.stringify(base.error));
  const pulls: Pull[] = [];
  for (const branch of ["red", "fine"]) {
    const done = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [{ path: `${branch}.txt`, content: branch }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const opened = await openPull(app, alice, repo, { title: branch, body: "", baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    pulls.push(getPull(app.db, repo.id, opened.value.number)!);
  }
  return { repo, marked: pulls[0]!, plain: pulls[1]! };
}

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-red-alone-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(String(u.error));
  alice = u.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  made.push(await setup());
  const { repo, marked } = made[0]!;
  const dir = await pullDir(app.db, app.reposRoot, repo, marked);
  const verdicts = await enqueue(
    repo.id,
    [
      {
        pull: marked,
        dir,
        land: async () => undefined,
        release: () => {},
        handBack: () => {},
      },
    ],
    async () => ({ lands: false, reopen: true, comment: "red", learn: [] }),
  );
  expect(verdicts).toEqual([false]);
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const text = async (path: string): Promise<string> =>
  (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("the pull page and its live checks line carry the line for the marked pull only", async () => {
  const { marked, plain } = made[0]!;
  for (const suffix of ["", "/checks-line"]) {
    const on = await text(`/alice/lib/pulls/${marked.number}${suffix}`);
    expect(on).toContain("red alone at");
    expect(on).toContain("<time datetime=");
    expect(on).toContain("waiting for a new head or a new main");
    const off = await text(`/alice/lib/pulls/${plain.number}${suffix}`);
    expect(off).not.toContain("red alone");
  }
});

test("the terminal's checks row says it too, and not for the other pull", async () => {
  const { repo, marked, plain } = made[0]!;
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:alice", user: alice },
    { terminal: headlessTerminal(200, 44), exitHooks: false },
  );
  tui.start();
  try {
    for (const [pull, says] of [[marked, true], [plain, false]] as const) {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
      const end = Date.now() + 10_000;
      while (!tui.screen.toText().includes(pull.title) && Date.now() < end) {
        await settleApp(tui);
        await Bun.sleep(20);
      }
      if (!tui.screen.toText().includes(pull.title)) throw new Error(`never came: still waiting while !tui.screen.toText().includes(pull.title)`);
      await settleApp(tui);
      const screen = tui.screen.toText();
      expect(screen.includes("red alone at")).toBe(says);
      if (says) expect(screen).toContain("waiting for a new head or a new main");
      tui.ctx.pop();
    }
  } finally {
    tui.stop();
  }
}, 30_000);
