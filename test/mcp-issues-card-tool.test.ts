/** The `issues` and `search` tools hand the card its extras from real data: waits (by id, cross-repo and sealed handled), pillar, untrusted. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";

describe("card extras from real data", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceTok: string;
  let bobTok: string;
  let id = 1;

  const call = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body: any = await res.json();
    return body.result.structuredContent?.card as { title: string; status: string; rows: { label: string; value: string; link?: string }[] };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-card-tool-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    aliceTok = createToken(app.db, alice.id, "ro", "ro").token;
    bobTok = createToken(app.db, bob.id, "ro", "ro").token;
    const r = await createRepo(app, alice, { name: "game", visibility: "public" });
    const other = await createRepo(app, alice, { name: "elsewhere", visibility: "public" });
    const vault = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!r.ok || !other.ok || !vault.ok) throw new Error("repo");
    const mkIssue = (repoId: string, authorId: string, title: string, sealed = false) => {
      const made = createIssue(app.db, { repoId, authorId, title, sealed });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const umbrella = mkIssue(r.value.id, alice.id, "P1 Speed: go fast");
    const work = mkIssue(r.value.id, alice.id, "Work item");
    const open = mkIssue(r.value.id, alice.id, "Plain blocker");
    const sealedBlocker = mkIssue(r.value.id, alice.id, "Embargoed blocker", true);
    mkIssue(r.value.id, bob.id, "Zebra stripes from outside");
    const foreign = mkIssue(other.value.id, alice.id, "Foreign blocker");
    const hidden = mkIssue(vault.value.id, alice.id, "Vault blocker");
    for (const [a, b] of [[umbrella, work], [work, open], [work, sealedBlocker]] as const) addDependency(app.db, getIssue(app.db, r.value.id, a.number)!, getIssue(app.db, r.value.id, b.number)!, alice.id);
    // addDependency refuses another repository's blocker, but a row can still name one: the card must not read it as a number here.
    for (const f of [foreign, hidden])
      app.db.query("INSERT INTO issue_dependency (issue_id, blocked_by_id, actor_id) VALUES (?1, ?2, ?3)").run(work.id, f.id, alice.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const rowOf = (card: { rows: { label: string; value: string }[] }, title: string) => card.rows.find((r) => r.label.includes(title))!;

  test("the owner sees the pillar, the sealed blocker, the cross-repo one named with its repo, and the private one", async () => {
    const card = await call(aliceTok, "issues", { repo: "alice/game" });
    const v = rowOf(card, "Work item").value;
    expect(v).toContain("P1 Speed");
    expect(v).toMatch(/waits on #\d+ #\d+ alice\/elsewhere#1 alice\/vault#1/);
  });

  test("another reader sees neither the sealed blocker nor the private repository's, and the foreign one keeps its repo", async () => {
    const card = await call(bobTok, "issues", { repo: "alice/game" });
    const v = rowOf(card, "Work item").value;
    expect(v).toContain("waits on #3 alice/elsewhere#1");
    expect(v).not.toContain("#4");
    expect(v).not.toContain("vault");
  });

  test("a sealed issue is left out of the rows", async () => {
    const card = await call(bobTok, "issues", { repo: "alice/game" });
    expect(card.rows.some((r) => r.label.includes("Embargoed"))).toBe(false);
  });

  test("search marks an outsider's issue untrusted and not a writer's", async () => {
    const card = await call(aliceTok, "search", { q: "Zebra", kind: "issues" });
    expect(card.rows[0]!.value).toBe("open · untrusted");
    const mine = await call(aliceTok, "search", { q: "Plain blocker", kind: "issues" });
    expect(mine.rows[0]!.value).toBe("open");
  });

  test("a code hit links to the file at the default branch, each segment escaped", () => {
    const card = cardFor(
      "search",
      { code: [{ repo: { owner: "a", name: "b" }, path: "src/a b/x.ts", line: 1, text: "t" }] },
      "https://forge.test",
      { q: "t", branches: { "a/b": "main" } },
    )!;
    expect(card.rows[0]!.link).toBe("https://forge.test/a/b/blob/main/src/a%20b/x.ts");
  });
});
