/**
 * Roles, part 3a (#2384): a member is refused admin settings and releases
 * with a 403 and one plain sentence, on the API and on the page; an admin is
 * unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { mayRead, mayRollBack } from "../src/release/gate.ts";
import { SIGN_IN_AS_ADMIN, setMember } from "../src/core/roles.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a member is refused admin settings and releases", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let carol: User; // member

  const token = (u: User) => createToken(app.db, u.id, "admin", "admin").token;
  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
  const call = (method: string, path: string, u: User, body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token(u)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const visit = (method: string, path: string, u: User) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { cookie: cookie(u), origin: servers.url, accept: "text/html" },
      ...(method === "POST" ? { body: new URLSearchParams({}) } : {}),
      redirect: "manual",
    });
  const mk = async (username: string, admin = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...(admin ? { adminIfFirst: true } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-admin-refused-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = await mk("alice", true);
    carol = await mk("carol");
    setMember(app.db, carol.id, true, alice.id, new Date());
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const apiActs: [string, string, unknown?][] = [
    ["GET", "/api/v1/admin/capacity"],
    ["PUT", "/api/v1/admin/capacity/anything", { value: "on" }],
    ["GET", "/api/v1/admin/limits"],
    ["GET", "/api/v1/admin/settings"],
    ["GET", "/api/v1/admin/invites"],
    ["POST", "/api/v1/admin/invites", {}],
    ["GET", "/api/v1/admin/accounts"],
    ["GET", "/api/v1/admin/people"],
    ["POST", "/api/v1/admin/accounts/alice/suspend", {}],
  ];

  test("every admin API act: 403 and the sentence for a member, success for an admin", async () => {
    for (const [method, path, body] of apiActs) {
      const refused = await call(method, path, carol, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "not_admin", message: SIGN_IN_AS_ADMIN });
    }
    for (const path of ["/api/v1/admin/capacity", "/api/v1/admin/limits", "/api/v1/admin/people"])
      expect((await call("GET", path, alice)).status, path).toBe(200);
  });

  test("admin pages and releases: a plain 403 line for a member, the page for an admin", async () => {
    const pages: [string, string][] = [
      ["GET", "/admin/limits"],
      ["POST", "/admin/limits"],
      ["POST", "/admin/quotas"],
      ["POST", "/admin/signup"],
      ["GET", "/releases"],
      ["POST", `/releases/${"a".repeat(40)}/rollback`],
    ];
    for (const [method, path] of pages) {
      const refused = await visit(method, path, carol);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.text()).toContain(SIGN_IN_AS_ADMIN.replace("'", "&#39;"));
    }
    expect((await visit("GET", "/admin/limits", alice)).status).toBe(200);
    expect((await visit("GET", "/releases", alice)).status).toBe(200);
  });

  test("a member who writes the forge's repository is still refused /releases and a rollback", async () => {
    const repo = await createRepo(app, alice, { name: "forge", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    app.db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(carol.id, repo.value.id);
    app.config.forgeRepo = "carol/forge";
    expect(mayRollBack(app, carol)).toBe(false);
    expect(mayRead(app, carol)).toBe(false);
    for (const [m, p] of [["GET", "/releases"], ["POST", `/releases/${"a".repeat(40)}/rollback`]] as const)
      expect((await visit(m, p, carol)).status, p).toBe(403);
  });

  test("the public release list stays public, and a signed-out caller meets the old rules", async () => {
    expect((await fetch(`${servers.url}/releases.json`)).status).toBe(200);
    expect((await fetch(`${servers.url}/api/v1/admin/capacity`)).status).not.toBe(403);
  });
});
