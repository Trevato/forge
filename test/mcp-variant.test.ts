/**
 * The `variant` tool through `/mcp` with real tokens (#7166): like or dislike
 * only, a later vote replaces the earlier, a dislike closes the pull with its
 * reason as its one comment; a pull that is not a variant, or one the caller
 * cannot read, is refused with nothing changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listDecisions } from "../src/core/decisions.ts";
import { listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("MCP variant", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cy: User;
  let pub: Repo;
  let hid: Repo;
  let cyToken = "";
  let eveToken = "";
  let id = 1;
  let n = 0;

  const call = async (token: string, args: Record<string, unknown>) => {
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
        params: { name: "variant", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: body.error.message as string, error: true };
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };
  const pull = async (repo: Repo, group: string | null) => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, cy, repo, {
      branch,
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, cy, repo, {
      title: `Try ${branch}`,
      baseBranch: "main",
      headBranch: branch,
      ...(group === null ? {} : { variantGroup: group }),
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const votes = (repo: Repo, issueId: string) =>
    listDecisions(app.db, repo.id, { kind: "lean" }).filter((r) => r.issueId === issueId);
  const comments = (issueId: string) => listComments(app.db, issueId);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-variant-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    await make("ada", true);
    cy = await make("cy");
    promote(app.db, cy);
    const eve = await make("eve");
    const mk = async (name: string, visibility: "public" | "private") => {
      const made = await createRepo(app, cy, { name, visibility, description: "" });
      if (!made.ok) throw new Error(String(made.error));
      const seed = await commitToBranch(app, cy, made.value, {
        message: "seed",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      if (!seed.ok) throw new Error(JSON.stringify(seed.error));
      return made.value;
    };
    pub = await mk("lib", "public");
    hid = await mk("vault", "private");
    cyToken = createToken(app.db, cy.id, "admin", "admin").token;
    eveToken = createToken(app.db, eve.id, "admin", "admin").token;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("like then dislike leaves one vote, and the pull closed with the reason as its one comment", async () => {
    const sibling = await pull(pub, "g1");
    const target = await pull(pub, "g1");
    const before = comments(target.id).length;

    const liked = await call(cyToken, { repo: "cy/lib", number: target.number, answer: "like" });
    expect(liked.error).toBe(false);
    expect(JSON.parse(liked.text)).toEqual({ answer: "like", closed: false });
    expect(getPull(app.db, pub.id, target.number)!.state).toBe("open");
    expect(votes(pub, target.id).map((v) => v.answer)).toEqual(["like"]);

    const disliked = await call(cyToken, {
      repo: "cy/lib",
      number: target.number,
      answer: "dislike",
      reason: "too noisy",
    });
    expect(disliked.error).toBe(false);
    expect(JSON.parse(disliked.text)).toEqual({ answer: "dislike", closed: true });
    expect(getPull(app.db, pub.id, target.number)!.state).toBe("closed");
    const rows = votes(pub, target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("dislike");
    const added = comments(target.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toContain("too noisy");
    // The sibling is untouched.
    expect(getPull(app.db, pub.id, sibling.number)!.state).toBe("open");
    expect(votes(pub, sibling.id)).toHaveLength(0);
  });

  test("an answer other than like or dislike is invalid_answer and stores no vote", async () => {
    const target = await pull(pub, "g2");
    const before = comments(target.id).length;
    for (const answer of ["meh", "", "LIKE"]) {
      const r = await call(cyToken, { repo: "cy/lib", number: target.number, answer });
      expect(r.error).toBe(true);
      expect(r.text).toContain("invalid_answer");
    }
    expect(votes(pub, target.id)).toHaveLength(0);
    expect(getPull(app.db, pub.id, target.number)!.state).toBe("open");
    expect(comments(target.id).length).toBe(before);
  });

  test("a pull that is not a variant is refused and nothing changes", async () => {
    const plain = await pull(pub, null);
    const before = comments(plain.id).length;
    const r = await call(cyToken, {
      repo: "cy/lib",
      number: plain.number,
      answer: "dislike",
      reason: "no",
    });
    expect(r.error).toBe(true);
    expect(r.text).toContain("not_variant");
    expect(getPull(app.db, pub.id, plain.number)!.state).toBe("open");
    expect(votes(pub, plain.id)).toHaveLength(0);
    expect(comments(plain.id).length).toBe(before);
  });

  test("a pull the caller cannot read is refused and nothing changes", async () => {
    const secret = await pull(hid, "g3");
    const before = comments(secret.id).length;
    const r = await call(eveToken, {
      repo: "cy/vault",
      number: secret.number,
      answer: "dislike",
      reason: "no",
    });
    expect(r.error).toBe(true);
    expect(getPull(app.db, hid.id, secret.number)!.state).toBe("open");
    expect(votes(hid, secret.id)).toHaveLength(0);
    expect(comments(secret.id).length).toBe(before);

    // A pull number that does not exist is refused the same way.
    const missing = await call(cyToken, { repo: "cy/lib", number: 9999, answer: "like" });
    expect(missing.error).toBe(true);
    expect(missing.text).toContain("no_such_pull");
  });
});
