/** Remove on a board panel asks first, on the confirm page, which names the panel; a board reordered since loses nothing (#8030). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeBoard, makeBoard, showBoard } from "../src/actions/boards.ts";
import { applyEdit } from "../src/boards/edit.ts";
import { emptyBoard, type Board } from "../src/boards/store.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const panel = (title: string) => ({ title, chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 });

describe("Remove on a board panel goes through the confirm page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";
  let slug = "";
  const confirmHref = (to: string) => `/-/confirm?to=${encodeURIComponent(to)}`;
  const get = (path: string, extra = "") =>
    fetch(`${servers.url}${path}`, { redirect: "manual", headers: { cookie: extra ? `${cookie}; ${extra}` : cookie } });
  const post = (path: string) =>
    fetch(`${servers.url}${path}`, { method: "POST", redirect: "manual", headers: { cookie, origin: servers.url } });
  const titles = async () => {
    const b = await showBoard(app, alice, slug);
    if (!b.ok) throw new Error(b.error);
    return b.value.panels.map((p) => p.title);
  };
  /** The page a redirect lands on, with the flash it carried. */
  const landed = async (res: Response) => {
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return (await get(res.headers.get("location") ?? "/", flash)).text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-confirm-board-panel-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const board = await makeBoard(app, alice, "Ops");
    if (!board.ok) throw new Error(String(board.error));
    slug = board.value;
    for (const t of ["Runs & kinds", "Second", "Third"]) {
      const added = await changeBoard(app, alice, slug, { kind: "add", panel: panel(t) });
      if (!added.ok) throw new Error(String(added.error));
    }
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    servers = await serve(app);
  }, 60_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the board page links Remove to the confirm page, not a form that posts at once", async () => {
    const page = await (await get(`/boards/${slug}`)).text();
    const to = `/boards/${slug}/remove?index=0&title=${encodeURIComponent("Runs & kinds")}`;
    expect(page).toContain(`href="${confirmHref(to)}"`);
    expect(page).not.toContain(`action="/boards/${slug}/remove"`);
    expect(page).toContain('aria-label="Remove Runs &amp; kinds"');
    expect(page).toContain('aria-label="Remove Second"');
  });

  test("the confirm page names the panel and the board, escaped", async () => {
    const to = `/boards/${slug}/remove?index=0&title=${encodeURIComponent("Runs & kinds")}`;
    const res = await get(confirmHref(to));
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(`Remove the panel Runs &amp; kinds from ${slug}?`);
    expect(page).toContain("Only this panel goes");
  });

  test("a title no longer at that index removes nothing and says so", async () => {
    const res = await post(`/boards/${slug}/remove?index=0&title=Third`);
    expect(res.status).toBe(303);
    expect(await titles()).toEqual(["Runs & kinds", "Second", "Third"]);
    expect(await landed(res)).toContain("that panel moved; nothing was removed");
  });

  test("the POST from the confirm page removes that panel", async () => {
    const res = await post(`/boards/${slug}/remove?index=1&title=Second`);
    expect(res.status).toBe(303);
    expect(await titles()).toEqual(["Runs & kinds", "Third"]);
  });

  test("without a title, remove by index behaves as before", () => {
    const board = { ...emptyBoard("B"), panels: [panel("A"), panel("B")] } as Board;
    const gone = applyEdit(board, { kind: "remove", index: 0 });
    expect(gone.ok && gone.value.panels.map((p) => p.title)).toEqual(["B"]);
    const moved = applyEdit(board, { kind: "remove", index: 0, title: "B" });
    expect(moved).toEqual({ ok: false, error: "that panel moved; nothing was removed" });
  });
});
