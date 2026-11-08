/** The org teams and team members lists carry an ETag; a repeat is a 304 until a team or its members change. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg, createTeam } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("org teams ETag", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: string;
  let stranger: string;

  const send = (path: string, token: string | null, method = "GET", extra: Record<string, string> = {}, payload?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...extra,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  const T = "/api/v1/orgs/acme/teams";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-org-teams-etag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice");
    await mk("bob");
    await mk("dave");
    const c = await mk("carol");
    owner = createToken(app.db, a.id, "admin", "admin").token;
    stranger = createToken(app.db, c.id, "admin", "admin").token;
    const org = createOrg(app.db, "acme", a.id);
    if (!org.ok) throw new Error(org.error);
    for (const name of ["docs", "ops"]) {
      const team = createTeam(app.db, org.value.id, name, "write");
      if (!team.ok) throw new Error(team.error);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the teams list is 200 with a weak tag, then 304 with the same headers and no body", async () => {
    const first = await send(T, owner);
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    expect(((await first.json()) as { items: unknown[] }).items.length).toBe(3);
    const again = await send(T, owner, "GET", { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toContain("authorization, cookie");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(await again.text()).toBe("");
  });

  test("creating and removing a team moves the teams tag", async () => {
    const t0 = (await send(T, owner)).headers.get("etag")!;
    expect((await send(T, owner, "POST", {}, { name: "extra" })).status).toBe(201);
    const t1 = await send(T, owner, "GET", { "if-none-match": t0 });
    expect(t1.status).toBe(200);
    const tag1 = t1.headers.get("etag")!;
    expect(tag1).not.toBe(t0);
    expect((await send(`${T}/extra`, owner, "DELETE")).status).toBe(204);
    const t2 = await send(T, owner, "GET", { "if-none-match": tag1 });
    expect(t2.status).toBe(200);
    expect(t2.headers.get("etag")).not.toBe(tag1);
  });

  test("a member added or removed moves that team's tag and not another's", async () => {
    const docs = `${T}/docs/members`;
    const ops = `${T}/ops/members`;
    const d0 = (await send(docs, owner)).headers.get("etag")!;
    const o0 = (await send(ops, owner)).headers.get("etag")!;
    expect(d0).toMatch(/^W\//);
    expect((await send(docs, owner, "GET", { "if-none-match": d0 })).status).toBe(304);
    expect((await send(docs, owner, "POST", {}, { user: "bob" })).status).toBe(201);
    const d1 = await send(docs, owner, "GET", { "if-none-match": d0 });
    expect(d1.status).toBe(200);
    const dTag = d1.headers.get("etag")!;
    expect(dTag).not.toBe(d0);
    expect((await send(ops, owner, "GET", { "if-none-match": o0 })).status).toBe(304);
    expect((await send(`${T}/docs/members/bob`, owner, "DELETE")).status).toBe(204);
    const d2 = await send(docs, owner, "GET", { "if-none-match": dTag });
    expect(d2.status).toBe(200);
    expect(d2.headers.get("etag")).not.toBe(dTag);
    expect((await send(ops, owner, "GET", { "if-none-match": o0 })).status).toBe(304);
  });

  test("a 404 carries no tag and a viewer who cannot see the team never gets a 304", async () => {
    const own = (await send(`${T}/docs/members`, owner)).headers.get("etag")!;
    for (const path of ["/api/v1/orgs/nope/teams", "/api/v1/orgs/nope/teams/x/members", `${T}/nope/members`]) {
      const out = await send(path, owner, "GET", { "if-none-match": own });
      expect(out.status, path).toBe(404);
      expect(out.headers.get("etag"), path).toBeNull();
    }
    for (const who of [stranger, null]) {
      for (const t of [own, "*"]) {
        const out = await send(`${T}/docs/members`, who, "GET", { "if-none-match": t });
        expect(out.status).toBe(404);
        expect(out.headers.get("etag")).toBeNull();
      }
    }
    const ownTeams = (await send(T, owner)).headers.get("etag")!;
    const theirs = await send(T, stranger, "GET", { "if-none-match": ownTeams });
    expect(theirs.status).toBe(200);
    expect(theirs.headers.get("etag")).not.toBe(ownTeams);
  });

  test("a refused write carries no tag", async () => {
    const out = await send(T, stranger, "POST", {}, { name: "mine" });
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(out.headers.get("etag")).toBeNull();
  });
});
