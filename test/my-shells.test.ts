/**
 * Your shells (#10544): the read returns a live session with its real start
 * and last-input times; the account page lists it, escaped, with the ended
 * ones after it; `sessions` with `kind: "shells"` returns the same rows.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { liveShells, myShells, recordEnd, recordStart, setShellOptions, stopShells } from "../src/machines/shell.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let servers: Servers;
let repo: Repo;
let aliceId: string;
let cookie: string;

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "my-shells-")), port: 0 });
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
  const made = await createUser(app.db, { username: "alice", email: "alice@x.test", password: "correct horse battery", origin: "seed", isAdmin: true, trusted: true });
  if (!made.ok) throw new Error(String(made.error));
  aliceId = made.value.id;
  cookie = `forge_session=${createSession(app.db, aliceId).token}`;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: aliceId, name: "lab", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  servers = await serve(app);
});

afterAll(() => {
  stopShells(app);
  servers.stop();
  app.close();
});

const page = async () => (await fetch(`${servers.url}/settings/shells`, { headers: { cookie } })).text();

async function mcpShells(): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenFor(app, "alice", "admin")}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sessions", arguments: { kind: "shells" } } }),
  });
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
}

test("with no shell the page says so in one line", async () => {
  expect(myShells(app, aliceId)).toEqual([]);
  const html = await page();
  expect(html).toContain("You have opened no shell on a machine yet.");
  expect((await mcpShells()).shells).toEqual([]);
});

test("a live shell is read with its real times; ended ones follow, escaped, on the page and in the tool", async () => {
  const before = Date.now();
  const ws = new WebSocket(`${servers.url.replace(/^http/, "ws")}/alice/lab/machines/standard/shell`, {
    headers: { cookie, origin: new URL(servers.url).origin },
  } as unknown as string[]);
  await new Promise((ok, no) => {
    ws.addEventListener("open", ok);
    ws.addEventListener("error", () => no(new Error("refused")));
  });
  ws.send(new TextEncoder().encode("echo hi\n"));
  await Bun.sleep(200);

  // An ended shell, its machine name hostile: the page must escape it.
  const old = recordStart(app.db, repo.id, "<b>x</b>", aliceId);
  recordEnd(app.db, old, "idle");

  const live = liveShells(app, aliceId);
  expect(live).toHaveLength(1);
  const s = live[0]!;
  expect(s).toMatchObject({ repository: "alice/lab", machine: "standard", peers: 1, endedAt: null });
  expect(Date.parse(s.startedAt)).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(s.lastInputAt!)).toBeGreaterThanOrEqual(Date.parse(s.startedAt));
  // No cell here, so no reading: a dash, not a zero.
  expect(s.cpuCores).toBeNull();
  expect(s.memoryMiB).toBeNull();

  const rows = myShells(app, aliceId);
  expect(rows.map((r) => r.endedAt === null)).toEqual([true, false]);
  expect(rows[1]).toMatchObject({ endReason: "idle", endedBecause: "idle too long" });

  const html = await page();
  expect(html).toContain("alice/lab · standard");
  expect(html).toMatch(/<dt>Attached<\/dt><dd>1<\/dd>/);
  expect(html).toMatch(/<dt>CPU<\/dt><dd>–<\/dd>/);
  // One marker for "running", not a glyph and a badge.
  expect(html.match(/running/g)?.length).toBe(1);
  expect(html).toContain("idle too long");
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html.indexOf("alice/lab · standard")).toBeLessThan(html.indexOf("idle too long"));

  expect((await mcpShells()).shells).toEqual(JSON.parse(JSON.stringify(rows)));

  // The palette reaches it.
  expect(html).toContain("Your shells");
  expect(html).toContain("/settings/shells");

  ws.close();
});
