/**
 * Boards as files in forge/boards: a board with three panels is saved,
 * reloaded from the repo and draws the same points; a file that is not a
 * board is not listed; and /boards makes, renames, duplicates, reorders and
 * deletes them for an admin who is a person, same-origin only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeBoard, deleteBoard, duplicateBoard, listAllBoards, makeBoard, showBoard } from "../src/actions/boards.ts";
import { createApp } from "../src/app.ts";
import { applyEdit } from "../src/boards/edit.ts";
import { runQuery } from "../src/boards/query.ts";
import { listBoards, parseBoard, readBoard, slugOf, saveBoard } from "../src/boards/store.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { commitLog } from "../src/git/read.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let alice: User;
let bob: User;
const tok: Record<string, string> = {};

const panel = (title: string, query: Record<string, unknown>, w = 1, h = 1) => ({ title, chart: "line", query, w, h });
const PANELS = [
  panel("Runs per day", { source: "runs", aggregate: "count", groupBy: { bucket: "day" } }, 2),
  panel("Runs by kind", { source: "runs", aggregate: "count", groupBy: "kind" }),
  panel("Turns by state", { source: "runs", aggregate: "sum", column: "turns", groupBy: "state" }),
];
const LINE = /<path d="M[^"]*" fill="none" stroke="currentColor" stroke-width="2"/g;
const asAdmin = (path: string, init: RequestInit = {}) =>
  fetch(servers.url + path, { redirect: "manual", ...init, headers: { authorization: `Bearer ${tok.admin}`, ...init.headers } });
const post = (path: string, fields: Record<string, string>, who = "admin", headers: Record<string, string> = {}) =>
  fetch(servers.url + path, {
    method: "POST", redirect: "manual", body: new URLSearchParams(fields),
    headers: { authorization: `Bearer ${tok[who]}`, ...headers },
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-store-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  tok.admin = createToken(app.db, alice.id, "t", "admin").token;
  tok.bob = createToken(app.db, bob.id, "t", "admin").token;
  app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('rb', ?, 'n')", [alice.id]);
  const ins = app.db.prepare("INSERT INTO run (id, repo_id, kind, state, turns, created_at) VALUES (?, 'rb', ?, ?, ?, ?)");
  // Three distinct UTC days at any hour: noon two days back, noon yesterday, a second ago.
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  ins.run("a", "agent", "ok", 2, new Date(today - 86_400_000 * 2 + 43_200_000).toISOString());
  ins.run("b", "deploy", "failed", 3, new Date(today - 86_400_000 + 43_200_000).toISOString());
  ins.run("c", "check", "ok", 5, new Date(Math.max(today, Date.now() - 1_000)).toISOString());
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the store", () => {
  test("a board of three panels is saved, reloaded from the repo and finds the same points", async () => {
    const made = await makeBoard(app, alice, "Fleet health");
    expect(made).toEqual({ ok: true, value: "fleet-health" });
    for (const p of PANELS) {
      const added = await changeBoard(app, alice, "fleet-health", { kind: "add", panel: p });
      expect(added.ok).toBe(true);
    }
    const before = PANELS.map((p) => runQuery(app.db, p.query, { repoIds: "all" }));
    const loaded = await readBoard(app.reposRoot, "fleet-health");
    expect(loaded?.panels.length).toBe(3);
    const after = loaded!.panels.map((p) => runQuery(app.db, p.query, { repoIds: "all" }));
    expect(after).toEqual(before);
    expect(after.every((a) => a.ok && a.rows.length > 0)).toBe(true);
    expect(loaded).toEqual({ title: "Fleet health", range: "7d", refresh: "off", panels: PANELS } as typeof loaded);
  });

  test("each save is a commit by the admin who made it, in forge/boards", async () => {
    const log = await commitLog(repoDir(app.reposRoot, "forge", "boards"), "main", { limit: 10 });
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.length).toBe(4);
    expect(log.value.every((c) => c.author === "alice")).toBe(true);
  });

  test("a file that is not a board is not listed, and the store refuses to write one", async () => {
    const bad = await commitFiles(repoDir(app.reposRoot, "forge", "boards"), {
      branch: "main", message: "pushed by hand", author: { name: "x", email: "x@x.invalid" },
      files: [{ path: "junk.json", content: '{"title":"x","range":"forever","refresh":"off","panels":[]}' }, { path: "bad.json", content: "{" }],
    });
    expect(bad.ok).toBe(true);
    expect((await listBoards(app.reposRoot)).map((b) => b.slug)).toEqual(["fleet-health"]);
    const author = { name: "alice", email: "a@a.invalid" };
    const board = (await readBoard(app.reposRoot, "fleet-health"))!;
    expect(await saveBoard(app.reposRoot, "x", { ...board, refresh: "5s" }, author, "m", "create")).toEqual({ ok: false, error: "invalid" });
    expect(await saveBoard(app.reposRoot, "../x", board, author, "m", "create")).toEqual({ ok: false, error: "invalid" });
    expect(await saveBoard(app.reposRoot, "fleet-health", board, author, "m", "create")).toEqual({ ok: false, error: "exists" });
    expect(await saveBoard(app.reposRoot, "nope", board, author, "m")).toEqual({ ok: false, error: "not_found" });
  });

  test("parseBoard judges every field", () => {
    const ok = { title: "t", range: "1h", refresh: "10s", panels: [PANELS[0]] };
    expect(parseBoard(ok).ok).toBe(true);
    for (const bad of [
      null, [], { ...ok, title: "" }, { ...ok, title: "x".repeat(81) }, { ...ok, range: "2d" }, { ...ok, refresh: "1s" },
      { ...ok, panels: "no" }, { ...ok, panels: Array(25).fill(PANELS[0]) },
      { ...ok, panels: [{ ...PANELS[0], w: 4 }] }, { ...ok, panels: [{ ...PANELS[0], h: 1.5 }] },
      { ...ok, panels: [{ ...PANELS[0], chart: "pie" }] },
      { ...ok, panels: [{ ...PANELS[0], query: { source: "users; drop" } }] },
      { ...ok, panels: [{ ...PANELS[0], query: [] }] },
    ]) expect(parseBoard(bad).ok).toBe(false);
  });

  test("slugs never name the data page or escape the repo", () => {
    expect(slugOf("Fleet Health!")).toBe("fleet-health");
    expect(slugOf("data")).toBe("data-board");
    expect(slugOf("../../etc")).toBe("etc");
    expect(slugOf("***")).toBe("");
  });

  test("edits: reorder, remove and a bad index", () => {
    const b = { title: "t", range: "7d" as const, refresh: "off" as const, panels: PANELS.map((p) => parseBoard({ title: "t", range: "7d", refresh: "off", panels: [p] }).ok ? p : p) };
    const moved = applyEdit(b as never, { kind: "move", index: 0, by: 1 });
    expect(moved.ok && moved.value.panels.map((p) => p.title)).toEqual(["Runs by kind", "Runs per day", "Turns by state"]);
    const first = applyEdit(b as never, { kind: "move", index: 0, by: -1 });
    expect(first.ok && first.value.panels[0]!.title).toBe("Runs per day");
    const gone = applyEdit(b as never, { kind: "remove", index: 1 });
    expect(gone.ok && gone.value.panels.length).toBe(2);
    expect(applyEdit(b as never, { kind: "remove", index: 9 }).ok).toBe(false);
  });

  test("a panel whose query cannot run is refused at save; non-admins and agents are not_found", async () => {
    const bad = await changeBoard(app, alice, "fleet-health", { kind: "add", panel: panel("x", { source: "runs", aggregate: "median" }) });
    expect(bad.ok).toBe(false);
    expect((await changeBoard(app, bob, "fleet-health", { kind: "title", title: "mine" }))).toEqual({ ok: false, error: "not_found" });
    expect(await makeBoard(app, bob, "x")).toEqual({ ok: false, error: "not_found" });
    expect(await listAllBoards(app, undefined)).toEqual({ ok: false, error: "not_found" });
    expect(await showBoard(app, bob, "fleet-health")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("/boards", () => {
  test("the list links a board; the board draws one chart per panel", async () => {
    const list = await (await asAdmin("/boards")).text();
    expect(list).toContain('href="/boards/fleet-health"');
    expect(list).toContain("Fleet health");
    const res = await asAdmin("/boards/fleet-health");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.match(LINE)?.length).toBe(3);
    expect(body).toContain("bp-w2");
    expect(body).not.toContain('data-live-src="/boards');
  });

  test("manage controls draw §5's row and bar, not .bmanage, and keep every form", async () => {
    const body = await (await asAdmin("/boards/fleet-health")).text();
    expect(body).not.toContain("bmanage");
    expect(body).toContain('class="row-trail bar"');
    expect(body).toContain('class="list setting-list"');
    expect(body).toContain('action="/boards/pin-panel"');
    for (const op of ["move", "rename", "settings", "duplicate"]) {
      expect(body).toContain(`action="/boards/fleet-health/${op}"`);
    }
    expect(body).toContain(`href="/-/confirm?to=${encodeURIComponent("/boards/fleet-health/delete")}"`);
    expect(body).toContain(`href="/-/confirm?to=${encodeURIComponent("/boards/fleet-health/remove?index=0")}`);
    for (const word of ["Panels", "Add a panel", "Up", "Down", "Remove", "Pin to home", "Save settings", "Duplicate", "Delete this board"]) {
      expect(body).toContain(word);
    }
    expect(body).toContain('<strong class="break">');
  });

  test("settings turn on refresh, and the grid answers alone with an etag", async () => {
    const saved = await post("/boards/fleet-health/settings", { range: "24h", refresh: "10s" });
    expect(saved.status).toBe(303);
    const body = await (await asAdmin("/boards/fleet-health")).text();
    const grid = body.match(/<section[^>]*id="board-grid"[^>]*>/)?.[0] ?? "";
    expect(grid).not.toContain("data-live-every");
    expect(grid).toMatch(/data-live="[^"]+"/);
    expect(grid).toContain('data-live="run.queued,run.started,run.finished,pull.*,check.*,issue.*,usage.*"');
    expect(body).toContain('data-live-src="/boards/fleet-health/live"');
    expect(body).toMatch(/<option\s+value="10s"\s+selected\s*>\s*on: redraw when events arrive\s*<\/option>/);
    expect(body).not.toContain(">1m</option>");
    const live = await asAdmin("/boards/fleet-health/live");
    expect(live.status).toBe(200);
    const text = await live.text();
    expect(text.startsWith("<section")).toBe(true);
    expect(text.match(LINE)?.length).toBe(3);
    const again = await asAdmin("/boards/fleet-health/live", { headers: { "if-none-match": live.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect((await post("/boards/fleet-health/settings", { range: "weeks", refresh: "10s" })).headers.get("set-cookie")).toContain("danger");
  });

  test("make, rename, move, add, edit, remove, duplicate and delete through the forms", async () => {
    const made = await post("/boards/new", { title: "Scratch <b>" });
    expect(made.headers.get("location")).toBe("/boards/scratch-b");
    expect((await post("/boards/scratch-b/rename", { title: "Scratch two" })).status).toBe(303);
    const q = { source: "runs", aggregate: "count", column: "", by: "day", from: "", to: "", fcolumn: "state", fop: "eq", fvalue: "ok" };
    expect((await post("/boards/scratch-b/add", { ...q, title: "ok runs", w: "3", h: "2" })).status).toBe(303);
    expect((await post("/boards/scratch-b/add", { ...q, title: "second", w: "1", h: "1", fvalue: "failed" })).status).toBe(303);
    await post("/boards/scratch-b/move", { index: "1", by: "-1" });
    let board = (await readBoard(app.reposRoot, "scratch-b"))!;
    expect(board.title).toBe("Scratch two");
    expect(board.panels.map((p) => p.title)).toEqual(["second", "ok runs"]);
    expect(board.panels[1]).toMatchObject({ w: 3, h: 2, query: { filter: [{ column: "state", op: "eq", value: "ok" }] } });
    await post("/boards/scratch-b/edit", { ...q, index: "0", title: "renamed", w: "2", h: "1" });
    await post("/boards/scratch-b/remove", { index: "1" });
    board = (await readBoard(app.reposRoot, "scratch-b"))!;
    expect(board.panels.map((p) => p.title)).toEqual(["renamed"]);
    const copy = await post("/boards/scratch-b/duplicate", {});
    expect(copy.headers.get("location")).toBe("/boards/scratch-b-copy");
    expect((await readBoard(app.reposRoot, "scratch-b-copy"))?.title).toBe("Scratch two (copy)");
    const page = await (await asAdmin("/boards/scratch-b")).text();
    expect(page).not.toContain("<b>");
    expect((await post("/boards/scratch-b/delete", {})).headers.get("location")).toBe("/boards");
    await deleteBoard(app, alice, "scratch-b-copy");
    expect(await readBoard(app.reposRoot, "scratch-b")).toBeUndefined();
    expect((await asAdmin("/boards/scratch-b")).status).toBe(404);
  });

  test("a pinned query lands on the board", async () => {
    const data = await (await asAdmin("/boards/data?source=runs&by=kind")).text();
    expect(data).toContain('action="/boards/pin"');
    const pinned = await post("/boards/pin", { slug: "fleet-health", title: "pinned", source: "runs", aggregate: "count", by: "kind", fop: "eq", w: "1", h: "1" });
    expect(pinned.headers.get("location")).toBe("/boards/fleet-health");
    expect((await readBoard(app.reposRoot, "fleet-health"))!.panels.at(-1)!.title).toBe("pinned");
  });

  test("a panel keeps its chart and series: chosen in the form, saved in the file, drawn on the board", async () => {
    await post("/boards/new", { title: "Charts" });
    const q = { source: "runs", aggregate: "count", column: "", by: "day", series: "kind", from: "", to: "", fcolumn: "", fop: "eq", fvalue: "" };
    expect((await post("/boards/charts/add", { ...q, chart: "heat", title: "heat", w: "1", h: "1" })).status).toBe(303);
    expect((await post("/boards/charts/add", { ...q, chart: "bar", title: "bar", w: "1", h: "1" })).status).toBe(303);
    const board = (await readBoard(app.reposRoot, "charts"))!;
    expect(board.panels.map((p) => [p.chart, p.query.series])).toEqual([["heat", "kind"], ["bar", "kind"]]);
    const page = await (await asAdmin("/boards/charts")).text();
    // runs in range: three days × three kinds for the heat strip; three days of bars, the series set aside
    expect(page.match(/<rect class="cell"/g)?.length).toBe(9);
    expect(page.match(/<rect class="bar"/g)?.length).toBe(3);
    expect(page).toMatch(/<option\s+value="heat"\s+selected\s*>\s*heat strip/);
    expect(parseBoard({ ...board, panels: [{ ...board.panels[0], chart: "pie" }] }).ok).toBe(false);
    await deleteBoard(app, alice, "charts");
  });

  test("a cross-origin post changes nothing, and duplicates are refused as unnamed", async () => {
    const before = await readBoard(app.reposRoot, "fleet-health");
    for (const path of ["/boards/fleet-health/rename", "/boards/fleet-health/delete", "/boards/new", "/boards/pin"]) {
      const res = await post(path, { title: "evil", slug: "fleet-health" }, "admin", { origin: "https://evil.example" });
      expect(res.status).toBe(403);
    }
    expect(await readBoard(app.reposRoot, "fleet-health")).toEqual(before);
    expect((await duplicateBoard(app, alice, "nope")).ok).toBe(false);
  });

  test("a non-admin and a stranger get 404 on every board route", async () => {
    for (const path of ["/boards", "/boards/fleet-health", "/boards/fleet-health/live"]) {
      expect((await fetch(servers.url + path, { headers: { authorization: `Bearer ${tok.bob}` } })).status).toBe(404);
      const stranger = await fetch(servers.url + path, { redirect: "manual" });
      // The list sends a stranger to sign in (#6733, so /flow is no dead end); a board itself stays a 404.
      if (path === "/boards") expect(stranger.headers.get("location")).toContain("next=%2Fboards");
      else expect(stranger.status).toBe(404);
    }
    expect((await post("/boards/fleet-health/delete", {}, "bob")).status).toBe(404);
    expect((await post("/boards/new", { title: "x" }, "bob")).status).toBe(404);
    expect(await readBoard(app.reposRoot, "fleet-health")).toBeDefined();
  });
});

describe("/api/v1/boards", () => {
  const api = (path: string, who: string | undefined, init: RequestInit = {}) =>
    fetch(servers.url + path, { ...init, headers: who ? { authorization: `Bearer ${who}` } : {} });
  const mine = { title: "Api board", range: "24h", refresh: "1m", panels: PANELS };

  test("an admin writes, lists and reads a board; each write is a commit", async () => {
    const put = await api("/api/v1/boards/api-board", tok.admin, { method: "PUT", body: JSON.stringify(mine) });
    expect(put.status).toBe(200);
    expect((await readBoard(app.reposRoot, "api-board"))?.panels.length).toBe(3);
    const list = (await (await api("/api/v1/boards", tok.admin)).json()) as { boards: { slug: string }[] };
    expect(list.boards.map((b) => b.slug)).toContain("api-board");
    const one = (await (await api("/api/v1/boards/api-board", tok.admin)).json()) as { title: string; refresh: string };
    expect([one.title, one.refresh]).toEqual(["Api board", "1m"]);
    const again = await api("/api/v1/boards/api-board", tok.admin, { method: "PUT", body: JSON.stringify({ ...mine, title: "Renamed" }) });
    expect(again.status).toBe(200);
    expect((await readBoard(app.reposRoot, "api-board"))?.title).toBe("Renamed");
  });

  test("a board failing parseQuery is refused on write and drawn as an error panel on read", async () => {
    const bad = { ...mine, panels: [panel("Broken", { source: "runs", aggregate: "median" })] };
    const res = await api("/api/v1/boards/broken", tok.admin, { method: "PUT", body: JSON.stringify(bad) });
    expect(res.status).toBe(422);
    expect(await readBoard(app.reposRoot, "broken")).toBeUndefined();
    expect((await api("/api/v1/boards/api-board", tok.admin, { method: "PUT", body: "{" })).status).toBe(400);
    expect((await api("/api/v1/boards/sources", tok.admin, { method: "PUT", body: JSON.stringify(mine) })).status).toBe(422);
    const hand = await commitFiles(repoDir(app.reposRoot, "forge", "boards"), {
      branch: "main", message: "pushed by hand", author: { name: "x", email: "x@x.invalid" },
      files: [{ path: "pushed.json", content: JSON.stringify(bad) }],
    });
    expect(hand.ok).toBe(true);
    const page = await (await asAdmin("/boards/pushed")).text();
    expect(page).toContain("Broken");
    expect(page).not.toMatch(LINE);
    expect(page).toMatch(/class="muted small">[^<]*(median|aggregate)/);
  });

  test("a malformed or oversized board is 422 with no commit and no query run", async () => {
    const head = async () => (await listBoards(app.reposRoot)).length;
    const before = await head();
    const many = Array.from({ length: 25 }, (_, i) => panel(`P${i}`, { source: "runs" }));
    for (const body of [{ panels: {} }, { ...mine, panels: [null] }, { ...mine, panels: many }, []]) {
      const res = await api("/api/v1/boards/malformed", tok.admin, { method: "PUT", body: JSON.stringify(body) });
      expect(res.status).toBe(422);
    }
    expect(await readBoard(app.reposRoot, "malformed")).toBeUndefined();
    expect(await head()).toBe(before);
  });

  test("an agent is 403, a non-admin 403, a stranger 401, a read-only token cannot write", async () => {
    const agent = await createUser(app.db, { origin: "seed", trusted: true, username: "bot", email: "bot@forge.local", password: "a-good-passphrase", agent: true } as never);
    if (!agent.ok) throw new Error(agent.error);
    const bot = createToken(app.db, agent.value.id, "t", "admin").token;
    const ro = createToken(app.db, alice.id, "t", "ro").token;
    const put = (who: string | undefined) => api("/api/v1/boards/api-board", who, { method: "PUT", body: JSON.stringify(mine) });
    expect((await api("/api/v1/boards", bot)).status).toBe(403);
    expect((await api("/api/v1/boards", tok.bob)).status).toBe(403);
    expect((await put(tok.bob)).status).toBe(403);
    expect((await api("/api/v1/boards", undefined)).status).toBe(401);
    expect((await put(ro)).status).toBe(403);
    expect((await api("/api/v1/boards/api-board", tok.bob, { method: "DELETE" })).status).toBe(403);
  });

  test("delete removes the file", async () => {
    expect((await api("/api/v1/boards/api-board", tok.admin, { method: "DELETE" })).status).toBe(200);
    expect(await readBoard(app.reposRoot, "api-board")).toBeUndefined();
    expect((await api("/api/v1/boards/api-board", tok.admin)).status).toBe(404);
  });
});
