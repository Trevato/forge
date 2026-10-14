/**
 * High entropy asks (#689): every ask names its decision, its options and
 * what happens if nobody acts; the few that matter most come first, the
 * rest one tap away; and the board counts asks raised against acted on,
 * dismissed and gone by themselves — on the page, the API and the MCP.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { recordInteraction } from "../src/core/interactions.ts";
import {
  createLabel,
  getIssueById,
  setIssueLabels as setLabels,
} from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { candidatesFor } from "../src/feed/items.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  ASK_WORDS,
  askLinesFor,
  recordAskLedger,
} from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-ranking-passphrase";

describe("asks that earn their place", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie = "";
  let token = "";
  const repos = new Map<string, Repo>();

  const page = async (path: string): Promise<string> => {
    const res = await fetch(`${servers.url}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
    });
    expect(res.status).toBe(200);
    return (await res.text()).replace(/\s+/g, " ");
  };

  const check = (pull: Pull, state: "ok" | "failed"): void => {
    const run = createRun(app.db, {
      repoId: pull.repoId,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary: state });
  };

  const repoNamed = async (name: string): Promise<Repo> => {
    const known = repos.get(name);
    if (known) return known;
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    addToCrew(app, alice, made.value, "bot");
    repos.set(name, made.value);
    return made.value;
  };

  let n = 0;
  const greenPull = async (
    repoName: string,
    title: string,
    body = "",
  ): Promise<Pull> => {
    const repo = await repoNamed(repoName);
    n++;
    await commitToBranch(app, alice, repo, {
      branch: `bot/${n}`,
      base: "main",
      message: title,
      files: [{ path: `F${n}.md`, content: `${n}\n` }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title,
      body,
      baseBranch: "main",
      headBranch: `bot/${n}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    check(opened.value, "ok");
    return opened.value;
  };

  const mcpAsks = async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "asks", arguments: {} },
      }),
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    return JSON.parse(body.result.content[0]!.text) as {
      rows: {
        id: string;
        words: { decision: string };
        consequence: { why: string };
      }[];
      measure: { raised: number };
    };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-rank-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    token = createToken(app.db, alice.id, "ro", "ro").token;
    await createAgent(app, alice, { username: "bot" });
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  let plain: Pull;
  let blocking: Pull;
  let security: Pull;

  test("security first, then what holds other work up, then the rest", async () => {
    // A title is anyone's to write: "Security" in it lifts nothing.
    plain = await greenPull("plain", "Security: tidy the footer");
    const repo = await repoNamed("blocking");
    const blocker = openIssue(app, alice, repo, {
      title: "The thing others wait on",
    });
    const waiter = openIssue(app, alice, repo, { title: "Waits on the thing" });
    if (!blocker.ok || !waiter.ok) throw new Error("issues");
    expect(linkIssue(app, alice, repo, waiter.value, blocker.value).ok).toBe(
      true,
    );
    blocking = await greenPull(
      "blocking",
      "Build the thing",
      `Closes #${blocker.value.number}`,
    );
    security = await greenPull("security", "Widen the board id");
    const label = createLabel(app.db, security.repoId, "security", "d00000");
    if (!label.ok) throw new Error(label.error);
    setLabels(app.db, security.id, [label.value.id]);
    const rows = askLinesFor(app.db, alice);
    expect(rows.map((r) => r.id)).toEqual([
      `look:${security.id}`,
      `look:${blocking.id}`,
      `look:${plain.id}`,
    ]);
    expect(rows[0]!.consequence.why).toBe("security");
    expect(rows[1]!.consequence.why).toBe("1 other issue waits for it");
  });

  test("every ask names its decision, its options and what happens if nobody acts", async () => {
    for (const row of askLinesFor(app.db, alice)) {
      expect(row.words).toEqual(ASK_WORDS.look);
      expect(row.words.options.length).toBeGreaterThan(0);
    }
    const asks = await page("/");
    expect(asks).toContain("If nobody acts, it waits; nothing ships.");
    expect(asks).toContain("<b>security</b>");
    // The long sentence the card used to repeat is gone.
    expect(asks).not.toContain("Look at the preview, then ship it");
    const api = await fetch(`${servers.url}/api/v1/asks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(api.status).toBe(200);
    const body = (await api.json()) as {
      rows: { words: { ifNothing: string } }[];
    };
    expect(body.rows[0]!.words.ifNothing).toBe("it waits; nothing ships");
    const feed = await fetch(`${servers.url}/api/v1/feed`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const items = (
      (await feed.json()) as {
        items: { kind: string; ask?: { decision: string } }[];
      }
    ).items;
    const ask = items.find((i) => i.kind === "ask");
    expect(ask?.ask?.decision).toBe("Ship this change?");
    expect(
      items.some((i) => (i.ask as { why?: string } | undefined)?.why === "security"),
    ).toBe(true);
  });

  test("five rows by default, the rest one tap away; a phone shows two (#883)", async () => {
    for (const name of ["r4", "r5", "r6"])
      await greenPull(name, `Work in ${name}`);
    // What needs you is pinned on the home (#634): count its own cards.
    const home = await page("/");
    const asks = home.slice(home.indexOf('<section id="needs-you"'));
    const cards = (s: string) => (s.match(/class="card[" ]/g) ?? []).length;
    // Two before the phone's "more", three more inside it before the wide
    // screen's "more": a wide screen flattens the outer one and shows five.
    const [phone, wide] = asks.split('id="asks-phone-more"');
    expect(cards(phone!)).toBe(2);
    expect(cards(wide!.split('id="asks-more"')[0]!)).toBe(3);
    expect(asks).toContain("<summary>4 more</summary>");
    expect(asks).toContain("<summary>1 more</summary>");
    // The phone's "more" opens in place to every ask: the wide screen's
    // "more" sits inside it, and the stylesheet hides each where it is not.
    expect(wide!.indexOf('id="asks-more"')).toBeLessThan(wide!.indexOf("</details>"));
    const css = await (await fetch(`${servers.url}${home.match(/href="(\/[^"]*\.css[^"]*)"/)![1]}`)).text();
    // Only where the browser can hold a details element open: an older one
    // keeps both summaries, so no ask is out of reach.
    const held = css.slice(css.indexOf("@supports selector(::details-content) {"));
    expect(held).toContain("@media (max-width: 480px) {\n    .needs-you #asks-more > summary { display: none; }");
    expect(held).toContain("@media (min-width: 481px) {\n    .needs-you #asks-phone-more > summary { display: none; }");
    expect(css.indexOf("#asks-more > summary")).toBeGreaterThan(css.indexOf("@supports selector(::details-content)"));
    // Arriving at #needs-you, the first Tab lands on an ask, not the bulk step.
    const bulk = asks.indexOf('id="asks-bulk"');
    expect(bulk).toBeGreaterThan(asks.indexOf("</details>"));
  });

  test("an unsigned reader gets no asks from the API", async () => {
    const res = await fetch(`${servers.url}/api/v1/asks`);
    expect(res.status).toBe(401);
  });

  test("the feed orders asks by the same consequence as /asks, and nothing else", () => {
    const order = askLinesFor(app.db, alice).flatMap((r) => r.items);
    const urgency = new Map(
      candidatesFor(app.db, alice, Date.now())
        .filter((c) => c.kind === "ask")
        .map((c) => [c.id.slice("ask:".length), c.urgency]),
    );
    const ranked = [...urgency.keys()].sort((a, b) => urgency.get(b)! - urgency.get(a)!);
    expect(ranked).toEqual(order);
    // Every ask still sits above the news (a failed run is 4).
    for (const u of urgency.values()) expect(u).toBeGreaterThan(4);
  });

  test("a wave of new accounts never pushes the owner out of the ledger", () => {
    const insert = app.db.query(
      "INSERT INTO user (id, username, email, password_hash) VALUES (?1, ?2, ?3, 'x')",
    );
    for (let i = 0; i < 210; i++) {
      const id = `wave${String(i).padStart(4, "0")}`;
      insert.run(id, id, `${id}@forge.local`);
      createSession(app.db, id);
    }
    recordAskLedger(app.db);
    const mine = app.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM ask_ledger WHERE viewer_id = ?1",
      )
      .get(alice.id)!.n;
    expect(mine).toBeGreaterThan(0);
    // Reset, so the next test counts from nothing.
    app.db.query("DELETE FROM ask_ledger").run();
  });

  test("the ledger counts raised, acted on, dismissed and gone by themselves, and the board shows it", async () => {
    recordAskLedger(app.db);
    const raised = askLinesFor(app.db, alice).length;
    expect(raised).toBe(6);
    // Acted on: the plain pull is closed.
    const repo = repos.get("plain")!;
    const closed = setIssueState(
      app,
      alice,
      repo,
      getIssueById(app.db, plain.id)!,
      "closed",
    );
    expect(closed.ok).toBe(true);
    // Dismissed: the blocking one is set aside.
    recordInteraction(app.db, {
      viewerId: alice.id,
      itemId: `ask:look:${blocking.id}`,
      kind: "dismissed",
      repoId: blocking.repoId,
      actorId: null,
    });
    // Gone by itself: the security pull's check goes red, so it no longer asks.
    check(security, "failed");
    recordAskLedger(app.db);
    const board = await page("/board");
    expect(board).toContain('id="asks-measure"');
    expect(board).toContain(
      "<b>6</b> raised · <b>1</b> acted on · <b>1</b> dismissed · <b>1</b> went by themselves",
    );
    const fromMcp = await mcpAsks();
    expect(fromMcp.measure.raised).toBe(6);
    expect(fromMcp.rows).toHaveLength(3);
    expect(fromMcp.rows[0]!.words.decision).toBe("Ship this change?");
    // Nothing changed: a second pass raises nothing new.
    recordAskLedger(app.db);
    expect((await mcpAsks()).measure.raised).toBe(6);
  });
  test("a phone's ask is a full-width row: kind and repo on one line, the decider apart, the rest behind More", async () => {
    const home = await page("/");
    const asks = home.slice(home.indexOf('<section id="needs-you"'));
    expect(asks).toContain("ask-card");
    expect(asks).toContain('<b class="ask-kind">');
    // No icon column: the row opens with its kind, not a picture.
    expect(asks.slice(0, asks.indexOf("<h2", asks.indexOf("ask-card")))).not.toContain("<svg");
    expect(asks).toContain('<details class="ask-more-acts">');
    expect(asks).toMatch(/class="ask-acts">\s*<button[^>]*data-variant="primary"/);
    const css = await (await fetch(`${servers.url}${home.match(/href="(\/[^"]*\.css[^"]*)"/)![1]}`)).text();
    expect(css).toContain(".ask-acts > .btn { min-height: 44px;");
    expect(css).toContain(".needs-you .ask-card {\n    margin-inline: -16px;");
  });

  test("a collapsed row that ranks for security names which of its asks it is", async () => {
    // The security pull went red above; a new green one joins it in a row of two.
    check(security, "ok");
    await greenPull("security", "Another change here");
    const asks = await page("/");
    expect(asks).toContain("2 green changes wait for your look");
    expect(asks).toContain("<b>security</b>: \u201cWiden the board id\u201d");
    // On a phone the row is its head line, its two asks one tap away; a
    // wider screen holds them open (the lead's call: the fold wins).
    const group = asks.slice(asks.indexOf("2 green changes wait for your look"));
    expect(group).toContain('<details class="ask-group">');
    expect(group).toContain("<summary>Show all 2</summary>");
    const css = await (await fetch(`${servers.url}${asks.match(/href="(\/[^"]*\.css[^"]*)"/)![1]}`)).text();
    const wide = css.slice(css.indexOf("@supports selector(::details-content) {"));
    expect(wide.slice(wide.indexOf("@media (min-width: 481px)"))).toContain(
      ".needs-you .ask-group > summary { display: none; }",
    );
  });
});
