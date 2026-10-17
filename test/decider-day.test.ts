/**
 * Today's card on the board carries one line — "The decider closed N,
 * deferred N, asked you about N" — each count linking to the ledger rows
 * behind it. A fixture day: a yesterday's row never counts, a rule's stop is
 * not the decider's, and the link shows exactly the counted rows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {
  deciderCounts,
  recordDecision,
  setOutcome,
  type DecisionKind,
} from "../src/core/decisions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the decider's day on Today's card", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  let cards = 0;

  const get = (path: string) =>
    fetch(`${servers.url}${path}`, { headers: { cookie } }).then((r) => r.text());

  function row(
    kind: DecisionKind,
    answer: string,
    by: string,
    outcome?: string,
  ): string {
    const issue = openIssue(app, alice, repo, { title: `Card ${++cards}` });
    if (!issue.ok) throw new Error(String(issue.error));
    const d = recordDecision(app.db, {
      kind,
      repoId: repo.id,
      issueId: issue.value.id,
      state: {},
      answer,
      p: 0.9,
      by,
      ms: 1,
    });
    if (outcome !== undefined) setOutcome(app.db, d.id, outcome);
    return d.id;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-decider-day-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const made = await createRepo(app, alice, { name: "notes", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a quiet day says nothing", async () => {
    expect(await get("/board")).not.toContain('id="decider-day"');
  });

  test("counts the day's closed, deferred and asked, and links each to its rows", async () => {
    const closed = [1, 2, 3].map(() => row("hand", "set_aside", "typesafe", "set_aside"));
    row("hand", "set_aside", "typesafe", "undone"); // taken back: not closed
    row("retry", "stop", "typesafe");
    row("retry", "stop", "typesafe");
    row("retry", "stop", "rule"); // the rule's own stop is not the decider's
    row("retry", "retry", "typesafe");
    row("hand", "ask_owner", "typesafe", "asked");
    // Yesterday does not count.
    app.db
      .query("UPDATE decision SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1")
      .run(closed[0]!);

    expect(deciderCounts(app.db, [repo.id], "2021-01-01T00:00:00.000Z")).toEqual({
      closed: 2,
      deferred: 2,
      asked: 1,
    });

    const page = await get("/board");
    const line = page.slice(page.indexOf('id="decider-day"'));
    const text = line
      .slice(0, line.indexOf("</p>"))
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ");
    expect(text).toContain("The decider closed 2, deferred 2, asked you about 1.");
    expect(line).toContain('href="/board?ledger=closed#decided"');
    expect(line).toContain('href="/board?ledger=deferred#decided"');
    expect(line).toContain('href="/board?ledger=asked#decided"');

    const rowsOf = async (pile: string) => {
      const html = await get(`/board?ledger=${pile}`);
      const decided = html.slice(
        html.indexOf('id="decided"'),
        html.indexOf('id="today"'),
      );
      return (decided.match(/class="board-card board-decision"/g) ?? []).length;
    };
    expect(await rowsOf("closed")).toBe(2);
    expect(await rowsOf("deferred")).toBe(2);
    expect(await rowsOf("asked")).toBe(1);
  });

  test("an unknown pile is ignored, and ?apps= is kept in the links", async () => {
    const plain = await get("/board?ledger=nonsense");
    expect(plain).not.toContain("What the decider nonsense");
    const scoped = await get("/board?apps=notes");
    expect(scoped).toContain('href="/board?apps=notes&amp;ledger=closed#decided"');
  });
});
