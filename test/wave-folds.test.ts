/** A wave opens as headline, then its progress, then its changes (one closed fold each, its pulls inside); the MCP card says the same. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssueById, setIssueState, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { createToken } from "../src/core/tokens.ts";
import { mergedPull, waveNaming } from "./helpers/wave-pulls.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("wave folds", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string): Issue => must(openIssue(app, alice, fresh(), { title }));
  const link = (w: Issue, on: Issue) =>
    must(linkIssue(app, alice, fresh(), getIssueById(app.db, w.id)!, getIssueById(app.db, on.id)!));
  const closing = async (title: string, closes: Issue): Promise<number> => {
    const n = await mergedPull(app, alice, repo, title);
    app.db.query("UPDATE issue SET body = ? WHERE repo_id = ? AND number = ?").run(`Closes #${closes.number}`, repo.id, n);
    return n;
  };
  const publish = async (version: string, numbers: number[]): Promise<string> => {
    must(
      await commitToBranch(app, alice, fresh(), {
        message: `wave ${version}`,
        files: [{ path: `waves/${version}.md`, content: waveNaming(version, numbers.map((number) => ({ owner: "alice", name: "plan", number }))) }],
      }),
    );
    return version;
  };
  const get = async (version: string) =>
    (await fetch(`${servers.url}/alice/plan/waves/${version}`, { headers: { cookie } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-wave-folds-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
    cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
    repo = must(await createRepo(app, alice, { name: "plan", visibility: "public" }));
    must(await commitToBranch(app, alice, repo, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("headline, then progress, then two closed change folds each holding its pull, then the pulls", async () => {
    const m1 = open("Faster pages");
    const m2 = open("Calmer inbox");
    const a = open("Cache pages");
    const b = open("Group mail");
    const c = open("Spare part");
    link(m1, a);
    link(m1, c);
    link(m2, b);
    setIssueState(app.db, a.id, "closed", "done");
    setIssueState(app.db, b.id, "closed", "done");
    const p1 = await closing("Cache work", a);
    const p2 = await closing("Mail work", b);
    await publish("1.0.0", [p1, p2]);
    const text = await get("1.0.0");
    const at = (s: string) => {
      const i = text.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const progress = at("Faster pages: 1 of 2 done");
    expect(at("<h1>Mixed</h1>")).toBeLessThan(progress);
    const fold1 = at('<details id="change-' + m1.number + '"');
    const fold2 = at('<details id="change-' + m2.number + '"');
    expect(progress).toBeLessThan(fold1);
    expect(fold1).toBeLessThan(fold2);
    // closed folds: no `open` attribute
    expect(text.slice(fold1, fold1 + 40)).not.toContain("open");
    // each fold holds only its own pull
    const first = text.slice(fold1, fold2);
    expect(first).toContain("Cache work");
    expect(first).not.toContain("Mail work");
    expect(text.slice(fold2)).toContain("Mail work");
    // progress is said once, and each pull once (in its fold, not again under Pulls)
    expect(text.split("1 of 2 done").length - 1).toBe(1);
    expect(text).not.toContain("1 of 1 done");
    expect(text.split("Cache work").length - 1).toBe(1);
    expect(text.split("Mail work").length - 1).toBe(1);
  });

  test("a wave with no milestone has no progress line", async () => {
    const loose = open("Unrelated");
    await publish("1.1.0", [await closing("Loose work", loose)]);
    const text = await get("1.1.0");
    expect(text).not.toContain("data-wave-progress");
    expect(text).not.toContain('<details id="change-');
  });

  const mcp = async (version: string) => {
    const { token } = createToken(app.db, alice.id, "ro", "ro");
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "waves", arguments: { repo: "alice/plan", version } } }),
    });
    const body = (await res.json()) as any;
    return { value: JSON.parse(body.result.content[0].text), card: body.result.structuredContent?.card };
  };

  test("the MCP wave says the same progress line as the page, and the card shows it", async () => {
    const { value, card } = await mcp("1.0.0");
    expect(value.wave.progress).toBe("Faster pages: 1 of 2 done");
    expect(cardFor("waves", value)?.rows).toContainEqual({ label: "Progress", value: "Faster pages: 1 of 2 done" });
    expect(card.rows).toContainEqual({ label: "Progress", value: "Faster pages: 1 of 2 done" });
    expect(await get("1.0.0")).toContain(value.wave.progress);
    const none = await mcp("1.1.0");
    expect(none.value.wave.progress).toBeUndefined();
    expect(none.card.rows.some((r: { label: string }) => r.label === "Progress")).toBe(false);
  });
});
