/**
 * /boards is an admin's: a guest and a signed-in non-admin get the not-found
 * page on every board page and every edit, and the board reads as before; an
 * admin's rename and delete answer with a redirect and a flash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllBoards, showBoard, writeBoard } from "../src/actions/boards.ts";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let alice: User;
const tok: Record<string, string> = {};

const panel = (title: string) => ({ title, chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 });
const auth = (who: string | null): Record<string, string> => (who ? { authorization: `Bearer ${tok[who]}` } : {});
const get = (path: string, who: string | null) => fetch(servers.url + path, { redirect: "manual", headers: auth(who) });
const post = (path: string, fields: Record<string, string>, who: string | null) =>
  fetch(servers.url + path, { method: "POST", redirect: "manual", body: new URLSearchParams(fields), headers: auth(who) });

const panelFields = { title: "Added", chart: "line", source: "runs", aggregate: "count", w: "1", h: "1" };
const edits: [string, Record<string, string>][] = [
  ["/boards/new", { title: "Intruder" }],
  ["/boards/pin", { slug: "mine", ...panelFields }],
  ["/boards/mine/rename", { title: "Renamed" }],
  ["/boards/mine/settings", { range: "7d", refresh: "10s" }],
  ["/boards/mine/add", panelFields],
  ["/boards/mine/edit", { index: "0", ...panelFields }],
  ["/boards/mine/remove", { index: "0" }],
  ["/boards/mine/move", { index: "0", by: "1" }],
  ["/boards/mine/duplicate", {}],
  ["/boards/mine/delete", {}],
];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-doors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  const bob = await mk("bob");
  tok.alice = createToken(app.db, alice.id, "t", "admin").token;
  tok.bob = createToken(app.db, bob.id, "t", "admin").token;
  const w = await writeBoard(app, alice, "mine", { title: "Mine", range: "all", refresh: "off", panels: [panel("One"), panel("Two")] });
  if (!w.ok) throw new Error(JSON.stringify(w.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** The boards as the store holds them, for the admin: nothing the page's nonces could vary. */
const read = async () => ({
  mine: await showBoard(app, alice, "mine"),
  all: await listAllBoards(app, alice),
});

describe("/boards doors", () => {
  test("the admin sees the board, so the refusals below mean something", async () => {
    const page = await (await get("/boards/mine", "alice")).text();
    expect(page).toContain("<h1>Mine</h1>");
    expect(page).toContain("One");
    expect(await (await get("/boards", "alice")).text()).toContain("/boards/mine");
    expect((await get("/boards/mine/live", "alice")).status).toBe(200);
  });

  for (const who of [null, "bob"]) {
    const name = who ?? "a guest";
    test(`${name}: every board page is not found`, async () => {
      for (const path of ["/boards", "/boards/mine", "/boards/mine/live"]) {
        const r = await get(path, who);
        // The list sends a guest to sign in first; it is never the list.
        if (who === null && path === "/boards") {
          expect(r.status).toBe(303);
          expect(r.headers.get("location")).toStartWith("/signin");
        } else expect(r.status, path).toBe(404);
        const body = await r.text();
        expect(body).not.toContain("One");
        expect(body).not.toContain("/boards/mine");
      }
    });

    test(`${name}: every edit is refused and the board reads as before`, async () => {
      const before = await read();
      for (const [path, fields] of edits) {
        const r = await post(path, fields, who);
        // A guest has no scope, so the form gate answers 403 before any board is read; a non-admin gets not found.
        expect(r.status, path).toBe(who === null ? 403 : 404);
      }
      expect(await read()).toEqual(before);
      expect((await get("/boards/intruder", "alice")).status).toBe(404);
    });
  }

  test("an admin's rename and delete redirect with a flash", async () => {
    const renamed = await post("/boards/mine/rename", { title: "Renamed" }, "alice");
    expect(renamed.status).toBe(303);
    expect(renamed.headers.get("location")).toBe("/boards/mine");
    expect(renamed.headers.get("set-cookie") ?? "").toContain("flash");
    expect(await (await get("/boards/mine", "alice")).text()).toContain("<h1>Renamed</h1>");

    const gone = await post("/boards/mine/delete", {}, "alice");
    expect(gone.status).toBe(303);
    expect(gone.headers.get("location")).toBe("/boards");
    expect(gone.headers.get("set-cookie") ?? "").toContain("flash");
    expect((await get("/boards/mine", "alice")).status).toBe(404);
  });
});
