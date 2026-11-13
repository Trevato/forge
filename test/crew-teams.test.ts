/**
 * Crew teams (#2679): four to start, dials at 0; an admin sets design to 30%
 * and reads it back; a non-admin gets the 404; the dials never sum past 100;
 * an agent may be on two teams, whatever its model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { teamChanges } from "../src/actions/teams.ts";
import { listEvents } from "../src/core/events.ts";
import { listTeams } from "../src/core/teams.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("crew teams", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let bots: User[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-teams-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const username of ["alice", "bob", "bot1", "bot2"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else if (username === "bob") bob = made.value;
      else {
        bots.push(made.value);
        createAgentRow(app.db, { userId: made.value.id, model: username === "bot1" ? "opus" : "haiku" });
      }
    }
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
  const post = (u: User, slug: string, body: URLSearchParams, origin = servers.url) =>
    fetch(`${servers.url}/settings/teams/${slug}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookie(u), "content-type": "application/x-www-form-urlencoded", origin },
      body,
    });
  const dialOf = (slug: string) => listTeams(app.db).find((t) => t.slug === slug)!.dial;

  test("a forge starts with four teams, dials at 0", () => {
    const teams = listTeams(app.db);
    expect(teams.map((t) => t.slug)).toEqual(["design", "data-science", "security", "platform"]);
    expect(teams.every((t) => t.dial === 0 && t.charter !== "")).toBe(true);
  });

  test("an admin sets design to 30% and reads it back on the page", async () => {
    const res = await post(alice, "design", new URLSearchParams({ charter: "Owns <b>looks</b>", dial: "30" }));
    expect(res.status).toBe(303);
    expect(dialOf("design")).toBe(30);
    const text = await (await fetch(`${servers.url}/settings/teams/design`, { headers: { cookie: cookie(alice) } })).text();
    expect(text).toContain('value="30"');
    expect(text).toContain("Owns &lt;b&gt;looks");
    expect(text).not.toContain("Owns <b>looks");
  });

  test("a non-admin gets 403 on read and write, and a cross-origin post is refused", async () => {
    const page = await fetch(`${servers.url}/settings/teams`, { headers: { cookie: cookie(bob) } });
    expect(page.status).toBe(403);
    expect((await post(bob, "design", new URLSearchParams({ dial: "90" }))).status).toBe(403);
    expect(dialOf("design")).toBe(30);
    expect((await post(alice, "design", new URLSearchParams({ dial: "5" }), "http://evil.example")).status).toBe(403);
    expect(dialOf("design")).toBe(30);
  });

  test("the dials cannot sum past 100", async () => {
    await post(alice, "security", new URLSearchParams({ dial: "70" }));
    expect(dialOf("security")).toBe(70);
    await post(alice, "platform", new URLSearchParams({ dial: "1" }));
    expect(dialOf("platform")).toBe(0);
    await post(alice, "design", new URLSearchParams({ dial: "31" }));
    expect(dialOf("design")).toBe(30);
    for (const bad of ["101", "-1", "abc", "", "1.5"]) {
      await post(alice, "platform", new URLSearchParams({ dial: bad }));
      expect(dialOf("platform")).toBe(0);
    }
  });

  test("an agent can be on two teams, and a team holds agents on different models", async () => {
    const [b1, b2] = bots as [User, User];
    const members = (ids: string[]) => {
      const p = new URLSearchParams({ dial: "0" });
      for (const id of ids) p.append("member", id);
      return p;
    };
    await post(alice, "platform", members([b1.id, b2.id]));
    await post(alice, "data-science", members([b1.id]));
    const byTeam = Object.fromEntries(listTeams(app.db).map((t) => [t.slug, t.members]));
    expect(byTeam["platform"]!.sort()).toEqual([b1.id, b2.id].sort());
    expect(byTeam["data-science"]).toEqual([b1.id]);
    // A person is not an agent.
    const refused = await post(alice, "platform", members([bob.id]));
    const told = decodeURIComponent(
      `${refused.headers.get("location") ?? ""} ${refused.headers.get("set-cookie") ?? ""}`,
    ).replace(/\+/g, " ");
    expect(told).toContain("must be an agent");
    expect(listTeams(app.db).find((t) => t.slug === "platform")!.members.length).toBe(2);
  });

  const api = (u: User, method: string, path: string, body?: unknown, scope: "ro" | "admin" = "admin") =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createToken(app.db, u.id, "t", scope).token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const mcp = async (u: User, name: string, args: unknown, scope: "ro" | "admin" = "admin") => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${createToken(app.db, u.id, "t", scope).token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  };

  test("the JSON API reads and sets a team, keeps what is left out, and refuses the rest", async () => {
    const [b1] = bots as [User];
    expect((await api(alice, "GET", "/api/v1/admin/teams")).status).toBe(200);
    const set = await api(alice, "PUT", "/api/v1/admin/teams/design", { dial: 25, members: [b1.id] });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ slug: "design", dial: 25, members: [b1.id] });
    await api(alice, "PUT", "/api/v1/admin/teams/design", { charter: "Owns the look." });
    const kept = listTeams(app.db).find((t) => t.slug === "design")!;
    expect([kept.charter, kept.dial, kept.members]).toEqual(["Owns the look.", 25, [b1.id]]);
    expect((await api(alice, "PUT", "/api/v1/admin/teams/design", { dial: 101 })).status).toBe(422);
    expect((await api(alice, "PUT", "/api/v1/admin/teams/design", { dial: 1.5 })).status).toBe(422);
    expect((await api(alice, "PUT", "/api/v1/admin/teams/design", { members: [bob.id] })).status).toBe(422);
    expect((await api(alice, "PUT", "/api/v1/admin/teams/nope", { dial: 1 })).status).toBe(404);
    expect((await api(alice, "PUT", "/api/v1/admin/teams/design", { dial: 5 }, "ro")).status).toBe(403);
    expect((await api(bob, "GET", "/api/v1/admin/teams")).status).toBe(403);
    expect((await api(bob, "PUT", "/api/v1/admin/teams/design", { dial: 1 })).status).toBe(403);
    expect(listTeams(app.db).find((t) => t.slug === "design")!.dial).toBe(25);
  });

  test("the teams tool plans by default, changes with dryRun false, and is not for a non-admin", async () => {
    expect(JSON.stringify(await mcp(alice, "teams", { slug: "security", dial: 101 }))).toContain(
      "A dial is a whole number from 0 to 100.",
    );
    const dryOver = JSON.stringify(await mcp(alice, "teams", { slug: "security", dial: 90 }));
    expect(dryOver).toContain("The dials together may not pass 100%.");
    expect(dryOver).not.toContain("Would change");
    expect(JSON.stringify(await mcp(alice, "teams", { slug: "security", members: [bob.id] }))).toContain(
      "A member must be an agent",
    );
    const planned = await mcp(alice, "teams", { slug: "security", dial: 10 });
    expect(planned.says).toContain("Would change");
    expect(listTeams(app.db).find((t) => t.slug === "security")!.dial).toBe(70);
    const done = await mcp(alice, "teams", { slug: "security", dial: 10, dryRun: false });
    expect(done).toMatchObject({ slug: "security", dial: 10 });
    expect(listTeams(app.db).find((t) => t.slug === "security")!.dial).toBe(10);
    const over = await mcp(alice, "teams", { slug: "security", dial: 90, dryRun: false });
    expect(JSON.stringify(over)).toContain("The dials together may not pass 100%.");
    const kept = teamChanges(app).filter((c) => c.slug === "security");
    expect(kept[0]).toMatchObject({ actorName: "alice" });
    expect(kept[0]!.to).toStartWith("10%");
    expect(listEvents(app.db, { kind: "team.changed" }).some((e) => e.payload["slug"] === "security")).toBe(true);
    expect(JSON.stringify(await mcp(bob, "teams", {}))).toContain("not_found");
    expect(listTeams(app.db).find((t) => t.slug === "security")!.dial).toBe(10);
  });
});
