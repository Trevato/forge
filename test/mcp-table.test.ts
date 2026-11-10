import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TABLE_BEGIN, TABLE_END, firstSentence, renderTable, tableIn, toolRows, withTable } from "../src/http/mcp_table.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { toolEntries } from "../src/http/mcp.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

const DOC = readFileSync(new URL("../docs/MCP.md", import.meta.url), "utf8");
const nameOf = (line: string) => line.split("|")[1]?.trim().replace(/`/g, "");

test("docs/MCP.md holds the tool table the code renders, naming each stale or removed tool", () => {
  const held = new Map(tableIn(DOC).split("\n").slice(2).map((l) => [nameOf(l)!, l]));
  const rows = toolRows();
  const stale = rows.filter((r) => held.get(r.name) !== renderTable([r]).split("\n")[2]).map((r) => r.name);
  const removed = [...held.keys()].filter((n) => !rows.some((r) => r.name === n));
  expect(stale, `docs/MCP.md is stale for tool(s) ${stale.join(", ")}: run bun scripts/mcp-table.ts`).toEqual([]);
  expect(removed, `docs/MCP.md lists tool(s) the code no longer has: ${removed.join(", ")}: run bun scripts/mcp-table.ts`).toEqual([]);
  expect(tableIn(DOC)).toBe(renderTable());
});

test("an edited description names its tool; a removed tool is named", () => {
  const rows = toolRows();
  const edited = rows.map((r) => (r.name === "hooks" ? { ...r, purpose: "Changed" } : r));
  const doc = withTable(DOC, renderTable(edited));
  expect(tableIn(doc).split("\n").filter((l) => !renderTable(rows).includes(l)).map(nameOf)).toEqual(["hooks"]);
  const gone = withTable(DOC, renderTable(rows.filter((r) => r.name !== "hooks")));
  expect(tableIn(gone)).not.toContain("`hooks`");
});

test("the table lists a known tool with its actions", () => {
  expect(toolRows().find((r) => r.name === "hooks")?.doors).toContain("`redeliver`");
  expect(toolRows().some((r) => r.name === "report")).toBe(true);
});

test("a purpose ends at '. ' outside backticks and parentheses", () => {
  expect(firstSentence("Reveal with `reveal: true`; old stops. More.")).toBe("Reveal with `reveal: true`; old stops");
  expect(firstSentence("Tell (first line. Rest) now. More.")).toBe("Tell (first line. Rest) now");
  expect(firstSentence("Use `a. b` here.")).toBe("Use `a. b` here");
  expect(firstSentence("One a|b.")).toBe("One a\\|b");
});

test("a bare word is no purpose: the next sentence joins it", () => {
  expect(firstSentence("Admin. Create or remove a thing. More.")).toBe("Admin. Create or remove a thing");
  expect(firstSentence("Admin: snapshot destination")).toBe("Admin: snapshot destination");
});

test("withTable round-trips and refuses a doc with a missing or misordered marker", () => {
  expect(withTable(DOC, tableIn(DOC))).toBe(DOC);
  expect(() => withTable("nothing", "t")).toThrow("no begin marker");
  expect(() => withTable(`${TABLE_BEGIN}\nx`, "t")).toThrow("no end marker");
  expect(() => tableIn(`${TABLE_END}\n${TABLE_BEGIN}`)).toThrow("before the begin");
});

test("the bytes are those of an admin's real tools/list response", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-table-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "a-long-table-passphrase", isAdmin: true });
    if (!made.ok) throw new Error("user");
    const token = createToken(app.db, made.value.id, "t", "admin").token;
    const served: any[] = [];
    let cursor: string | undefined;
    do {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: cursor === undefined ? {} : { cursor } }),
      });
      const body = (await res.json()) as any;
      served.push(...body.result.tools);
      cursor = body.result.nextCursor;
    } while (cursor !== undefined);
    const want = new Map(toolRows().map((r) => [r.name, r.bytes]));
    const got = served.map((e) => [e.name, Buffer.byteLength(JSON.stringify(e))]);
    expect(got.length).toBe(want.size);
    for (const [name, bytes] of got) expect(want.get(name), `bytes of ${name}`).toBe(bytes);
  } finally {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);

test("the entry builder is the one tools/list uses", () => {
  expect(toolEntries(TOOLS).length).toBe(TOOLS.length + 1);
});
