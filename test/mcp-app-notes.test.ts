/**
 * The `app_notes` tool (#7214): an app's admin moderates the notes visitors
 * send from its forge button over MCP, as the studio card and the terminal
 * do. A note goes in through the button's endpoint (`apps/feedback.ts`); the
 * list, hide, ban and unban come back through `/mcp`; a writer who is not an
 * admin, and a read-only token, are refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { feedback } from "../src/apps/feedback.ts";
import { createApp as createAppRecord, type AppRecord } from "../src/core/apps.ts";
import { getNote, isBanned } from "../src/core/app_notes.ts";
import { getIssue } from "../src/core/issues.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { canAdmin, canWrite, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("MCP app_notes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let record: AppRecord;
  let writer: User;
  let ownerRw: string;
  let ownerRo: string;
  let writerRw: string;
  let id = 1;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "app_notes", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  /** A visitor with no account sends a note from the button, as the panel does. */
  const send = async (text: string, cookie = ""): Promise<{ id: string; cookie: string }> => {
    const host = "board.apps.test";
    const url = new URL(`http://${host}/__forge/note`);
    const res = await feedback({
      app,
      forgeUrl: servers.url,
      request: new Request(url.href, {
        method: "POST",
        headers: { host, origin: `http://${host}`, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ text, page: `http://${host}/cards`, viewport: "390x844" }),
      }),
      url,
      record,
      env: "production",
      sealed: false,
      viewerId: undefined,
      secure: false,
      source: `10.7.${id}.${Math.floor(Math.random() * 250)}`,
    });
    expect(res!.status).toBe(201);
    const j = (await res!.json()) as { note: { id: string } };
    return { id: j.note.id, cookie: cookie || (res!.headers.get("set-cookie") ?? "").split(";")[0]! };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-app-notes-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const person = async (username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const owner = await person("olga", true);
    writer = await person("wes");
    promote(app.db, owner, writer);
    const org = createOrg(app.db, "guild", owner.id);
    if (!org.ok) throw new Error("org");
    const writers = createTeam(app.db, org.value.id, "writers", "write");
    if (!writers.ok) throw new Error("team");
    addTeamMember(app.db, writers.value, writer.id);
    const made = await createRepo(app, owner, { owner: "guild", name: "board", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const rec = createAppRecord(app.db, { repoId: repo.id, slug: "board", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    record = rec.value;
    ownerRw = createToken(app.db, owner.id, "rw", "rw").token;
    ownerRo = createToken(app.db, owner.id, "ro", "ro").token;
    writerRw = createToken(app.db, writer.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the admin lists a note sent from the button, hides it, bans its sender and unbans them", async () => {
    const first = await send("The card titles wrap badly on my phone");
    const listed = await call(ownerRw, { app: "guild/board" });
    expect(listed.value.banned).toEqual([]);
    const shown = listed.value.notes.find((n: { id: string }) => n.id === first.id);
    expect(shown).toMatchObject({ text: "The card titles wrap badly on my phone", person: false, banned: false });
    expect(shown.page).toContain("/cards");

    // A read-only token lists, as the studio card shows, but may not act.
    expect((await call(ownerRo, { app: "guild/board" })).value.notes).toHaveLength(1);
    expect((await call(ownerRo, { app: "guild/board", action: "hide", note: first.id })).error).toMatch(/^forbidden/);
    expect(getNote(app.db, record.id, first.id)!.hidden).toBe(false);

    const hidden = await call(ownerRw, { app: "guild/board", action: "hide", note: first.id });
    expect(hidden.value).toMatchObject({ note: first.id, action: "hide" });
    expect(getNote(app.db, record.id, first.id)!.hidden).toBe(true);
    // Hiding closes the note's issue, as the studio's Hide does.
    expect(getIssue(app.db, repo.id, getNote(app.db, record.id, first.id)!.issueNumber)!.state).toBe("closed");
    expect((await call(ownerRw, { app: "guild/board" })).value.notes).toEqual([]);

    const second = await send("Please add a dark theme", first.cookie);
    await call(ownerRw, { app: "guild/board", action: "ban", note: second.id });
    const visitor = getNote(app.db, record.id, second.id)!.visitor;
    expect(isBanned(app.db, record.id, visitor)).toBe(true);
    const afterBan = (await call(ownerRw, { app: "guild/board" })).value;
    expect(afterBan.notes).toEqual([]);
    expect(afterBan.banned.map((n: { id: string; banned: boolean }) => [n.id, n.banned])).toEqual([[second.id, true]]);

    await call(ownerRw, { app: "guild/board", action: "unban", note: second.id });
    expect(isBanned(app.db, record.id, visitor)).toBe(false);
    expect((await call(ownerRw, { app: "guild/board" })).value.banned).toEqual([]);
  });

  test("a writer who is not an admin is refused, listing and acting", async () => {
    expect(canWrite(app.db, repo, writer)).toBe(true);
    expect(canAdmin(app.db, repo, writer)).toBe(false);
    const note = await send("A note the writer cannot touch");
    expect((await call(writerRw, { app: "guild/board" })).error).toMatch(/^forbidden/);
    for (const action of ["hide", "ban", "unban"])
      expect((await call(writerRw, { app: "guild/board", action, note: note.id })).error).toMatch(/^forbidden/);
    expect(getNote(app.db, record.id, note.id)!.hidden).toBe(false);
  });

  test("an unknown app or note is not_found, an unknown action invalid", async () => {
    expect((await call(ownerRw, { app: "guild/nothing" })).error).toMatch(/^not_found/);
    expect((await call(ownerRw, { app: "guild/board", action: "hide", note: "nonote00000" })).error).toMatch(/^not_found/);
    expect((await call(ownerRw, { app: "guild/board", action: "unban", note: "nonote00000" })).error).toMatch(/^not_found/);
    expect((await call(ownerRw, { app: "guild/board", action: "delete", note: "x" })).error).toMatch(/^invalid/);
    expect((await call(ownerRw, { app: "guild/board", action: "hide" })).error).toMatch(/^invalid/);
  });
});
