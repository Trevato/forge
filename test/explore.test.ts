/**
 * Explore (#607): apps and people ranked by real numbers, with the numbers
 * on each row, narrowed in one line, on the page, the API and MCP alike —
 * and only what the viewer may see: no private repository, no agent's
 * working fork, no private app's hours for those who may not enter it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { exploreLine, parseExploreQuery } from "../src/actions/explore.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("the one line", () => {
  test("kind and sort take a word each; the rest is text; unknown words are text, not errors", () => {
    expect(parseExploreQuery("kind:app sort:forks garden")).toEqual({
      kind: "app",
      sort: "forks",
      text: "garden",
      archived: false,
    });
    expect(parseExploreQuery("kind:people q:dungeon")).toEqual({
      kind: "person",
      sort: "score",
      text: "dungeon",
      archived: false,
    });
    expect(parseExploreQuery("kind:nonsense sort:nonsense")).toEqual({
      kind: "all",
      sort: "score",
      text: "sort:nonsense",
      archived: false,
    });
    expect(parseExploreQuery("archived:yes").archived).toBe(true);
    expect(exploreLine(parseExploreQuery("archived:yes kind:app"))).toBe(
      "kind:app archived:yes",
    );
    expect(exploreLine(parseExploreQuery("  sort:ships   kind:app  "))).toBe(
      "kind:app sort:ships",
    );
  });
});

describe("explore", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let ghost: User;
  let aliceToken: string;
  let bobToken: string;

  const user = async (username: string) => {
    const made = await createUser(app.db, {
      origin: "seed",
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    proveAll(app);
    promote(app.db, made.value);
    return made.value;
  };
  const appOf = async (
    owner: User,
    name: string,
    o: { visibility?: "public" | "private"; access?: "public" | "private" } = {},
  ): Promise<Repo> => {
    const made = await createRepo(app, owner, {
      name,
      visibility: o.visibility ?? "public",
      description: `the ${name} app`,
    });
    if (!made.ok) throw new Error(String(made.error));
    const record = insertApp(app.db, {
      repoId: made.value.id,
      slug: `${owner.username}-${name}`,
      access: o.access ?? o.visibility ?? "public",
    });
    if (!record.ok) throw new Error(record.error);
    return made.value;
  };
  const merged = (repo: Repo, author: User, n: number) => {
    for (let i = 0; i < n; i++) {
      const made = createIssue(app.db, {
        repoId: repo.id,
        authorId: author.id,
        title: `change ${i}`,
        kind: "pull",
      });
      if (!made.ok) throw new Error(made.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, 'main', ?2, '', '', ?3)`,
        )
        .run(made.value.id, `b${i}`, new Date(Date.now() - (i + 1) * 3_600_000).toISOString());
    }
  };
  const forkOf = async (parent: Repo, owner: User, name: string) => {
    const made = await createRepo(app, owner, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    app.db
      .query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`)
      .run(parent.id, made.value.id);
  };
  const api = async (q: string, token?: string) =>
    (await (
      await fetch(`${base}/api/v1/explore?q=${encodeURIComponent(q)}`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      })
    ).json()) as { query: string; items: any[] };
  const names = (items: any[]) => items.map((r) => r.name);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explore-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await user("alice");
    bob = await user("bob");
    ghost = await user("ghost");
    aliceToken = createToken(app.db, alice.id, "ro", "ro").token;
    bobToken = createToken(app.db, bob.id, "ro", "ro").token;
    const loved = await appOf(alice, "loved");
    await forkOf(loved, bob, "loved-mine");
    await forkOf(loved, await user("carl"), "loved-too");
    merged(loved, alice, 1);
    await forkOf(loved, ghost, "loved-ghost");
    await appOf(alice, "quiet");
    const busy = await appOf(bob, "busy");
    merged(busy, bob, 3);
    await appOf(alice, "secret", { visibility: "private" });
    // An agent's working fork with an app: how the crew builds, not a find.
    await appOf(ghost, "worker");
    app.db.query(`UPDATE user SET is_agent = 1 WHERE id = ?1`).run(ghost.id);
    // A public repository whose app only its writers may enter.
    const gated = await appOf(alice, "gated", { access: "private" });
    app.db
      .query(
        `INSERT INTO meter (repo_id, env, placement, started_at, beat_at, ended_at)
         VALUES (?1, 'production', 'owned', ?2, ?3, ?3)`,
      )
      .run(gated.id, new Date(Date.now() - 5 * 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString());
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger sees public apps and their makers, never a private repository or an agent's working fork", async () => {
    const { items } = await api("");
    const shown = names(items);
    for (const name of ["alice/loved", "alice/quiet", "bob/busy", "alice/gated", "alice", "bob"])
      expect(shown).toContain(name);
    expect(shown).not.toContain("alice/secret");
    expect(shown).not.toContain("ghost/worker");
    expect(shown).not.toContain("ghost");
    // Forges are a site admin's to see.
    expect((await api("kind:forge")).items).toEqual([]);
    expect(items.every((r) => r.kind !== "forge")).toBe(true);
  });

  test("ranked by real numbers, each row with them: forks by people first, then ships", async () => {
    const { items } = await api("kind:app");
    expect(items[0].name).toBe("alice/loved");
    // Two forks by people; the agent's fork is not one.
    expect(items[0].numbers.forks).toBe(2);
    const byShips = (await api("kind:app sort:ships")).items;
    expect(byShips[0].name).toBe("bob/busy");
    expect(byShips[0].numbers.ships).toBe(3);
    expect(byShips[0].shippedAt).not.toBeNull();
    const people = (await api("kind:person")).items;
    expect(people.every((r) => r.kind === "person")).toBe(true);
    const aliceRow = people.find((r) => r.name === "alice");
    expect(aliceRow.numbers.apps).toBe(3);
    expect((await api("busy")).items.map((r) => r.name)).toEqual(["bob/busy"]);
  });

  test("a private app's hours in use are told only to those who may enter it", async () => {
    const stranger = (await api("gated")).items.find((r) => r.name === "alice/gated");
    expect(stranger.numbers.awakeHours).toBe(0);
    const reader = (await api("gated", bobToken)).items.find((r) => r.name === "alice/gated");
    expect(reader.numbers.awakeHours).toBe(0);
    const owner = (await api("gated", aliceToken)).items.find((r) => r.name === "alice/gated");
    expect(owner.numbers.awakeHours).toBeGreaterThan(3);
    // The owner also sees their private repository.
    expect(names((await api("", aliceToken)).items)).toContain("alice/secret");
  });

  test("the page and MCP answer the same rows; the line stays in the URL; Make it yours is for someone signed in", async () => {
    const page = await (await fetch(`${base}/explore?q=${encodeURIComponent("kind:app sort:ships")}`)).text();
    expect(page).toContain('value="kind:app sort:ships"');
    expect(page.indexOf('href="/bob/busy"')).toBeLessThan(page.indexOf('href="/alice/loved"'));
    expect(page).not.toContain("Make it yours");
    expect(page).not.toContain("alice/secret");
    const signedIn = await (
      await fetch(`${base}/explore`, {
        headers: { authorization: `Bearer ${bobToken}` },
      })
    ).text();
    expect(signedIn).toContain('href="/alice/loved/make-it-yours"');
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bobToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "explore", arguments: { query: "kind:app sort:ships" } },
      }),
    });
    const told = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(names(told.items)).toEqual(names((await api("kind:app sort:ships", bobToken)).items));
  });

  test("the page draws §5's row and filters, and no explore- class", async () => {
    const page = await (await fetch(`${base}/explore`)).text();
    expect(page).toContain('class="row"');
    expect(page).toContain('class="row-title"');
    expect(page).toContain(`<div class="bar mb">`);
    expect(page).not.toMatch(/class="[^"]*\bfilters\b/);
    expect(page).not.toContain("explore-");
  });

  test("a suspended account's apps and the account itself are offered to nobody", async () => {
    const sus = await user("sus");
    await appOf(sus, "susapp");
    expect(names((await api("")).items)).toContain("sus/susapp");
    const done = await suspendAccount(app, alice, "sus");
    expect(done.ok).toBe(true);
    for (const token of [undefined, bobToken, aliceToken]) {
      const shown = names((await api("", token)).items);
      expect(shown).not.toContain("sus/susapp");
      expect(shown).not.toContain("sus");
    }
  });

  test("Make it yours is offered only where it can be made: not a private app to a reader, not the viewer's own app (#922)", async () => {
    const asBob = await (
      await fetch(`${base}/explore`, { headers: { authorization: `Bearer ${bobToken}` } })
    ).text();
    expect(asBob).toContain('href="/alice/loved/make-it-yours"');
    // alice/gated is a public repository whose app only its writers enter.
    expect(asBob).not.toContain('href="/alice/gated/make-it-yours"');
    const rows = (await api("kind:app", bobToken)).items;
    expect(rows.find((r) => r.name === "alice/gated").copyable).toBe(false);
    expect(rows.find((r) => r.name === "alice/loved").copyable).toBe(true);
    // Its own apps are not offered back to their owner.
    const asAlice = await (
      await fetch(`${base}/explore`, { headers: { authorization: `Bearer ${aliceToken}` } })
    ).text();
    expect(asAlice).not.toContain('href="/alice/loved/make-it-yours"');
  });
});

describe("explore on a forge with nothing public", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explore-empty-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      username: "lone",
      email: "lone@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    token = createToken(app.db, made.value.id, "ro", "ro").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = async (path: string, signedIn: boolean) =>
    (
      await fetch(`${servers.url}${path}`, {
        headers: signedIn ? { authorization: `Bearer ${token}` } : {},
      })
    ).text();

  test("no query says nothing is public yet and how to make the first app", async () => {
    const out = await get("/explore", false);
    expect(out).toContain("Nothing public yet");
    expect(out).toContain('href="/signin?next=/apps/new"');
    expect(out).not.toContain("Clear the line");
    const mine = await get("/explore", true);
    expect(mine).toContain("Nothing public yet");
    expect(mine).toContain('href="/apps/new"');
    expect(mine).not.toContain("Sign in to make one");
  });

  test("a query with no hits still says nothing matches", async () => {
    for (const signedIn of [false, true]) {
      const out = await get(`/explore?q=${encodeURIComponent("zzz-no-such")}`, signedIn);
      expect(out).toContain("Nothing matches");
      expect(out).toContain("Clear the line");
      expect(out).not.toContain("Nothing public yet");
    }
  });
});
