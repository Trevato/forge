/**
 * MCP `explore`, `pulls` and `feed` each draw their `ui://forge/…` card (#11294):
 * the card is present, a hostile string arrives as text, a stranger's card
 * holds no private row, and each stops at 20 rows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const EVIL = "<img src=x onerror=alert(1)>";

describe("explore, pulls and feed cards", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let strangerTok = "";
  let id = 1;

  const card = async (name: string, args: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${strangerTok}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await res.json()) as any).result.structuredContent.card;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-cards-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false): Promise<User> => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!u.ok) throw new Error(u.error);
      promote(app.db, u.value);
      return u.value;
    };
    await mk("founder", true);
    const alice = await mk("alice");
    const bob = await mk("bob");
    strangerTok = createToken(app.db, bob.id, "ro", "ro").token;
    const open = await createRepo(app, alice, { name: "openapp", visibility: "public" });
    const secret = await createRepo(app, alice, { name: "hiddenapp", visibility: "private" });
    if (!open.ok || !secret.ok) throw new Error("repos");
    for (const repo of [open.value, secret.value]) {
      const rec = insertApp(app.db, { repoId: repo.id, slug: `alice-${repo.name}`, access: repo.visibility === "public" ? "public" : "private" });
      if (!rec.ok) throw new Error(rec.error);
      app.db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [alice.id, `like-${repo.name}`, repo.id]);
      const seeded = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# x\n" }] });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      const pushed = await commitToBranch(app, alice, repo, { branch: "feature/x", base: "main", message: "x", files: [{ path: "x.ts", content: "export const x = 1;\n" }] });
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
      const pr = await openPull(app, alice, repo, { title: `pull of ${repo.name}`, baseBranch: "main", headBranch: "feature/x" });
      if (!pr.ok) throw new Error(String(pr.error));
    }
    for (const [repo, summary] of [[open.value, EVIL], [secret.value, "hush-secret"]] as const)
      app.bus.append({ kind: "run.finished", repoId: repo.id, actorId: alice.id, payload: { kind: "deploy", state: "ok", summary, runId: `r-${repo.name}` } });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("explore draws its card for a stranger: the ranked public app, linked, and not the private one", async () => {
    const c = await card("explore", {});
    expect(c.kind).toBe("explore");
    const row = c.rows.find((r: any) => r.label === "app · alice/openapp");
    expect(row).toBeDefined();
    expect(row.link).toBe(`${servers.url}/alice/openapp`);
    expect(JSON.stringify(c)).not.toContain("hiddenapp");
    expect(c.rows.length).toBeLessThanOrEqual(20);
  });

  test("feed draws its card for a stranger: the public run's row with its text escaped, not the private one", async () => {
    const c = await card("feed", {});
    expect(c.kind).toBe("feed");
    const row = c.rows.find((r: any) => r.label.includes(EVIL));
    expect(row).toBeDefined();
    const all = JSON.stringify(c);
    expect(all).not.toContain("hush-secret");
    expect(all).not.toContain("hiddenapp");
  });

  test("pulls with no repo, as a stranger: the public pull's row, linked to its own repo, and not the private one", async () => {
    const c = await card("pulls", {});
    expect(c.kind).toBe("pulls");
    const row = c.rows.find((r: any) => r.label.includes("pull of openapp"));
    expect(row).toBeDefined();
    expect(row.value).toBe("open · none · no review");
    expect(row.link).toBe(`${servers.url}/alice/openapp/pulls/1`);
    expect(JSON.stringify(c)).not.toContain("hiddenapp");
    expect(c.rows).toHaveLength(1);
  });

  test("a pull row says state, check and review, linked to its pull", () => {
    const c = cardFor("pulls", { pulls: [{ repo: "alice/game", number: 3, title: EVIL, check: "ok", verdict: "approved" }, { repo: "alice/game", number: 4, title: "t", check: "failed", verdict: "changes_requested" }] }, "https://forge.test", {})!;
    expect(c.rows[0]).toEqual({ label: `#3 ${EVIL}`, value: "open · green · approved", link: "https://forge.test/alice/game/pulls/3" });
    expect(c.rows[1]!.value).toBe("open · red · changes requested");
  });

  test("each card stops at 20 rows", () => {
    const pulls = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: "t", check: "ok" }));
    expect(cardFor("pulls", { pulls }, "https://forge.test", { repo: "a/b" })!.rows).toHaveLength(20);
    const items = Array.from({ length: 30 }, (_, i) => ({ kind: "forge", name: `f${i}`, url: `/f${i}`, description: "d", numbers: {} }));
    expect(cardFor("explore", { query: "", items }, "https://forge.test")!.rows).toHaveLength(20);
    const feed = Array.from({ length: 30 }, (_, i) => ({ actor: "a", what: `w${i}`, link: `/x/${i}`, at: "2026-01-01T00:00:00Z" }));
    expect(cardFor("feed", { items: feed }, "https://forge.test")!.rows).toHaveLength(20);
  });

  test("explore names the signal it ranks on", () => {
    const items = [{ kind: "app", name: "a", url: "/o/a", numbers: { forks: 1, ships: 2, awakeHours: 3, likes: 9 } }];
    const c = cardFor("explore", { query: "sort:likes", items }, "https://forge.test")!;
    expect(c.rows[0]!.value).toContain("9 likes");
    const ago = new Date(Date.now() - 3 * 3600_000).toISOString();
    const fresh = cardFor("explore", { query: "sort:fresh", items: [{ ...items[0], shippedAt: ago }] }, "https://forge.test")!;
    expect(fresh.rows[0]!.value).toMatch(/ · shipped \d+ ?h/);
    expect(fresh.rows[0]!.value).not.toContain("likes");
  });
});
