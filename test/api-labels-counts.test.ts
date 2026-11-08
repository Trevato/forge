/** `GET …/labels` and MCP `repo_labels` list tell a writer each label's open count, and a reader none. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createIssue, createLabel, openLabelCounts, setIssueLabels } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("label open counts over the API and MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let bob: string;
  let sealedOnly: string;
  let both: string;
  let n = 1;

  const api = async (token: string) => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/game/labels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as any).items as Array<{ id: string; name: string; open?: number }>;
  };
  const mcp = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: n++,
        method: "tools/call",
        params: { name: "repo_labels", arguments: { repo: "alice/game" } },
      }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text).items as Array<{ id: string; name: string; open?: number }>;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-labels-counts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const mkLabel = (name: string) => {
      const l = createLabel(app.db, made.value.id, name, "d73a4a");
      if (!l.ok) throw new Error(l.error);
      return l.value.id;
    };
    const mkIssue = (title: string, sealed: boolean, labels: string[], close = false) => {
      const i = createIssue(app.db, { repoId: made.value.id, authorId: alice.id, title, sealed });
      if (!i.ok) throw new Error(i.error);
      setIssueLabels(app.db, i.value.id, labels);
      if (close) app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(i.value.id);
    };
    both = mkLabel("both");
    sealedOnly = mkLabel("sealed-only");
    mkLabel("unused");
    mkIssue("open", false, [both]);
    mkIssue("closed", false, [both], true);
    mkIssue("secret", true, [both, sealedOnly]);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer's API and MCP lists carry the same counts as openLabelCounts", async () => {
    const viaApi = await api(admin);
    const viaMcp = await mcp(admin);
    expect(viaMcp).toEqual(viaApi);
    const counts = openLabelCounts(app.db, app.db.query<{ id: string }, []>("SELECT id FROM repo").get()!.id);
    for (const l of viaApi) expect(l.open).toBe(counts.get(l.id) ?? 0);
    const by = Object.fromEntries(viaApi.map((l) => [l.name, l.open]));
    expect(by).toEqual({ both: 2, "sealed-only": 1, unused: 0 });
  });

  test("a reader who cannot see sealed issues is told no count at all", async () => {
    for (const items of [await api(bob), await mcp(bob)]) {
      expect(items.length).toBe(3);
      for (const l of items) expect("open" in l).toBe(false);
    }
  });
});
