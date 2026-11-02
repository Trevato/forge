/** `repo_labels` `action: "update"` renames and recolours a label as the labels page does, with its words. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { LABEL_WORDS } from "../src/actions/label_words.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP repo_labels update", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let adminRw: string;
  let ro: string;
  let bob: string;
  let n = 1;
  const R = "alice/game";

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: n++,
        method: "tools/call",
        params: { name: "repo_labels", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const listed = async () => (await call(admin, { repo: R })).value.items;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-labels-update-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    adminRw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin renames and recolours a label, and the list shows it", async () => {
    const made = await call(admin, { repo: R, action: "create", name: "bug", color: "d73a4a" });
    const id = made.value.label.id;
    const both = await call(admin, { repo: R, action: "update", id, name: "defect", color: "0E8A16" });
    expect(both.value).toEqual({
      says: "Label “defect” updated.",
      label: { id, name: "defect", color: "0e8a16" },
    });
    expect(await listed()).toEqual([{ id, open: 0, name: "defect", color: "0e8a16" }]);
    // Either field alone keeps the other's value.
    await call(admin, { repo: R, action: "update", id, name: "Defect" });
    expect(await listed()).toEqual([{ id, open: 0, name: "Defect", color: "0e8a16" }]);
    await call(admin, { repo: R, action: "update", id, color: "aabbcc" });
    expect(await listed()).toEqual([{ id, open: 0, name: "Defect", color: "aabbcc" }]);
  });

  test("a taken name, a bad colour and a missing label are refused in the page's words", async () => {
    await call(admin, { repo: R, action: "create", name: "ui", color: "6b7280" });
    const [defect, ui] = await listed();
    const taken = await call(admin, { repo: R, action: "update", id: ui.id, name: "DEFECT" });
    expect(taken.error).toBe(`taken: ${LABEL_WORDS.taken}`);
    const color = await call(admin, { repo: R, action: "update", id: ui.id, color: "red" });
    expect(color.error).toBe(`invalid: ${LABEL_WORDS.shape}`);
    const blank = await call(admin, { repo: R, action: "update", id: ui.id, name: "  " });
    expect(blank.error).toBe(`invalid: ${LABEL_WORDS.shape}`);
    const gone = await call(admin, { repo: R, action: "update", id: "nope", name: "x" });
    expect(gone.error).toBe(`not_found: ${LABEL_WORDS.gone}`);
    expect((await call(admin, { repo: R, action: "update", id: ui.id })).error).toContain("invalid");
    expect((await call(admin, { repo: R, action: "update", name: "x" })).error).toContain("invalid");
    expect(await listed()).toEqual([defect, ui]);
  });

  test("a read-only token, a non-admin token and a stranger cannot update", async () => {
    const before = await listed();
    const id = before[0].id;
    expect((await call(ro, { repo: R, action: "update", id, name: "x" })).error).toBe(
      "forbidden: this token may read, not act",
    );
    expect((await call(adminRw, { repo: R, action: "update", id, name: "x" })).error).toContain("admin token");
    expect((await call(bob, { repo: R, action: "update", id, name: "x" })).error).toContain("not_found");
    expect(await listed()).toEqual(before);
  });
});
