/** GET /api/v1/orgs/:org carries an ETag; a repeat is a 304 until the organisation's body changes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam, listTeams } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("org ETag", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: string;
  let member: string;
  let memberId: string;
  let orgId: string;
  const O = "/api/v1/orgs/acme";

  const get = (path: string, token: string | null, extra: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-org-etag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice");
    const b = await mk("bob");
    memberId = b.id;
    owner = createToken(app.db, a.id, "admin", "admin").token;
    member = createToken(app.db, b.id, "admin", "admin").token;
    const org = createOrg(app.db, "acme", a.id);
    if (!org.ok) throw new Error(org.error);
    orgId = org.value.id;
    const t = createTeam(app.db, orgId, "docs", "write");
    if (!t.ok) throw new Error(t.error);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("200 with a weak tag, then 304 with the same headers and no body", async () => {
    const first = await get(O, owner);
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    expect(first.headers.get("content-type")).toContain("application/json");
    const text = await first.text();
    expect(JSON.parse(text).username).toBe("acme");
    const again = await get(O, owner, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toContain("authorization, cookie");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(await again.text()).toBe("");
  });

  test("the tag moves when the name shown or the teams shown change", async () => {
    const t0 = (await get(O, owner)).headers.get("etag")!;
    app.db.query("UPDATE user SET display_name = ?1 WHERE id = ?2").run("Acme Inc", orgId);
    const renamed = await get(O, owner, { "if-none-match": t0 });
    expect(renamed.status).toBe(200);
    const t1 = renamed.headers.get("etag")!;
    expect(t1).not.toBe(t0);
    expect((await get(O, owner, { "if-none-match": t1 })).status).toBe(304);
    expect(createTeam(app.db, orgId, "ops", "read").ok).toBe(true);
    const grown = await get(O, owner, { "if-none-match": t1 });
    expect(grown.status).toBe(200);
    expect(grown.headers.get("etag")).not.toBe(t1);
  });

  test("a member joining a team moves that member's tag, and viewers shown different bodies never share one", async () => {
    const ownerTag = (await get(O, owner)).headers.get("etag")!;
    const m0 = await get(O, member);
    expect(m0.status).toBe(200);
    const memberTag = m0.headers.get("etag")!;
    expect(memberTag).not.toBe(ownerTag);
    expect((await get(O, member, { "if-none-match": ownerTag })).status).toBe(200);
    const team = listTeams(app.db, orgId).find((t) => t.name === "docs")!;
    expect(addTeamMember(app.db, team, memberId)).toBe(true);
    const after = await get(O, member, { "if-none-match": memberTag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(memberTag);
  });

  test("an unknown organisation is 404 with no tag, even for If-None-Match: *", async () => {
    const tag = (await get(O, owner)).headers.get("etag")!;
    for (const held of [tag, "*"]) {
      for (const who of [owner, null]) {
        const out = await get("/api/v1/orgs/nope", who, { "if-none-match": held });
        expect(out.status).toBe(404);
        expect(out.headers.get("etag")).toBeNull();
      }
    }
  });
});
