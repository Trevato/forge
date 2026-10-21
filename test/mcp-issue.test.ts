/**
 * The `issue` tool reads one issue behind the same check as the REST read:
 * a repository the caller cannot read is not found, and a bad number stops
 * at the boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import {
  createIssue,
  createLabel,
  setAssignee,
  setIssueLabels,
} from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP issue", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceTok: string;
  let bobTok: string;
  let number: number;
  let secret: number;
  let sealedNo: number;
  let pullNo: number;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
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
        params: { name: "issue", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-issue-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    aliceTok = createToken(app.db, a.value.id, "ro", "ro").token;
    bobTok = createToken(app.db, b.value.id, "ro", "ro").token;

    const pub = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!pub.ok) throw new Error(String(pub.error));
    const label = createLabel(app.db, pub.value.id, "bug", "d73a4a");
    if (!label.ok) throw new Error(label.error);
    const issue = createIssue(app.db, {
      repoId: pub.value.id,
      authorId: a.value.id,
      title: "Sort it",
      body: "The <b>list</b> is out of order.",
    });
    if (!issue.ok) throw new Error(issue.error);
    number = issue.value.number;
    setIssueLabels(app.db, issue.value.id, [label.value.id]);
    setAssignee(app.db, issue.value.id, a.value.id);

    const sealed = createIssue(app.db, {
      repoId: pub.value.id,
      authorId: a.value.id,
      title: "Embargoed",
      sealed: true,
    });
    if (!sealed.ok) throw new Error(sealed.error);
    sealedNo = sealed.value.number;
    const pull = createIssue(app.db, {
      repoId: pub.value.id,
      authorId: a.value.id,
      title: "A pull",
      kind: "pull",
    });
    if (!pull.ok) throw new Error(pull.error);
    pullNo = pull.value.number;

    const priv = await createRepo(app, a.value, { name: "vault", visibility: "private" });
    if (!priv.ok) throw new Error(String(priv.error));
    const hidden = createIssue(app.db, {
      repoId: priv.value.id,
      authorId: a.value.id,
      title: "Hidden",
    });
    if (!hidden.ok) throw new Error(hidden.error);
    secret = hidden.value.number;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("reads title, state, body, labels and assignee", async () => {
    const r = await tool(bobTok, { repo: "alice/game", number });
    expect(r.value.title).toBe("Sort it");
    expect(r.value.state).toBe("open");
    expect(r.value.closeReason).toBeNull();
    expect(r.value.body).toBe("The <b>list</b> is out of order.");
    expect(r.value.labels).toEqual(["bug"]);
    expect(r.value.assignee).toBe("alice");
  });

  test("a private repository's issue is not found without access", async () => {
    const own = await tool(aliceTok, { repo: "alice/vault", number: secret });
    expect(own.value.title).toBe("Hidden");
    const other = await tool(bobTok, { repo: "alice/vault", number: secret });
    expect(other.error).toBeDefined();
    expect(other.error).not.toContain("Hidden");
  });

  test("a sealed issue is not found by someone who may not see it", async () => {
    const own = await tool(aliceTok, { repo: "alice/game", number: sealedNo });
    expect(own.value.title).toBe("Embargoed");
    const other = await tool(bobTok, { repo: "alice/game", number: sealedNo });
    expect(other.error).toContain(`no issue #${sealedNo}`);
    expect(other.error).not.toContain("Embargoed");
  });

  test("a pull's number says to use the pull tool", async () => {
    const r = await tool(bobTok, { repo: "alice/game", number: pullNo });
    expect(r.value).toEqual({ kind: "pull", tool: "pull" });
  });

  test("a bad number is refused", async () => {
    for (const n of [0, -1, 1.5, "1", null, 999]) {
      const r = await tool(aliceTok, { repo: "alice/game", number: n });
      expect(r.error).toContain("no issue");
    }
  });
});
