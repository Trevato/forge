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
import { openAppTty } from "../src/apps/tty_registry.ts";
import { shellLine } from "../src/tui/screens/shells.ts";
import { liveShells, myShells, recordEnd, recordStart, setShellOptions, stopIdleShells, stopShells } from "../src/machines/shell.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
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

// ---- stopping (#10545) ----

const openShell = async (c: string) => {
  const ws = new WebSocket(`${servers.url.replace(/^http/, "ws")}/alice/lab/machines/standard/shell`, {
    headers: { cookie: c, origin: new URL(servers.url).origin },
  } as unknown as string[]);
  await new Promise((ok, no) => {
    ws.addEventListener("open", ok);
    ws.addEventListener("error", () => no(new Error("refused")));
  });
  return ws;
};
const post = (path: string, c: string, origin = new URL(servers.url).origin) =>
  fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers: { cookie: c, origin }, body: new URLSearchParams() });
const mcp = async (args: object): Promise<any> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenFor(app, "alice", "admin")}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sessions", arguments: args } }),
  });
  const body = (await res.json()) as any;
  return body.result;
};

test("stop ends the session and records 'stopped'; a stranger's id is refused; cross-origin is refused", async () => {
  const ws = await openShell(cookie);
  await Bun.sleep(100);
  const id = liveShells(app, aliceId)[0]!.id;
  expect(await page()).toContain(`/settings/shells/${id}/stop`);

  const bob = await createUser(app.db, { username: "bob", email: "bob@x.test", password: "correct horse battery", origin: "seed", trusted: true });
  if (!bob.ok) throw new Error("bob");
  const bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  expect((await post(`/settings/shells/${id}/stop`, bobCookie)).status).toBe(404);
  expect(liveShells(app, aliceId)).toHaveLength(1);
  expect((await post(`/settings/shells/${id}/stop`, cookie, "https://evil.test")).status).toBe(403);
  expect(liveShells(app, aliceId)).toHaveLength(1);

  const res = await post(`/settings/shells/${id}/stop`, cookie);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/settings/shells");
  expect(liveShells(app, aliceId)).toHaveLength(0);
  expect(myShells(app, aliceId).find((r) => r.id === id)?.endReason).toBe("stopped");
  expect((await post(`/settings/shells/${id}/stop`, cookie)).status).toBe(404);
  ws.close();
});

test("stop all idle leaves a shell with a peer attached alone; MCP says the same words", async () => {
  const ws = await openShell(cookie);
  await Bun.sleep(100);
  // Limit 60s, half is 30s: nothing is that idle yet, and a peer is attached anyway.
  expect(stopIdleShells(app, aliceId, 60_000)).toBe(0);
  expect(stopIdleShells(app, aliceId, 0)).toBe(0);
  expect(liveShells(app, aliceId)).toHaveLength(1);

  ws.close();
  await Bun.sleep(200);
  expect(liveShells(app, aliceId)[0]!.peers).toBe(0);
  expect(stopIdleShells(app, aliceId, 60_000)).toBe(0);
  expect(stopIdleShells(app, aliceId, 0)).toBe(1);
  expect(liveShells(app, aliceId)).toHaveLength(0);

  const again = await openShell(cookie);
  await Bun.sleep(100);
  const id = liveShells(app, aliceId)[0]!.id;
  const r = await mcp({ kind: "shells", action: "end", id });
  expect(JSON.parse(r.content[0].text).says).toBe("Shell stopped.");
  const gone = await mcp({ kind: "shells", action: "end", id });
  expect(gone.isError).toBe(true);
  const idle = await mcp({ kind: "shells", action: "end_idle" });
  expect(JSON.parse(idle.content[0].text).says).toBe("No idle shell to stop.");
  again.close();
});

test("POST /settings/shells/stop-idle: 303 with a receipt, 403 cross-origin, a peer-attached shell left alone; the button shows with a live shell", async () => {
  const ws = await openShell(cookie);
  await Bun.sleep(100);
  expect(await page()).toContain('action="/settings/shells/stop-idle"');
  expect(await page()).toContain("Stop all idle");

  expect((await post("/settings/shells/stop-idle", cookie, "https://evil.test")).status).toBe(403);
  // A peer is attached: the post succeeds and stops nothing.
  const none = await post("/settings/shells/stop-idle", cookie);
  expect(none.status).toBe(303);
  expect(none.headers.get("location")).toContain("/settings/shells");
  expect(liveShells(app, aliceId)).toHaveLength(1);

  // The receipt rides the flash cookie to the page.
  const flash = (none.headers.get("set-cookie") ?? "").split(";")[0]!;
  const follow = await fetch(`${servers.url}/settings/shells`, { headers: { cookie: `${cookie}; ${flash}` } });
  expect(await follow.text()).toContain("No idle shell to stop.");
  ws.close();
  await Bun.sleep(200);
});

test("MCP: another person cannot end your shell id", async () => {
  const ws = await openShell(cookie);
  await Bun.sleep(100);
  const id = liveShells(app, aliceId)[0]!.id;
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenFor(app, "bob", "admin")}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sessions", arguments: { kind: "shells", action: "end", id } } }),
  });
  const out = ((await res.json()) as any).result;
  expect(out.isError).toBe(true);
  expect(out.content[0].text).toContain("not_found");
  expect(liveShells(app, aliceId)).toHaveLength(1);
  ws.close();
});

test("terminal: s stops the picked live shell with the page's receipt", async () => {
  const ws = await openShell(cookie);
  await Bun.sleep(100);
  const { getUserByName } = await import("../src/core/users.ts");
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, "alice")! },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  tui.start();
  const key = async (k: string, ctrl = false) => {
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(tui);
  };
  await key("k", true);
  for (const ch of "Your shells") await key(ch);
  await key("enter");
  await key("i");
  expect(tui.screen.toText()).toContain("No idle shell to stop.");
  expect(liveShells(app, aliceId)).toHaveLength(1);
  await key("s");
  expect(tui.screen.toText()).toContain("Shell stopped.");
  expect(liveShells(app, aliceId)).toHaveLength(0);
  tui.stop();
  ws.close();
});

test("an app terminal is a row on the account page and a line in the terminal, claiming no attached count", async () => {
  const handle = openAppTty(app, { userId: aliceId, repository: "alice/lab", slug: "lab", env: "production", hangup: () => {}, idleMs: () => 600_000 });
  const row = myShells(app, aliceId).find((r) => r.id === handle.id)!;
  expect(row.kind).toBe("app");
  expect(shellLine(row)).toBe("alice/lab · lab · production  app terminal, running");
  const html = await page();
  expect(html).toContain("App terminal · Started");
  expect(html).toContain(`/settings/shells/${handle.id}/stop`);
  const mine = html.slice(html.indexOf(`data-session="${handle.id}"`));
  expect(mine.slice(0, mine.indexOf("</li>"))).not.toContain("Attached");
  handle.close();
});
