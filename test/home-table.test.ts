/**
 * The new home's table (`/home?view=table`, web/pages/home_table.ts): every
 * item of every lane as one row, from the same picture as the lanes. It
 * remembers the view, filters and sorts through links, swaps its rows when
 * work moves, and offers only the bulk actions the fleet has, previewed row
 * by row and applied through the platform's own actions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { getIssueById } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { parseTable, sortRows, tableHref, type TableRow } from "../src/flow/lanes_table.ts";
import { promote } from "./helpers/members.ts";
import { seedHomeFlow, startCheck, type HomeFlowSeed } from "./helpers/home-flow-seed.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let seed: HomeFlowSeed;
let owner = "";
let bob = "";

const get = (path: string, cookie: string) => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
const post = (path: string, cookie: string, body: URLSearchParams) =>
  fetch(`${servers.url}${path}`, { method: "POST", body, headers: { cookie, origin: servers.url, accept: "application/json" }, redirect: "manual" });
const act = (cookie: string, op: string, ids: string[], phase = "preview", extra: Record<string, string> = {}) => {
  const b = new URLSearchParams({ op, phase, ...extra });
  for (const id of ids) b.append("ids", id);
  return post("/home/act", cookie, b);
};
const rowsOf = (html: string): string[] => [...html.matchAll(/<tr class="tb-row"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
const whatOf = (row: string): string => (row.match(/class="tb-what"[^>]*>\s*<a[^>]*>([^<]*)</)?.[1] ?? "").replaceAll("&#39;", "'").trim();
const titles = (html: string): string[] => rowsOf(html).map(whatOf);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-table-"));
  app = createApp({ dataDir, port: 0 });
  seed = await seedHomeFlow(app);
  servers = await serve(app);
  owner = `forge_session=${createSession(app.db, seed.owner.id).token}`;
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  promote(app.db, made.value);
  bob = `forge_session=${createSession(app.db, made.value.id).token}`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the table is the lanes' items, one row each", () => {
  test("it lists every lane's items once, with the lane, the sentence, who has it and both clocks", async () => {
    const res = await get("/home?view=table", owner);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-view="table"');
    const t = titles(html);
    for (const title of ["Tell the owner in words why a build is waiting", "A cost ledger per delivery: tokens, compute and time", "The pipeline page tells a stuck lane from a busy one", "Show a hosted forge's state in one line", "A failed proof is the one line that needs you", "The merge queue says why it is waiting"])
      expect(t).toContain(title);
    expect(new Set(t).size).toBe(t.length);
    const row = rowsOf(html).find((r) => whatOf(r).startsWith("A cost ledger"))!;
    expect(row).toContain("Building");
    expect(row).toContain("Writing the change.");
    expect(row).toContain("scout");
    expect(row).toContain('class="hf-age"');
    // the live region and the tools
    expect(html).toContain('id="hf-table"');
    expect(html).toContain('data-live-src="/live/table"');
    expect(html).toContain('id="tb-bar"');
    expect(html).toContain('id="tb-q"');
  });

  test("the view is remembered per browser, and the address can say it", async () => {
    const first = await get("/home?view=table", owner);
    const cookie = first.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_home_view=table");
    // no view asked: the remembered one
    const back = await (await get("/home", `${owner}; forge_home_view=table`)).text();
    expect(back).toContain('data-view="table"');
    // asking for the lanes wins and is remembered in turn
    const lanes = await get("/home?view=lanes", `${owner}; forge_home_view=table`);
    expect(await lanes.text()).toContain('data-view="lanes"');
    expect(lanes.headers.get("set-cookie")).toContain("forge_home_view=lanes");
    // an ordinary visit sets nothing
    expect((await get("/home", owner)).headers.get("set-cookie")).toBeNull();
  });

  test("lane, state, who, app and search are links and a form: they work without script", async () => {
    const byLane = await (await get("/home?view=table&lane=checks", owner)).text();
    expect(rowsOf(byLane).every((r) => r.includes(">Checks<"))).toBe(true);
    expect(rowsOf(byLane).length).toBe(4);
    const byWho = await (await get("/home?view=table&who=scout", owner)).text();
    expect(titles(byWho).length).toBeGreaterThan(0);
    expect(rowsOf(byWho).every((r) => r.includes("scout"))).toBe(true);
    const byApp = await (await get("/home?view=table&app=trevato/notes", owner)).text();
    expect(rowsOf(byApp).every((r) => r.includes(">notes<"))).toBe(true);
    const found = await (await get("/home?view=table&q=retry", owner)).text();
    expect(titles(found).every((t) => /retry/i.test(t))).toBe(true);
    expect(titles(found).length).toBeGreaterThanOrEqual(2);
    // every word of the search must match
    const narrow = await (await get("/home?view=table&q=retry+webhook", owner)).text();
    expect(titles(narrow)).toEqual(["Retry a failed webhook with a longer pause each time"]);
    // chips are anchors that carry the other filters, and a chosen one clears itself
    const chipOf = (html: string, on: boolean, label: string): string =>
      (html.match(new RegExp(`<a\\s+class="tb-chip"\\s+href="([^"]*)"\\s+aria-pressed="${on}"\\s*>\\s*${label}`))?.[1] ?? "").replaceAll("&amp;", "&");
    const chip = chipOf(narrow, false, "Checks");
    expect(chip).toContain("q=retry+webhook");
    expect(chip).toContain("lane=checks");
    const chosen = chipOf(byLane, true, "Checks");
    expect(chosen).toContain("/home?view=table");
    expect(chosen).not.toContain("lane=");
    // a value that is not one is no filter
    const odd = await (await get("/home?view=table&lane=nonsense&state=x&sort=zzz&who=a/b", owner)).text();
    expect(rowsOf(odd).length).toBeGreaterThan(10);
  });

  test("sorting by a column is a link, and the header says which way", async () => {
    const html = await (await get("/home?view=table&sort=title", owner)).text();
    const t = titles(html);
    expect(t).toEqual([...t].sort((a, b) => a.localeCompare(b)));
    expect(html).toContain('aria-sort="ascending"');
    const desc = await (await get("/home?view=table&sort=title&dir=desc", owner)).text();
    expect(titles(desc)).toEqual([...t].reverse());
    expect(desc).toContain('aria-sort="descending"');
  });

  test("a viewer sees only the rows they may read, and no way to act on others'", async () => {
    const html = await (await get("/home?view=table", bob)).text();
    expect(html).not.toContain("Retry a failed webhook");
    expect(titles(html)).toContain("A cost ledger per delivery: tokens, compute and time");
  });
});

describe("the rows are live", () => {
  test("the region has its own address, and an unchanged table answers 304 without being drawn", async () => {
    const res = await get("/live/table?lane=building", owner);
    expect(res.status).toBe(200);
    const tag = res.headers.get("etag")!;
    expect(tag).not.toBeNull();
    const body = await res.text();
    expect(body).toContain('id="hf-table"');
    expect(titles(body).length).toBe(4);
    const again = await fetch(`${servers.url}/live/table?lane=building`, { headers: { cookie: owner, "if-none-match": tag } });
    expect(again.status).toBe(304);
    // another view is another tag
    expect((await get("/live/table?lane=review", owner)).headers.get("etag")).not.toBe(tag);
    expect((await fetch(`${servers.url}/live/table`)).status).toBe(404);
  });

  test("a change moves to the row of the lane its event puts it in", async () => {
    const before = await (await get("/live/table", owner)).text();
    const row = (html: string) => rowsOf(html).find((r) => whatOf(r) === "The notes list opens on today") ?? "";
    expect(row(before)).toContain(">Review<");
    app.db.run("UPDATE run SET state = 'ok' WHERE issue_id = ?1 AND kind = 'agent'", [seed.pulls["r2"]!]);
    startCheck(app, seed.pulls["r2"]!, seed.repos.notes.id);
    app.bus.append({ kind: "run.started", repoId: seed.repos.notes.id, payload: {} });
    const after = await (await get("/live/table", owner)).text();
    expect(row(after)).toContain(">Checks<");
    expect(titles(after).filter((t) => t === "The notes list opens on today").length).toBe(1);
  });
});

describe("the action bar offers what exists, previews it, and acts through the platform", () => {
  test("it offers close, move to Later, land and hand to the planner, each for the kinds it fits", async () => {
    const html = await (await get("/home?view=table", owner)).text();
    const actions = JSON.parse((html.match(/data-actions="([^"]*)"/)?.[1] ?? "[]").replaceAll("&quot;", '"')) as { op: string; kinds: string[] }[];
    expect(actions.map((a) => a.op).sort()).toEqual(["close", "later", "replan", "ship"]);
    expect(actions.find((a) => a.op === "ship")?.kinds).toEqual(["pull"]);
    expect(actions.find((a) => a.op === "later")?.kinds).toEqual(["issue"]);
    expect(html).toContain('data-id="');
  });

  test("a preview says what would change and what is refused and why, and changes nothing", async () => {
    const ids = [seed.issues["ask3"]!, seed.issues["ask4"]!];
    const res = await act(owner, "close", ids);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; phase: string; summary: string; willChange: number; reversible: boolean };
    expect(body).toMatchObject({ ok: true, phase: "preview", willChange: 2, reversible: true });
    expect(body.summary).toContain("2 will change");
    expect(getIssueById(app.db, ids[0]!)?.state).toBe("open");
    // landing a change whose check is not green is refused, with the reason
    const ship = (await (await act(owner, "ship", [seed.pulls["a1"]!])).json()) as { willChange: number; refused: { label: string; why: string }[] };
    expect(ship.willChange).toBe(0);
    expect(ship.refused[0]?.why).toMatch(/check|merge/);
    // later is for issues: a pull is refused
    const later = (await (await act(owner, "later", [seed.pulls["a1"]!])).json()) as { refused: unknown[]; willChange: number };
    expect(later.willChange).toBe(0);
  });

  test("applying closes each row through the platform's own action and keeps a receipt that can undo it", async () => {
    const ids = [seed.issues["ask3"]!, seed.issues["ask4"]!];
    const res = await act(owner, "close", ids, "apply", { reason: "Not this week" });
    const body = (await res.json()) as { ok: boolean; phase: string; receipt: string; reversible: boolean; summary: string };
    expect(body).toMatchObject({ ok: true, phase: "apply", reversible: true });
    expect(body.receipt).toMatch(/^\/fleet\/ops\/[\w-]+$/);
    expect(getIssueById(app.db, ids[0]!)?.state).toBe("closed");
    expect(getIssueById(app.db, ids[1]!)?.state).toBe("closed");
    const receipt = await get(body.receipt, owner);
    expect(receipt.status).toBe(200);
    // the closed asks have left the table
    const after = await (await get("/live/table", owner)).text();
    expect(titles(after)).not.toContain("Search notes by the day they were written");
  });

  test("it is refused for anyone who cannot, and for what it is not", async () => {
    // a member who does not administer the repository: refused row by row, nothing closed
    const bobs = (await (await act(bob, "close", [seed.issues["ask1"]!], "apply")).json()) as { ok: boolean; summary: string };
    expect(bobs.summary).toContain("0 done");
    expect(getIssueById(app.db, seed.issues["ask1"]!)?.state).toBe("open");
    const refusedRow = (await (await act(bob, "close", [seed.issues["b3"]!])).json()) as { willChange?: number; ok: boolean };
    expect(refusedRow.willChange ?? 0).toBe(0);
    expect(getIssueById(app.db, seed.issues["b3"]!)?.state).toBe("open");
    expect((await act(owner, "delete", [seed.issues["ask1"]!])).status).toBe(400);
    expect((await act(owner, "close", [])).status).toBe(400);
    expect((await act(owner, "close", Array.from({ length: 101 }, (_, i) => `id${i}`))).status).toBe(400);
    expect((await fetch(`${servers.url}/home/act`, { method: "POST", body: new URLSearchParams({ op: "close" }), headers: { accept: "application/json" } })).status).toBe(401);
    // a form from another origin is refused before anything else
    const alien = await fetch(`${servers.url}/home/act`, { method: "POST", body: new URLSearchParams({ op: "close", ids: seed.issues["ask1"]! }), headers: { cookie: owner, origin: "https://evil.example" } });
    expect(alien.status).toBe(403);
    expect(getIssueById(app.db, seed.issues["ask1"]!)?.state).toBe("open");
  });
});

describe("the table's own rules are plain data", () => {
  test("a view is an address, and anything that is not a view parameter is dropped", () => {
    const q = parseTable(new URLSearchParams("q=  retry   webhook &lane=checks&state=stuck&sort=age&dir=desc&app=a/b&who=scout&x=1"));
    expect(q).toEqual({ q: "retry webhook", lane: "checks", tone: "stuck", sort: "age", dir: "desc", app: "a/b", who: "scout" });
    expect(tableHref(q)).toBe("/home?view=table&q=retry+webhook&lane=checks&app=a%2Fb&who=scout&state=stuck&sort=age&dir=desc");
    expect(parseTable(new URLSearchParams(new URL(`http://x${tableHref(q)}`).search))).toEqual(q);
    expect(tableHref(parseTable(new URLSearchParams("")))).toBe("/home?view=table");
    expect(parseTable(new URLSearchParams("lane=../x&app=../../etc&who=a b&sort=drop table")).lane).toBeNull();
  });

  test("the longest wait sorts as the largest, and a tie keeps the oldest in its lane first", () => {
    const row = (key: string, since: string, born: string | null): TableRow => ({ key, lane: "checks", laneName: "Checks", repo: "o/r", app: "r", number: 1, title: key, hint: "", tone: "waiting", who: "", since, born, href: "/", issueId: null, kind: "issue", haystack: key });
    const rows = [row("a", "2026-01-02T00:00:00Z", null), row("b", "2026-01-01T00:00:00Z", "2025-01-01T00:00:00Z"), row("c", "2026-01-03T00:00:00Z", "2026-01-03T00:00:00Z")];
    const q = (sort: "time" | "age", dir: "asc" | "desc") => parseTable(new URLSearchParams(`sort=${sort}&dir=${dir}`));
    expect(sortRows(rows, q("time", "desc")).map((r) => r.key)).toEqual(["b", "a", "c"]);
    expect(sortRows(rows, q("age", "desc")).map((r) => r.key)).toEqual(["b", "a", "c"]);
    expect(sortRows(rows, q("time", "asc")).map((r) => r.key)).toEqual(["c", "a", "b"]);
  });
});
