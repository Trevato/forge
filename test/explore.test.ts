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
import { explorePage, exploreLine, isExploreLine, parseExploreQuery } from "../src/actions/explore.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { edgeLoginUrl } from "../src/http/edge.ts";
import { forgeHttp, serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("the one line", () => {
  test("kind and sort take a word each; the rest is text; unknown kind and sort words are dropped, not errors", () => {
    expect(parseExploreQuery("kind:app sort:forks garden")).toEqual({
      kind: "app",
      sort: "forks",
      text: "garden",
      archived: false,
      updated: "all",
    });
    expect(parseExploreQuery("kind:people q:dungeon")).toEqual({
      kind: "person",
      sort: "score",
      text: "dungeon",
      archived: false,
      updated: "all",
    });
    expect(parseExploreQuery("kind:nonsense sort:nonsense")).toEqual({
      kind: "all",
      sort: "score",
      text: "",
      archived: false,
      updated: "all",
    });
    expect(parseExploreQuery("archived:yes").archived).toBe(true);
    expect(exploreLine(parseExploreQuery("archived:yes kind:app"))).toBe(
      "kind:app archived:yes",
    );
    expect(parseExploreQuery("updated:7d").updated).toBe("7d");
    expect(parseExploreQuery("updated:2y").updated).toBe("all");
    expect(parseExploreQuery("updated:2y").text).toBe("");
    expect(parseExploreQuery("updated:").text).toBe("updated:");
    expect(exploreLine(parseExploreQuery("updated:30d kind:app garden"))).toBe(
      "kind:app updated:30d garden",
    );
    expect(exploreLine(parseExploreQuery("  sort:ships   kind:app  "))).toBe(
      "kind:app sort:ships",
    );
  });
});

describe("owner:", () => {
  test("is parsed as a username, written back, and ignored when hostile", () => {
    const q = parseExploreQuery("kind:app owner:alice garden");
    expect(q.owner).toBe("alice");
    expect(q.text).toBe("garden");
    expect(exploreLine(q)).toBe("kind:app owner:alice garden");
    for (const bad of ["owner:", "owner:../x", "owner:<script>", "owner:a/b"]) {
      expect(parseExploreQuery(bad).owner).toBeUndefined();
    }
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
    expect(page).toContain("Make it yours");
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

  test("owner: keeps one account's apps; a person row links its apps there", async () => {
    expect(names((await api("kind:app owner:alice")).items).sort()).toEqual(["alice/gated", "alice/loved", "alice/quiet"]);
    expect(names((await api("kind:app owner:bob")).items)).toEqual(["bob/busy"]);
    expect(names((await api("owner:bob")).items).sort()).toEqual(["bob", "bob/busy"]);
    const bad = await api("kind:app owner:..");
    expect((bad as { message?: string }).message).toBe("owner:.. is not a name");
    const page = await (await fetch(`${base}/explore?q=kind:person`)).text();
    expect(page).toContain(`href="/explore?q=${encodeURIComponent("kind:app owner:bob")}">1 app</a>`);
  });

  test("a hostile owner stays escaped text on the page", async () => {
    const page = await (await fetch(`${base}/explore?q=${encodeURIComponent("owner:<script>alert(1)</script>")}`)).text();
    expect(page).not.toContain("<script>alert(1)");
    expect(page).toContain("&lt;script&gt;alert(1)");
  });

  test("the page draws §5's row and filters, and no explore- class", async () => {
    const page = await (await fetch(`${base}/explore`)).text();
    expect(page).toContain('class="row"');
    expect(page).toContain('class="row-title"');
    expect(page).toContain(`<nav class="tabs" aria-label="Kind">`);
    expect(page).toContain(`<div class="bar mb small">`);
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

  test("Make it yours is offered to a signed-out visitor on public apps only, linking to the make-it-yours path", async () => {
    const rows = (await api("kind:app")).items;
    expect(rows.find((r) => r.name === "alice/loved").copyable).toBe(true);
    // A public repository whose app only its writers enter is shown, not
    // copyable; a private app is not among a guest's rows at all.
    expect(rows.find((r) => r.name === "alice/gated").copyable).toBe(false);
    expect(rows.find((r) => r.name === "alice/secret")).toBeUndefined();
    const page = await (await fetch(`${base}/explore`)).text();
    expect(page).toContain('href="/alice/loved/make-it-yours"');
    expect(page).not.toContain('href="/alice/gated/make-it-yours"');
    expect(page).not.toContain("alice/secret");
  });

  test("the signed-out Make it yours link carries the visitor through sign-in to the plan of their copy, and makes no copy", async () => {
    const path = "/alice/loved/make-it-yours";
    const next = encodeURIComponent(path);
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/signin?next=${next}`);
    const copies = () => (app.db.query(`SELECT COUNT(*) AS n FROM repo WHERE owner_id = ?1`).get(bob.id) as { n: number }).n;
    const before = copies();
    const signedIn = await fetch(`${base}/signin?next=${next}`, {
      method: "POST",
      body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(path);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    const plan = await fetch(`${base}${signedIn.headers.get("location")}`, { headers: { cookie } });
    expect(plan.status).toBe(200);
    const body = await plan.text();
    expect(body).toContain("Make it yours");
    expect(body).toContain("Yours as");
    // Only the plan: the copy is made by the POST.
    expect(copies()).toBe(before);
  });

  test("updated: narrows to what moved in the window, on the API and the page chips", async () => {
    const ago = async (name: string, days: number) => {
      const repo = await appOf(alice, name);
      const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "c", kind: "pull" });
      if (!issue.ok) throw new Error(issue.error);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, 'main', 'b', '', '', ?2)`,
        )
        .run(issue.value.id, new Date(Date.now() - days * 86_400_000).toISOString());
    };
    await ago("two-days", 2);
    await ago("twenty-days", 20);
    const inWindow = async (w: string) =>
      names((await api(`kind:app updated:${w}`)).items);
    expect(await inWindow("1d")).not.toContain("alice/two-days");
    expect(await inWindow("1d")).toContain("alice/loved");
    expect(await inWindow("7d")).toContain("alice/two-days");
    expect(await inWindow("7d")).not.toContain("alice/twenty-days");
    expect(await inWindow("30d")).toContain("alice/twenty-days");
    expect(await inWindow("30d")).not.toContain("alice/quiet");
    expect((await api("updated:7d kind:app")).query).toBe("kind:app updated:7d");

    const page = await (await fetch(`${base}/explore?q=${encodeURIComponent("updated:7d")}`)).text();
    for (const [label, w] of [["Today", "1d"], ["This week", "7d"], ["This month", "30d"]] as const) {
      expect(page).toContain(`href="/explore?q=updated%3A${w}"`);
      expect(page).toContain(label);
    }
    expect(page).toMatch(/aria-current="page"\s*>This week/);
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

  test("the Forges chip is a site admin's: current on kind:forge, sort kept, absent for a guest", async () => {
    const chip = (q: string) => new RegExp(`<a[^>]*href="/explore\\?q=${q}"[^>]*>\\s*Forges</a\\s*>`);
    const sorted = await get(`/explore?q=${encodeURIComponent("sort:forks")}`, true);
    expect(sorted).toContain(`href="/explore?q=${encodeURIComponent("kind:forge sort:forks")}"`);
    const page = await get(`/explore?q=${encodeURIComponent("kind:forge")}`, true);
    const tag = page.match(chip("kind%3Aforge"))?.[0] ?? "";
    expect(tag).toContain("aria-current");
    const guest = await get(`/explore?q=${encodeURIComponent("kind:forge")}`, false);
    expect(guest).not.toMatch(/>\s*Forges</);
    expect(guest).toContain("Nothing");
  });

  test("no query says nothing is public yet and how to make the first app", async () => {
    const out = await get("/explore", false);
    expect(out).toContain("Nothing public yet");
    expect(out).toContain('href="/signin?next=/apps/new"');
    expect(out).toContain('href="/signup?next=/apps/new"');
    expect(out).toContain("Create an account");
    expect(out).not.toContain("Clear the line");
    const mine = await get("/explore", true);
    expect(mine).toContain("Nothing public yet");
    expect(mine).toContain('href="/apps/new"');
    expect(mine).not.toContain("Create an account");
  });

  test("a query with no hits still says nothing matches", async () => {
    for (const signedIn of [false, true]) {
      const out = await get(`/explore?q=${encodeURIComponent("zzz-no-such")}`, signedIn);
      expect(out).toContain("Nothing matches");
      expect(out).toContain("Nothing matches zzz-no-such");
      expect(out).toContain("Clear all");
      expect(out).not.toContain("Nothing public yet");
    }
  });

  test("a miss names the line and offers each term as a link that drops it", async () => {
    const out = await get(`/explore?q=${encodeURIComponent("kind:app zzz-no-such")}`, false);
    expect(out).toContain("Nothing matches kind:app zzz-no-such");
    expect(out).toContain(`href="/explore?q=${encodeURIComponent("zzz-no-such")}"`);
    expect(out).toContain(`href="/explore?q=${encodeURIComponent("kind:app")}"`);
    expect(out).toContain('href="/explore"');
  });

  test("a window with no hits offers to drop it, and the seg has an Any time chip", async () => {
    const out = await get(`/explore?q=${encodeURIComponent("updated:1d zzz-no-such")}`, false);
    expect(out).toContain(`href="/explore?q=${encodeURIComponent("zzz-no-such")}"`);
    expect(out).toContain(`href="/explore?q=${encodeURIComponent("updated:1d")}"`);
    const only = await get(`/explore?q=${encodeURIComponent("updated:1d kind:person zzz")}`, false);
    expect(only).toContain(`href="/explore?q=${encodeURIComponent("kind:person zzz")}"`);
    expect(only).toContain("Any time");
    expect(only).toMatch(/aria-current="page"\s*>Today/);
    const none = await get(`/explore?q=${encodeURIComponent("zzz")}`, false);
    expect(none).toMatch(/aria-current="page"\s*>Any time/);
  });

  test("many words and a long one sit in a wrapping group, not a list row", async () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`).join(" ");
    const long = "x".repeat(60);
    const out = await get(`/explore?q=${encodeURIComponent(`${words} ${long}`)}`, false);
    const group = out.slice(out.indexOf("Drop a term"));
    expect(group).toContain('class="form-actions"');
    expect(group.slice(0, group.indexOf("Clear all"))).not.toContain('class="row"');
    expect(group).toContain(`>${"x".repeat(23)}…</a`);
    expect(group).toContain(`title="Drop ${long}"`);
  });

  test("a hostile word is escaped in the title and the links", async () => {
    const out = await get(`/explore?q=${encodeURIComponent("<script>x</script>")}`, false);
    expect(out).not.toContain("<script>x");
    expect(out).toContain("Nothing matches &lt;script&gt;x&lt;/script&gt;");
  });
});

describe("explore past the first page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  const COUNT = 70;

  const get = async (q: string, cursor?: string) =>
    fetch(
      `${servers.url}/api/v1/explore?q=${encodeURIComponent(q)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explore-pages-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      username: "paged",
      email: "paged@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    proveAll(app);
    promote(app.db, made.value);
    token = createToken(app.db, made.value.id, "ro", "ro").token;
    for (let i = 0; i < COUNT; i++) {
      const name = `r${String(i).padStart(3, "0")}`;
      const repo = await createRepo(app, made.value, { name, visibility: "public", description: name });
      if (!repo.ok) throw new Error(String(repo.error));
      const record = insertApp(app.db, { repoId: repo.value.id, slug: `paged-${name}`, access: "public" });
      if (!record.ok) throw new Error(record.error);
    }
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const sort of ["score", "name"]) {
    test(`following next_cursor reaches every app once, in rank order (sort:${sort})`, async () => {
      const q = `kind:app sort:${sort}`;
      const first = (await (await get(q)).json()) as any;
      expect(first.items.length).toBe(60);
      expect(typeof first.next_cursor).toBe("string");
      const seen: string[] = first.items.map((r: any) => r.name);
      let cursor: string | null = first.next_cursor;
      let pages = 1;
      while (cursor !== null) {
        const page = (await (await get(q, cursor)).json()) as any;
        seen.push(...page.items.map((r: any) => r.name));
        cursor = page.next_cursor;
        pages++;
      }
      expect(pages).toBe(2);
      expect(seen.length).toBe(COUNT);
      expect(new Set(seen).size).toBe(COUNT);
      expect(seen).toEqual([...seen].sort());
    });
  }

  test("the last page and a short list answer next_cursor null", async () => {
    const short = (await (await get("r001")).json()) as any;
    expect(short.next_cursor).toBeNull();
  });

  test("a malformed cursor, or one from another sort, is refused", async () => {
    for (const bad of ["!!", "x".repeat(500), Buffer.from("[1,2]").toString("base64url")]) {
      const res = await get("kind:app", bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_cursor");
    }
    const first = (await (await get("kind:app")).json()) as any;
    expect((await get("kind:app sort:name", first.next_cursor)).status).toBe(400);
  });

  test("MCP explore takes the cursor and answers next_cursor", async () => {
    const call = async (args: object) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: args } }),
      });
      return (await res.json()) as any;
    };
    const first = JSON.parse((await call({ query: "kind:app" })).result.content[0].text);
    expect(first.items.length).toBe(60);
    const second = JSON.parse((await call({ query: "kind:app", cursor: first.next_cursor })).result.content[0].text);
    expect(second.items.length).toBe(COUNT - 60);
    expect(second.next_cursor).toBeNull();
    const refused = await call({ query: "kind:app", cursor: "!!" });
    expect(JSON.stringify(refused)).toContain("invalid_cursor");
  });

  test("a cursor made under one sort is refused under every other", async () => {
    const sorts = ["score", "forks", "ships", "use", "fresh", "name"];
    for (const made of sorts) {
      const first = (await (await get(`kind:app sort:${made}`)).json()) as any;
      for (const used of sorts) {
        const res = await get(`kind:app sort:${used}`, first.next_cursor);
        expect(res.status).toBe(made === used ? 200 : 400);
      }
    }
  });

  test("a narrowed caller's pages and cursors hold only rows it may see", async () => {
    const viewer = undefined;
    const query = parseExploreQuery("kind:app sort:name");
    // Hides the row each unnarrowed page would end on, and every tenth after.
    const visible = (row: { name: string }) => !/[09]$/.test(row.name) || row.name.endsWith("r000");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof explorePage>> = await explorePage(app, viewer, query, cursor, visible);
      if (page === null) throw new Error("refused");
      seen.push(...page.items.map((r) => r.name));
      if (page.nextCursor !== null) {
        const [, , , name] = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString());
        expect(visible({ name })).toBe(true);
        expect(page.items.length).toBe(60);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.every((n) => visible({ name: n }))).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(COUNT - 14 + 1);
  });
});

test("isExploreLine is true for each explore key and false for plain words", () => {
  for (const line of ["kind:app", "sort:forks", "updated:7d", "owner:trevato", "archived:yes", "garden OWNER:x"])
    expect(isExploreLine(line)).toBe(true);
  for (const line of ["", "garden", "zed-one", "downer:x"]) expect(isExploreLine(line)).toBe(false);
});

describe("explore's empty state behind a platform edge", () => {
  const TOKEN = "edge-secret-for-explore";
  let dataDir: string;
  let app: App;
  let http: ReturnType<typeof forgeHttp>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explore-edge-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: TOKEN });
    http = forgeHttp(app);
  }, 30_000);

  afterAll(async () => {
    http.close();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = async (headers: Record<string, string>) =>
    (await http.handle(new Request("http://forge.test/explore", { headers }))).text();

  test("a stranger the edge has not vouched for gets one Sign in to the edge, no Create an account", async () => {
    const out = await get({});
    expect(out).toContain("Nothing public yet");
    expect(out).toContain(`href="${edgeLoginUrl("/apps/new")}"`);
    expect(out).not.toContain("/signup");
    expect(out).not.toContain("Create an account");
    expect(out).not.toContain('href="/signin?next=/apps/new"');
  });

  test("a stranger the edge vouches for is offered Create an account", async () => {
    const out = await get({ "x-plat-edge-token": TOKEN, "x-plat-user": "newcomer" });
    expect(out).toContain("Create an account");
    expect(out).toContain('href="/signup?next=/apps/new"');
  });
});
