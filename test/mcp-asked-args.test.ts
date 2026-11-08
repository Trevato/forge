/** The `asked` tool takes only the known `show` and `order` words, and lists nothing in a repository the caller cannot write. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { askedIn, askedRepos, askedJson } from "../src/core/asked.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("MCP asked arguments", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let aliceTok: string;
  let bobTok: string;
  let id = 1;

  const call = async (token: string, args: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "asked", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  /** What the /asked page reads for these choices. */
  const page = (show: "all" | "unshipped" | "flagged", order: "oldest" | "newest") =>
    askedIn(app.db, askedRepos(app.db, alice, null), { show, order }).map(askedJson);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-asked-args-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await mk("alice", true);
    const bob = await mk("bob");
    aliceTok = createToken(app.db, alice.id, "ro", "ro").token;
    bobTok = createToken(app.db, bob.id, "ro", "ro").token;
    for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      for (const [n, days] of [["first", 9], ["second", 5], ["third", 1]] as const) {
        const issue = createIssue(app.db, { repoId: made.value.id, authorId: alice.id, title: `${n} in ${name}` });
        if (!issue.ok) throw new Error(issue.error);
        app.db
          .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
          .run(new Date(Date.now() - days * DAY).toISOString(), issue.value.id);
      }
    }
    // One ask is done with, so "all" has more than "unshipped".
    app.db.query("UPDATE issue SET state = 'closed' WHERE title = 'second in open'").run();
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no arguments lists unshipped asks, oldest first", async () => {
    const got = await call(aliceTok);
    const titles = got.value.asked.map((a: any) => a.title);
    expect(titles.length).toBeGreaterThan(0);
    expect(got.value.asked).toEqual(page("unshipped", "oldest"));
    const times: string[] = got.value.asked.map((a: any) => a.askedAt);
    expect(times).toEqual([...times].sort());
    expect(titles).not.toContain("second in open");
  });

  test("each known show and order returns what the page shows", async () => {
    for (const show of ["unshipped", "flagged", "all"] as const)
      for (const order of ["oldest", "newest"] as const)
        expect((await call(aliceTok, { show, order })).value.asked).toEqual(page(show, order));
    const all = (await call(aliceTok, { show: "all" })).value.asked;
    expect(all.map((a: any) => a.title)).toContain("second in open");
    const newest = (await call(aliceTok, { order: "newest" })).value.asked;
    expect(newest.map((a: any) => a.title)).toEqual(
      [...(await call(aliceTok)).value.asked].reverse().map((a: any) => a.title),
    );
  });

  test("an unknown show or order is refused", async () => {
    expect((await call(aliceTok, { show: "everything" })).error).toContain("invalid_show");
    expect((await call(aliceTok, { order: "random" })).error).toContain("invalid_order");
    expect((await call(aliceTok, { show: "all", order: "random" })).error).toContain("invalid_order");
  });

  test("a repository the caller cannot read lists nothing about it", async () => {
    const mine = await call(aliceTok, { repo: "alice/secret" });
    expect(mine.value.asked.length).toBe(3);
    const theirs = await call(bobTok, { repo: "alice/secret" });
    expect(theirs.error).toContain("not_found");
    expect(JSON.stringify(theirs)).not.toContain("in secret");
    const none = await call(bobTok);
    expect(none.value.asked).toEqual([]);
  });
});
