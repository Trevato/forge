/** MCP `releases` draws the `ui://forge/release` card: a row per kept release, matching the tool's text. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { toolEntries } from "../src/http/mcp.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { finish, recordCut } from "../src/keeper/record.ts";
import { proofOf, releasesAnswer } from "../src/release/answer.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { recordRelease } from "../src/release/record.ts";
import { CARD_OF_TOOL, CARD_SHELL, SHELL_JS } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP releases card", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";

  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as any).result;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-releases-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!r.ok) throw new Error("user");
    token = createToken(app.db, r.value.id, "admin", "admin").token;
    const repo = await createRepo(app, r.value, { name: "forge", visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    recordRelease(app.db, { sha: "a".repeat(40), repoId: repo.value.id, pullNumber: 7, ok: true, line: "ok" });
    recordRelease(app.db, { sha: "b".repeat(40), repoId: repo.value.id, pullNumber: 8, ok: false, line: "preflight failed" });
    const cut = (sha: string, stage?: "verified" | "rolled_back") => {
      const k = recordCut(app.db, { version: "v-" + sha, sha, knownGood: { version: "v0", image: "img" }, at: 1 });
      if (stage !== undefined) finish(app.db, k.id, stage, "t", 2);
    };
    // the oldest kept release is the one the keeper rolled back, and 120 later keeper rows push it past any cap
    recordRelease(app.db, { sha: "c".repeat(40), repoId: repo.value.id, pullNumber: 5, ok: true, line: "ok" });
    cut("c".repeat(40), "rolled_back");
    for (let i = 0; i < 120; i++) cut(i.toString(16).padStart(40, "0"), "verified");
    cut("a".repeat(40), "verified");
    recordRelease(app.db, { sha: "d".repeat(40), repoId: repo.value.id, pullNumber: null, ok: true, line: "ok" });
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the tool names the card and resources/list serves it", async () => {
    expect(CARD_OF_TOOL["releases"]).toBe("release");
    const entry = toolEntries(TOOLS).find((t) => t.name === "releases") as any;
    expect(entry._meta.ui.resourceUri).toBe("ui://forge/release");
    const uris = ((await rpc("resources/list")).resources as any[]).map((r) => r.uri);
    expect(uris).toContain("ui://forge/release");
  });

  test("one row per release, matching the releases answer", async () => {
    const res = await rpc("tools/call", { name: "releases", arguments: {} });
    const items = JSON.parse(res.content[0].text).items as any[];
    const card = res.structuredContent.card;
    expect(card.kind).toBe("release");
    expect(items.map((i) => i.proof)).toEqual(["unproven", "rolled back", "unproven", "proven"]);
    expect(card.rows.map((r: any) => r.value.split(" · ").slice(1).join(" · ")).join("|")).toBe("unproven|#5 · rolled back|#8 · unproven|#7 · proven");
    expect(items.find((i) => i.sha.startsWith("ccccccc")).pull.number).toBe(5);
    expect(card.status).toBe("4 kept · 1 proven · 2 unproven · 1 rolled back");
  });

  test("the card's pull is the one the releases page names, not a count", async () => {
    const answer = releasesAnswer(app, undefined);
    expect(answer.ok).toBe(false);
    const res = await rpc("tools/call", { name: "releases", arguments: {} });
    const items = JSON.parse(res.content[0].text).items as any[];
    expect(items.every((i) => !("pulls" in i))).toBe(true);
    expect(res.structuredContent.card.rows[3].value).toContain("#7");
    expect(res.structuredContent.card.rows[3].value).not.toContain("1 pull");
  });

  test("the card is the last 10, each row linked to its pull, and escapes the link's fields", () => {
    const items = Array.from({ length: 12 }, (_, n) => ({ sha: `s${n}`, version: null, pull: { repo: "o/r", number: n + 1 }, landed: "", proof: "proven" }));
    const card = cardFor("releases", { items }, "https://f.test")!;
    expect(card.rows.length).toBe(10);
    expect(card.rows[0]!.link).toBe("https://f.test/o/r/pulls/1");
    for (const repo of ["//evil", "a/..", "./x", "../x", "a/.", "a/b/c", "a b/c"]) {
      const bad = cardFor("releases", { items: [{ sha: "a", pull: { repo, number: 1 }, landed: "", proof: "proven" }] }, "https://f.test")!;
      expect(bad.rows[0]!.link).toBeUndefined();
    }
    expect(cardFor("releases", { items }, "https://f.test")!.status).toStartWith("last 10 of 12 · 10 proven");
    const evil = `<img src=x onerror=alert(1)>`;
    const hostile = cardFor("releases", { items: [{ sha: evil, version: evil, pull: { repo: "o/r", number: 1 }, landed: "", proof: evil }] }, "https://f.test")!;
    expect(hostile.rows[0]!.label).toBe(evil);
    expect(hostile.rows[0]!.value).toContain(evil);
    expect(CARD_SHELL("release")).not.toContain(evil);
  });

  test("proof words, one per branch", () => {
    expect(proofOf("rolled_back", true)).toBe("rolled back");
    expect(proofOf("rolled_back", false)).toBe("rolled back");
    expect(proofOf("rolling", true)).toBe("unproven");
    expect(proofOf("verifying", true)).toBe("unproven");
    expect(proofOf("verified", false)).toBe("unproven");
    expect(proofOf("verified", true)).toBe("proven");
    expect(proofOf(undefined, true)).toBe("unproven");
  });

  test("the label is the version when live, else the short sha", () => {
    const card = cardFor("releases", { items: [{ sha: "abc1234", version: "1.2.3", landed: "", proof: "proven" }, { sha: "def5678", version: null, landed: "", proof: "unproven" }] })!;
    expect(card.rows.map((r) => r.label)).toEqual(["1.2.3", "def5678"]);
  });

  test("a hostile version travels as text and the shell never parses it as html", () => {
    const evil = `<img src=x onerror=alert(1)>"&`;
    const card = cardFor("releases", { items: [{ sha: "abc1234", version: evil, landed: "", proof: "proven" }] })!;
    expect(card.rows[0]!.label).toBe(evil);
    expect(JSON.stringify(card)).toContain(JSON.stringify(evil).slice(1, -1));
    expect(CARD_SHELL("release")).not.toContain(evil);
    expect(SHELL_JS).not.toContain("innerHTML");
  });

  test("releases with shipped has no card", async () => {
    const res = await rpc("tools/call", { name: "releases", arguments: { shipped: true } });
    expect(res.structuredContent?.card).toBeUndefined();
    expect(cardFor("releases", { version: "1", live: [], onItsWay: [] })).toBeUndefined();
  });
});
