/**
 * GET …/map and the MCP `map` tool see a `Relieves:` issue through its own hot
 * file (#7489). The bodies are #7299's, #7424's and #7429's as the forge
 * stores them: `Relieves:` above a backticked, comma-separated `Files:` line.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { HOT_PULLS, rememberPullFiles } from "../src/crew/hot_files.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

const TUI = {
  title: "A terminal screen adds its own palette entry from its own module, so a new screen no longer edits src/tui/forge.ts",
  body: "For: the crew, which today cannot start five ready issues because `src/tui/forge.ts` is in 7 open pulls: every new terminal screen adds its palette entry there. Steering means work is not held behind one file.\n\nDone:\n- [ ] Each palette entry (id, title, hint, who it is offered to, what it opens) is declared next to its screen, e.g. an exported `entry` in `src/tui/screens/<name>.ts`, and one list in a new `src/tui/screens/entries.ts` names them; `src/tui/forge.ts` reads that list instead of pushing each entry by hand.\n- [ ] Every entry offered today is offered to exactly the same people, with the same id, title and hint, in the same order; a test compares the palette for a person admin, a member, an agent and a signed-out session before and after.\n- [ ] AGENTS.md or the terminal's doc says a new screen adds its entry in its own module and one line in `entries.ts`.\n\nRelieves: src/tui/forge.ts\nFiles: `src/tui/forge.ts`, a new `src/tui/screens/entries.ts`, the screen modules whose entries move, one test.\nRisk: medium; it conflicts with every open pull that adds a palette entry, so it lands when `src/tui/forge.ts` is no longer hot.",
};
const CLI = {
  title: "Each `forge` command lives in its own module under src/cli/commands/, and main.ts dispatches from one table",
  body: "Intent: a new command stops being an edit to `src/cli/main.ts`, so command-line work no longer queues behind it. Today #7352, #7378, #7379 and #7380 all wait on that file.\n\nDone:\n- [ ] The commands already in `src/cli/main.ts` (`login`, `logout`, `whoami`, `sync`, `status`, `ls`, `pin`, `unpin`, `open`, `ui` and any that have landed since) each move to `src/cli/commands/<name>.ts`. Each exports `{ name, usage, run(out, args) }`.\n- [ ] `src/cli/main.ts` keeps the flags, `EXIT` and one table built from `src/cli/commands/index.ts`. `forge help` prints the same lines in the same order as before.\n- [ ] Behaviour is unchanged: the existing CLI tests pass untouched, and a new test checks that every module in `src/cli/commands/` is in the table and in `forge help`.\n- [ ] `AGENTS.md` (or `docs/CLI.md` if it exists) says in one line: a new command is a new file in `src/cli/commands/` plus one line in `index.ts`.\n\nRelieves: src/cli/main.ts\nFiles: `src/cli/main.ts`, `src/cli/commands/` (new), a new test.\n\nRisk: a pure move with no change in what any command does or prints.",
};
const MCP = {
  title: "The MCP tool table is generated one file per tool under docs/mcp/, so two pulls adding tools never edit the same doc",
  body: "Intent: MCP work stops queueing behind `docs/MCP.md`. Every tool change today regenerates its one table, so the file stays hot (#5323 waits on it).\n\nDone:\n- [ ] `bun scripts/mcp-tools.ts` writes `docs/mcp/tools/<name>.md` (one line: the tool's `doc` and whether it writes) for each tool, and removes files for tools that are gone. `docs/MCP.md` keeps its prose and, between its `tools:begin`/`tools:end` markers, one sentence linking the directory instead of the table.\n- [ ] `test/mcp-tools.test.ts` and the test that every MCP tool in the index is in the docs (#7252) check the per-tool files instead of the table, with the same failure words naming the command to run.\n- [ ] `GET /api/v1/…` or the MCP `index` tool, if either reads the table today, reads the files.\n- [ ] Nothing else in `docs/MCP.md` changes.\n\nRelieves: docs/MCP.md\nFiles: `scripts/mcp-tools.ts`, `docs/MCP.md`, `docs/mcp/tools/` (new), `test/mcp-tools.test.ts`.\n\nRisk: a pure move of generated text. It lands once docs/MCP.md is relieved.",
};
const HOT = ["src/tui/forge.ts", "src/cli/main.ts", "docs/MCP.md"];

let dataDir = "";
let app: App, servers: Servers, alice: User, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-relieves-map-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  alice = admin.value;
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A repository whose remembered open pulls make every path in `HOT` hot, one more pull than the limit. */
async function hotRepo(name: string): Promise<string> {
  const made = await createRepo(app, alice, { name, visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  rememberPullFiles(
    made.value.id,
    Array.from({ length: HOT_PULLS + 1 }, (_, i) => ({ number: 9000 + i, files: [...HOT, `src/own${i}.ts`] })),
  );
  return made.value.id;
}

function open(repoId: string, issue: { title: string; body: string }) {
  const r = createIssue(app.db, { repoId, authorId: alice.id, ...issue });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

type Held = { by: string; detail: string } | null;
type MapBody = { ready: { number: number; held: Held }[]; startable: number[] };

async function apiMap(name: string): Promise<MapBody> {
  return (await (await fetch(`${servers.url}/api/v1/repos/alice/${name}/map`)).json()) as MapBody;
}

async function mcpMap(name: string): Promise<MapBody> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "map", arguments: { app: `alice/${name}` } },
    }),
  });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0]!.text) as MapBody;
}

const heldOf = (map: MapBody, n: number): Held | undefined => map.ready.find((r) => r.number === n)?.held;

test("the three planned bodies are held by nothing on their own hot files; a plain one on the same file is", async () => {
  const repoId = await hotRepo("relieved");
  const tui = open(repoId, TUI);
  const cli = open(repoId, CLI);
  const mcp = open(repoId, MCP);
  const plain = open(repoId, { title: "Add a palette entry", body: "Files: `src/tui/forge.ts`, one test." });
  for (const map of [await apiMap("relieved"), await mcpMap("relieved")]) {
    expect(heldOf(map, tui.number)).toBeNull();
    expect(heldOf(map, cli.number)).toBeNull();
    expect(heldOf(map, mcp.number)).toBeNull();
    expect(heldOf(map, plain.number)).toMatchObject({ by: "hot_file", detail: `src/tui/forge.ts is in ${HOT_PULLS + 1} open pulls` });
    expect((heldOf(map, plain.number) as { pulls?: number[] } | undefined)?.pulls).toHaveLength(HOT_PULLS + 1);
    expect(map.startable.sort((a, b) => a - b)).toEqual([tui.number, cli.number, mcp.number]);
  }
});

test("a second issue relieving the same path waits on the one in flight, and the map says by whom", async () => {
  const repoId = await hotRepo("relieving");
  const first = open(repoId, TUI);
  createRun(app.db, { repoId, kind: "agent", issueId: first.id });
  const second = open(repoId, TUI);
  for (const map of [await apiMap("relieving"), await mcpMap("relieving")]) {
    expect(heldOf(map, first.number)?.by).toBe("running");
    expect(heldOf(map, second.number)).toEqual({
      by: "hot_file",
      detail: `waits: src/tui/forge.ts is already being relieved by #${first.number}`,
    });
  }
});
