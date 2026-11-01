import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetLive } from "../src/release/landings.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("changelog page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let token: string;
  const oids: string[] = [];
  const kept = { commit: process.env["FORGE_COMMIT"], repo: process.env["FORGE_REPO"] };

  /** A pull merged at `at` whose merge commit is `oid`, in the repository `repoName`. */
  let n = 0;
  const merge = (repoName: string, title: string, at: string, oid: string, visibility = "public") => {
    const repoId = app.db.query<{ id: string }, [string]>("SELECT id FROM repo WHERE name = ?1").get(repoName)!.id;
    const issueId = `i${++n}`;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'closed', ?6)`).run(issueId, repoId, n, title, alice.id, at);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, 'main', ?2, '', '', ?3, ?4, ?5)`).run(issueId, `b/${n}`, repoId, at, oid);
    if (visibility !== "public") app.db.run("UPDATE repo SET visibility = ?1 WHERE name = ?2", [visibility, repoName]);
  };

  const mcp = async (args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "releases", arguments: args } }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as Record<string, any>;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = must(
      await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true }),
    );
    const repo = must(await createRepo(app, alice, { name: "forge", visibility: "public" }));
    must(await createRepo(app, alice, { name: "notes", visibility: "public" }));
    for (let i = 1; i <= 3; i++) {
      const c = must(await commitToBranch(app, alice, repo, { message: `work ${i}`, files: [{ path: `f${i}.txt`, content: `${i}\n` }] }));
      oids.push(c.commitOid);
    }
    app.config.forgeRepo = "alice/forge";
    // The running commit is the second: the third has landed and is not yet live.
    process.env["FORGE_COMMIT"] = oids[1]!;
    process.env["FORGE_VERSION"] = "1.2.3";
    const day = new Date().toISOString().slice(0, 10);
    merge("forge", "First <b>thing</b>", `${day}T01:00:00.000Z`, oids[0]!);
    merge("forge", "Second thing", `${day}T02:00:00.000Z`, oids[1]!);
    merge("forge", "Third thing", `${day}T03:00:00.000Z`, oids[2]!);
    merge("notes", "A note app change", `${day}T02:30:00.000Z`, "");
    token = createToken(app.db, alice.id, "rw", "rw").token;
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of [["FORGE_COMMIT", kept.commit]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env["FORGE_VERSION"];
    forgetLive();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists what the running commit contains, newest first, and sets the rest apart as on its way", async () => {
    const res = await fetch(`${servers.url}/changelog`);
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toContain("releases");
    const body = await res.text();
    const at = (s: string) => body.indexOf(s);
    expect(at("Second thing")).toBeGreaterThan(-1);
    expect(at("Second thing")).toBeLessThan(at("First &lt;b&gt;thing&lt;/b&gt;"));
    expect(body).not.toContain("<b>thing</b>");
    expect(body).toContain('href="/alice/forge/pulls/2"');
    expect(body).toContain("1.2.3");
    expect(body).toContain("2 shipped today");
    // Third is on its way: after the "On its way" heading and before the live days.
    expect(at("On its way")).toBeLessThan(at("Third thing"));
    expect(at("Third thing")).toBeLessThan(at("Second thing"));
    expect(body).toContain('data-live="pull.merged,app.serving"');
    // This forge leads; the other repository is a filter.
    expect(body).not.toContain("A note app change");
  });

  test("another repository is one filter away, and an unknown one falls back to this forge", async () => {
    const all = await (await fetch(`${servers.url}/changelog?repo=all`)).text();
    expect(all).toContain("A note app change");
    expect(all).toContain("alice/notes");
    const one = await (await fetch(`${servers.url}/changelog?repo=alice/notes`)).text();
    expect(one).toContain("A note app change");
    expect(one).not.toContain("Second thing");
    const bogus = await (await fetch(`${servers.url}/changelog?repo=%3Cscript%3E`)).text();
    expect(bogus).toContain("Second thing");
    expect(bogus).not.toContain("<script>");
  });

  test("a private repository's pulls are never listed", async () => {
    app.db.run("UPDATE repo SET visibility = 'private' WHERE name = 'notes'");
    try {
      const body = await (await fetch(`${servers.url}/changelog?repo=all`)).text();
      expect(body).not.toContain("A note app change");
    } finally {
      app.db.run("UPDATE repo SET visibility = 'public' WHERE name = 'notes'");
    }
  });

  test("the same list is the MCP's, for a reader with a token", async () => {
    const got = await mcp({ shipped: true });
    expect(got["version"]).toBe("1.2.3");
    expect(got["commit"]).toBe(oids[1]);
    expect(got["live"].map((l: { title: string }) => l.title)).toEqual(["A note app change", "Second thing", "First <b>thing</b>"]);
    expect(got["onItsWay"].map((l: { title: string }) => l.title)).toEqual(["Third thing"]);
  });

  test("the footer links to it", async () => {
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body).toContain('href="/changelog"');
  });

  test("empty only when nothing has shipped", async () => {
    app.db.run("UPDATE pull SET merged_at = NULL");
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body).toContain("Nothing has shipped yet");
  });
});
