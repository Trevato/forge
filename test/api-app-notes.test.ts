/**
 * Moderating the forge button's notes over the API: a note sent through the
 * button's endpoint is listed, hidden, banned and unbanned by an admin of the
 * repository; a writer who is not an admin, a read-only token and a stranger
 * are refused.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { notesOfApp } from "../src/core/app_notes.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { setMember } from "../src/core/roles.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const BASE = "/api/v1/repos/acme/notes/app/notes";

describe("the app's notes over the API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-app-notes-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
    await runtime.start();
    const make = async (username: string, first = false): Promise<User> => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const siteAdmin = await make("siteadmin", true);
    const founder = await make("founder");
    const writer = await make("writer");
    const stranger = await make("stranger");
    setMember(app.db, founder.id, true, siteAdmin.id, new Date());
    const org = createOrg(app.db, "acme", founder.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "Writers", "write");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, writer.id);
    const made = await newApp(app, founder, { name: "notes", owner: "acme", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    tokens.founder = createToken(app.db, founder.id, "rw", "rw").token;
    tokens.readonly = createToken(app.db, founder.id, "ro", "ro").token;
    tokens.writer = createToken(app.db, writer.id, "rw", "rw").token;
    tokens.stranger = createToken(app.db, stranger.id, "rw", "rw").token;
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (who: string, path: string, method = "GET") =>
    fetch(`${servers.url}${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}` } });
  /** A note through the forge button's endpoint, from a fresh anonymous visitor. */
  let sends = 0;
  const send = async (text: string) => {
    const host = `notes.${DOMAIN}:${servers.port}`;
    const res = await fetch(`${servers.url}/__forge/note`, {
      method: "POST",
      headers: { host, origin: `http://${host}`, "content-type": "application/json", "x-forwarded-for": `10.7.0.${++sends}` },
      body: JSON.stringify({ text, page: `http://${host}/list`, viewport: "390x844" }),
    });
    expect(res.status).toBe(201);
  };
  const listed = async () => (await (await api("founder", BASE)).json()) as { notes: { id: string; text: string; banned: boolean }[]; banned: { id: string; banned: boolean }[] };

  test("an admin lists, hides, bans and unbans", async () => {
    await send("First note");
    await send("Second note");
    await send("Third note");
    const first = await listed();
    expect(first.notes.map((n) => n.text).sort()).toEqual(["First note", "Second note", "Third note"]);
    expect(first.banned).toEqual([]);

    const [a, b] = [first.notes.find((n) => n.text === "First note")!, first.notes.find((n) => n.text === "Second note")!];
    const hid = await api("founder", `${BASE}/${a.id}/hide`, "POST");
    expect(hid.status).toBe(200);
    expect(((await hid.json()) as { id: string }).id).toBe(a.id);
    expect((await listed()).notes.map((n) => n.id)).not.toContain(a.id);

    const ban = await api("founder", `${BASE}/${b.id}/ban`, "POST");
    expect(ban.status).toBe(200);
    expect(((await ban.json()) as { banned: boolean }).banned).toBe(true);
    const after = await listed();
    expect(after.notes.map((n) => n.id)).not.toContain(b.id);
    expect(after.banned.map((n) => n.id)).toEqual([b.id]);

    const unban = await api("founder", `${BASE}/${b.id}/unban`, "POST");
    expect(unban.status).toBe(200);
    expect(((await unban.json()) as { banned: boolean }).banned).toBe(false);
    expect((await listed()).banned).toEqual([]);
    const repo = getRepo(app.db, "acme", "notes")!;
    const record = getAppByRepo(app.db, repo.id)!;
    expect(notesOfApp(app.db, record.id)).toHaveLength(1);
  });

  test("a writer who is not an admin, a stranger and a read-only token are refused", async () => {
    await send("Another note");
    const id = (await listed()).notes[0]!.id;
    for (const who of ["writer", "stranger", "readonly"]) {
      expect((await api(who, BASE)).status).toBe(403);
      for (const action of ["hide", "ban", "unban"]) expect((await api(who, `${BASE}/${id}/${action}`, "POST")).status).toBe(403);
    }
    expect((await listed()).notes.map((n) => n.id)).toContain(id);
    expect((await fetch(`${servers.url}${BASE}`)).status).toBe(401);
  });

  test("an unknown note or a repository that is not an app is not found", async () => {
    expect((await api("founder", `${BASE}/nope/hide`, "POST")).status).toBe(404);
    expect((await api("founder", `${BASE}/nope/unban`, "POST")).status).toBe(404);
    expect((await api("founder", "/api/v1/repos/acme/missing/app/notes")).status).toBe(404);
  });
});
