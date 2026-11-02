/** The `issues` tool lists what GET …/issues?fields=brief lists, behind the same reach. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, createLabel, setIssueLabels } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP issues", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceTok: string;
  let bobTok: string;
  let botTok: string;
  let carolTok: string;
  let id = 1;

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
        id: id++,
        method: "tools/call",
        params: { name: "issues", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const api = async (token: string, query: string): Promise<any> =>
    (
      await fetch(`${servers.url}/api/v1/repos/alice/game/issues?fields=brief&${query}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-issues-list-"));
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
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    const carol = await mk("carol");
    carolTok = createToken(app.db, carol.id, "ro", "ro").token;
    aliceTok = createToken(app.db, alice.id, "ro", "ro").token;
    bobTok = createToken(app.db, bob.id, "ro", "ro").token;
    const pub = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!pub.ok) throw new Error(String(pub.error));
    const bug = createLabel(app.db, pub.value.id, "bug", "d73a4a");
    if (!bug.ok) throw new Error(bug.error);
    for (let n = 1; n <= 5; n++) {
      const made = createIssue(app.db, {
        repoId: pub.value.id,
        authorId: n % 2 === 0 ? bob.id : alice.id,
        title: `issue ${n}`,
      });
      if (!made.ok) throw new Error(made.error);
      if (n <= 3) setIssueLabels(app.db, made.value.id, [bug.value.id]);
    }
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    const crewed = addToCrew(app, alice, pub.value, "bot");
    if (!crewed.ok) throw new Error(String(crewed.error));
    botTok = createToken(app.db, bot.value.user.id, "ro", "ro").token;
    const theirs = createIssue(app.db, {
      repoId: pub.value.id,
      authorId: carol.id,
      title: "Carol's embargoed report",
      sealed: true,
    });
    if (!theirs.ok) throw new Error(theirs.error);
    const sealed = createIssue(app.db, {
      repoId: pub.value.id,
      authorId: alice.id,
      title: "Embargoed",
      sealed: true,
    });
    if (!sealed.ok) throw new Error(sealed.error);
    const priv = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!priv.ok) throw new Error(String(priv.error));
    createIssue(app.db, { repoId: priv.value.id, authorId: alice.id, title: "hidden" });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // The API's brief row, less what the tool leaves out on purpose.
  const rows = (items: any[]) =>
    items.map(({ kind, originAuthor, untrusted, ...rest }) => ({ ...rest, ...(untrusted === undefined ? {} : { untrusted: true }) }));

  test("the label filter answers what the API answers", async () => {
    const got = await call(bobTok, { repo: "alice/game", label: "bug" });
    expect(got.value.items.map((i: any) => i.number)).toEqual([3, 2, 1]);
    expect(got.value.items[0].labels.map((l: any) => l.name)).toEqual(["bug"]);
    expect(got.value.items).toEqual(rows((await api(bobTok, "label=bug")).items));
  });

  test("the author filter answers what the API answers", async () => {
    const got = await call(bobTok, { repo: "alice/game", author: "bob" });
    expect(got.value.items.map((i: any) => i.number)).toEqual([4, 2]);
    expect(got.value.items).toEqual(rows((await api(bobTok, "author=bob")).items));
  });

  test("paging walks to the end", async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await call(bobTok, { repo: "alice/game", limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.value.items.map((i: any) => i.number));
      if (page.value.next_cursor === null) break;
      cursor = page.value.next_cursor;
    }
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });

  test("a sealed issue is absent for a non-writer and present for its author", async () => {
    const bob = await call(bobTok, { repo: "alice/game" });
    expect(bob.value.items.map((i: any) => i.title)).not.toContain("Embargoed");
    const alice = await call(aliceTok, { repo: "alice/game" });
    expect(alice.value.items.map((i: any) => i.title)).toContain("Embargoed");
  });

  test("a row says who wrote it and when", async () => {
    const got = await call(bobTok, { repo: "alice/game", limit: 2 });
    expect(got.value.items.map((i: any) => i.author)).toEqual(["alice", "bob"]);
    expect(typeof got.value.items[0].createdAt).toBe("string");
    expect(typeof got.value.items[0].updatedAt).toBe("string");
  });

  test("a crew agent is told which text an outsider wrote; a plain reader is not", async () => {
    const bot = await call(botTok, { repo: "alice/game" });
    const flagged = bot.value.items.filter((i: any) => i.untrusted === true).map((i: any) => i.author);
    expect(flagged.sort()).toEqual(["bob", "bob", "carol"]);
    expect(bot.value.items.find((i: any) => i.author === "alice").untrusted).toBeUndefined();
    expect(bot.value.items).toEqual(rows((await api(botTok, "")).items));
    const bob = await call(bobTok, { repo: "alice/game" });
    expect(bob.value.items.some((i: any) => "untrusted" in i)).toBe(false);
  });

  test("a sealed issue is present for a non-writer who filed it, and absent for another", async () => {
    const carol = await call(carolTok, { repo: "alice/game" });
    expect(carol.value.items.map((i: any) => i.title)).toContain("Carol's embargoed report");
    const bob = await call(bobTok, { repo: "alice/game" });
    expect(bob.value.items.map((i: any) => i.title)).not.toContain("Carol's embargoed report");
  });

  test("a private repository is not found", async () => {
    expect((await call(bobTok, { repo: "alice/vault" })).error).toContain("not_found");
  });

  test("a bad state, limit or cursor is refused", async () => {
    expect((await call(bobTok, { repo: "alice/game", state: "x" })).error).toContain("state");
    expect((await call(bobTok, { repo: "alice/game", limit: 201 })).error).toContain("1 to 200");
    expect((await call(bobTok, { repo: "alice/game", cursor: "abc" })).error).toContain("cursor");
  });
});
