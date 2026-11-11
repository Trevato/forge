/**
 * The read-only/read-write line on /mcp, held over every tool at once
 * (#11493), not by each tool's own test.
 *
 * One forge boots with an admin, a repository, and an `ro` token for the
 * admin (so the admin-only tools are listed too). `tools/list` is walked as
 * that token, and every listed tool is called:
 *
 * - without `readOnlyHint: true` (it writes), with arguments that reach its
 *   write path as far as `plansOnly` reads them — `dryRun: false`, an
 *   `action` that is not a list, every `readsWithout` key given — and the
 *   answer must be the plain refusal, with no row written anywhere;
 * - with `readOnlyHint: true`, with no arguments and again with the repo,
 *   and no table may gain or lose a row.
 *
 * A new tool that writes without saying so, or one whose `readsWhen` the
 * write arguments here do not get past, fails a test that names it. The
 * admin-scope tools are not listed to an `ro` token at all; the last test
 * holds that each is refused by name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { plansOnly } from "../src/http/mcp/shared.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listAt } from "./mcp-list.ts";

const REFUSAL = "forbidden: this token may read, not act";
const REPO = "alice/game";
/**
 * The forge's own traffic counts: every request adds to them, flushed by a
 * timer about a second later (`core/route_timing.ts`, `core/usage_count.ts`),
 * so whichever call is in flight then would be blamed for them.
 */
const TRAFFIC = new Set(["route_timing", "usage_count"]);

/** Arguments that take a writing tool past every `plansOnly` door it has. */
function writeArgs(name: string): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  const args: Record<string, unknown> = { repo: REPO, dryRun: false, apply: true, action: "write" };
  for (const k of tool?.readsWithout === undefined ? [] : [tool.readsWithout].flat()) args[k] ??= "x";
  return args;
}

describe("every MCP tool that writes refuses a read-only token", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let ro: string;
  let listed: { name: string; annotations?: { readOnlyHint?: boolean } }[] = [];

  /** Rows in every table, by table: what a write would change. */
  const rows = (): Record<string, number> => {
    const tables = app.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const out: Record<string, number> = {};
    for (const { name } of tables) {
      if (TRAFFIC.has(name)) continue;
      try {
        out[name] = app.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get()!.n;
      } catch {
        // A virtual table's shadow may not count on its own; its parent does.
      }
    }
    return out;
  };

  /** The tables whose row count moved between two counts, named. */
  const moved = (a: Record<string, number>, b: Record<string, number>): string[] =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t] ?? 0}→${b[t] ?? 0}`);

  const call = async (name: string, args: unknown): Promise<{ isError: boolean; text: string }> => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ro}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    if (body.error !== undefined) return { isError: true, text: String(body.error.message) };
    return { isError: body.result.isError === true, text: String(body.result.content?.[0]?.text ?? "") };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-ro-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    const repo = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    await commitToBranch(app, alice, repo.value, { message: "seed", files: [{ path: "README.md", content: "# game\n" }] });
    ro = createToken(app.db, alice.id, "ro", "ro").token;
    listed = (await listAt(servers.url, ro)).result.tools;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("tools/list names the tools, and the writing ones are most of them", () => {
    expect(listed.length).toBeGreaterThan(20);
    expect(listed.filter((t) => t.annotations?.readOnlyHint !== true).length).toBeGreaterThan(10);
  });

  test("the write arguments here get past every tool's own read door", () => {
    // A tool whose `readsWhen` reads these as a read would be called here
    // and never reach the floor: name it, so its row in writeArgs is added.
    const stuck = TOOLS.filter((t) => t.writes && plansOnly(t, writeArgs(t.name))).map((t) => t.name);
    expect(stuck).toEqual([]);
  });

  test("every tool without readOnlyHint refuses the ro token and writes nothing", async () => {
    const open: string[] = [];
    for (const t of listed) {
      if (t.annotations?.readOnlyHint === true) continue;
      // `report` and `start` are the token-free tools: a stranger may call
      // them, so an `ro` token is no less than no token; fuzz-mcp holds them.
      if (t.name === "report" || t.name === "start") continue;
      const before = rows();
      const got = await call(t.name, writeArgs(t.name));
      const after = rows();
      if (!got.isError || got.text !== REFUSAL) open.push(`${t.name}: ${got.text.slice(0, 120)}`);
      const changed = moved(before, after);
      if (changed.length > 0) open.push(`${t.name} wrote: ${changed.join(", ")}`);
    }
    expect(open).toEqual([]);
  }, 10_000);

  test("every readOnlyHint tool leaves every table's row count as it was", async () => {
    const wrote: string[] = [];
    for (const t of listed) {
      if (t.annotations?.readOnlyHint !== true) continue;
      for (const args of [{}, { repo: REPO }]) {
        const before = rows();
        await call(t.name, args);
        const changed = moved(before, rows());
        if (changed.length > 0) wrote.push(`${t.name}(${JSON.stringify(args)}) wrote: ${changed.join(", ")}`);
      }
    }
    expect(wrote).toEqual([]);
  }, 10_000);

  test("a readOnlyHint is said only of a tool that does not write", () => {
    const said = new Set(listed.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
    expect(TOOLS.filter((t) => t.writes && said.has(t.name)).map((t) => t.name)).toEqual([]);
  });

  test("the admin-scope tools are not listed to an ro token, and are refused by name", async () => {
    const names = new Set(listed.map((t) => t.name));
    const hidden = TOOLS.filter((t) => t.needsAdminScope === true);
    expect(hidden.filter((t) => names.has(t.name)).map((t) => t.name)).toEqual([]);
    for (const t of hidden) {
      const before = rows();
      const got = await call(t.name, writeArgs(t.name));
      expect({ name: t.name, isError: got.isError, text: got.text }).toEqual({
        name: t.name,
        isError: true,
        text: `no tool named ${t.name}`,
      });
      expect(moved(before, rows())).toEqual([]);
    }
  });
});
