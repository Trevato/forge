/**
 * A name always says who it is (#721). Beside the owner's name and each
 * agent's the forge draws a mark from the account, never from a display
 * name: a stranger cannot produce it with any character, in any alphabet
 * or emoji, because every name is escaped on the way out and the mark is
 * an element only the forge writes. Tested where names are read: comments
 * and the opening post, the live fragment, the issue and change heads, the
 * review lines, the feed, the explore rows, and the MCP, which names
 * accounts by username alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { markOf, marksByName } from "../src/core/marks.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { setMember } from "../src/core/roles.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { feedCard } from "../src/web/studio/feed.ts";

const PASSWORD = "a-good-passphrase";

/** Every way a display name might try to wear the mark. None is the forge's. */
const DISGUISES = [
  "trevato (owner)",
  "alice (owner)",
  '<span class="name-mark" data-mark="owner">owner</span>',
  "👑 owner · crew",
  "alice​",
];

/** Every `.byline` element on a page, whole: spans counted in and out. */
const bylines = (html: string): string[] => {
  const out: string[] = [];
  const tag = /<\/?span\b/g;
  let at = html.indexOf('<span class="byline"');
  while (at !== -1) {
    tag.lastIndex = at;
    let depth = 0;
    let m: RegExpExecArray | null;
    while ((m = tag.exec(html)) !== null) {
      depth += m[0] === "<span" ? 1 : -1;
      if (depth === 0) {
        const close = html.indexOf(">", m.index) + 1;
        out.push(html.slice(at, close));
        break;
      }
    }
    at = html.indexOf('<span class="byline"', at + 1);
  }
  return out;
};

/** The bylines of `name` on a page: those whose link is theirs. */
const bylinesOf = (html: string, name: string): string[] =>
  bylines(html).filter((b) => b.includes(`href="/${name}"`));

const marksIn = (fragment: string): string[] =>
  [...fragment.matchAll(/data-mark="([a-z]+)"/g)].map((m) => m[1]!);

describe("a name always says who it is", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let mallory: User;
  let scout: User;
  let repo: Repo;
  let issueNumber = 0;
  let pull: Pull;
  let theirs: Pull;
  let cookie = "";
  let token = "";

  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASSWORD,
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const disguise = (user: User, name: string): void => {
    // Past the write rule on purpose (`reservedName` refuses these at the
    // account page): what matters is that none of them reads as the mark.
    app.db
      .query("UPDATE user SET display_name = ?1 WHERE id = ?2")
      .run(name, user.id);
  };
  const page = async (path: string, withCookie = cookie) =>
    (await fetch(`${base}${path}`, { headers: { cookie: withCookie } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-name-marks-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await person("alice");
    mallory = await person("mallory");
    const agent = await createAgent(app, alice, { username: "scout" });
    if (!agent.ok) throw new Error(String(agent.error));
    scout = agent.value.user;
    const made = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    insertApp(app.db, { repoId: repo.id, slug: "garden", access: "public" });
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    disguise(mallory, DISGUISES[0]!);

    // Mallory opens an issue; the owner and the crew answer on it.
    const opened = openIssue(app, mallory, repo, {
      title: "Water the beds",
      body: "They are dry.",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    issueNumber = opened.value.number;
    for (const [who, words] of [
      [alice, "On it."],
      [scout, "Taking this."],
      [mallory, "Thank you, owner."],
    ] as const)
      expect(addComment(app, who, repo, opened.value, words).ok).toBe(true);

    // The crew's pull, reviewed by the owner and by mallory; and mallory's own pull.
    for (const [branch, who] of [
      ["scout/beds", scout],
      ["mallory/beds", mallory],
    ] as const) {
      await commitToBranch(app, alice, repo, {
        branch,
        base: "main",
        message: branch,
        files: [{ path: `${branch.replace("/", "-")}.md`, content: "x\n" }],
      });
      // A member who cannot write here sends from a branch; a guest needs a fork.
      if (who === mallory) setMember(app.db, mallory.id, true, alice.id, new Date());
      const p = await openPull(app, who, repo, {
        title: `Beds by ${who.username}`,
        body: `Closes #${issueNumber}`,
        baseBranch: "main",
        headBranch: branch,
      });
      if (who === mallory) setMember(app.db, mallory.id, false, alice.id, new Date());
      if (!p.ok) throw new Error(String(p.error));
      if (who === scout) pull = p.value;
      else theirs = p.value;
    }
    for (const [who, state] of [
      [alice, "approved"],
      [mallory, "commented"],
    ] as const)
      expect(
        submitReview(app.db, {
          issueId: pull.id,
          authorId: who.id,
          state,
          commitOid: pull.headOid,
        }).ok,
      ).toBe(true);
    // Something for the crew to be doing, so the MCP has a name to say.
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: opened.value.id,
      actorId: scout.id,
    });
    claimRun(app.db, run.id);

    const signin = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    token = createToken(app.db, alice.id, "t", "ro").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger cannot produce the mark with any character, and their display name reads nowhere a name is a byline", async () => {
    const issuePath = `/alice/garden/issues/${issueNumber}`;
    const changePath = `/alice/garden/pulls/${theirs.number}`;
    for (const name of DISGUISES) {
      disguise(mallory, name);
      for (const path of [issuePath, changePath]) {
        const html = await page(path);
        const hers = bylinesOf(html, "mallory");
        expect(hers.length).toBeGreaterThan(0);
        for (const byline of hers) {
          expect(byline).toContain(">mallory<");
          expect(marksIn(byline)).toEqual([]);
        }
        // Her words never become the element; what she typed is not shown
        // where names are, and where it is shown it is escaped.
        expect(html).not.toContain(
          '<span class="name-mark" data-mark="owner">owner</span>mallory',
        );
        if (name.includes("<")) expect(html).not.toContain(name);
      }
    }
    disguise(mallory, DISGUISES[0]!);
  });

  test("the owner and the crew wear theirs on a comment, the opening post, the heads and a review line", async () => {
    const issue = await page(`/alice/garden/issues/${issueNumber}`);
    // The head, the opening post and a comment are mallory's: no mark on
    // any. Then alice (owner) and scout (crew), one comment each.
    expect(bylinesOf(issue, "mallory").map(marksIn)).toEqual([[], [], []]);
    expect(bylinesOf(issue, "alice").map(marksIn)).toEqual([["owner"]]);
    expect(bylinesOf(issue, "scout").map(marksIn)).toEqual([["crew"]]);

    const change = await page(`/alice/garden/pulls/${pull.number}`);
    // The head and the opening post name scout; alice's approval is a
    // review line; mallory is "in answer to" and her own review line.
    expect(bylinesOf(change, "scout").map(marksIn)).toEqual([
      ["crew"],
      ["crew"],
    ]);
    expect(bylinesOf(change, "alice").map(marksIn)).toEqual([["owner"]]);
    expect(bylinesOf(change, "mallory").map(marksIn)).toEqual([[], []]);
    // The mark is one element with one attribute, never a word in the name.
    expect(change).toContain('data-mark="owner"');
    expect(change).toContain('data-mark="crew"');
  });

  test("a comment that arrives live wears the same mark", async () => {
    const fragment = await page(
      `/alice/garden/issues/${issueNumber}/thread?after=`,
    );
    expect(bylinesOf(fragment, "alice").map(marksIn)).toEqual([["owner"]]);
    expect(bylinesOf(fragment, "scout").map(marksIn)).toEqual([["crew"]]);
    expect(bylinesOf(fragment, "mallory").map(marksIn)).toEqual([[]]);
  });

  test("the feed marks who posted, from the account", () => {
    const marks = marksByName(app.db, ["alice", "scout", "mallory"]);
    const card = (actor: string | null) =>
      feedCard(
        {
          id: `event:${actor ?? "app"}`,
          kind: "pull",
          app: "alice/garden",
          actor,
          at: new Date().toISOString(),
          link: `/alice/garden/pulls/${pull.number}`,
          what: "Beds",
          reason: "",
          score: 1,
        },
        marks,
      ).text;
    expect(marksIn(card("alice"))).toEqual(["owner"]);
    expect(marksIn(card("scout"))).toEqual(["crew"]);
    expect(marksIn(card("mallory"))).toEqual([]);
    expect(marksIn(card(null))).toEqual([]);
    expect(card("mallory")).toContain(">mallory<");
    expect(card("mallory")).not.toContain("trevato (owner)");
  });

  test("the explore rows mark the owner and name a person by their handle", async () => {
    const html = await page("/explore?q=kind%3Apeople", "");
    const row = (name: string) =>
      html.match(
        new RegExp(
          `<li>\\s*<div class="row"[\\s\\S]*?href="/${name}"[\\s\\S]*?</li>`,
        ),
      )?.[0] ?? "";
    expect(marksIn(row("alice"))).toEqual(["owner"]);
    expect(row("alice")).toContain(`>alice</a`);
  });

  test("the MCP names accounts by username alone", async () => {
    const res = await fetch(`${base}/mcp`, {
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
        params: { name: "now", arguments: {} },
      }),
    });
    const body = (await res.json()) as any;
    const rows = JSON.parse(body.result.content[0].text) as { who: string }[];
    expect(rows.map((r) => r.who)).toContain("scout");
    expect(JSON.stringify(rows)).not.toContain("trevato (owner)");
  });

  test("the mark comes from the account: an agent by its flag, the owner by standing, nobody else", () => {
    expect(markOf(alice)).toBe("owner");
    expect(markOf(scout)).toBe("crew");
    expect(markOf(mallory)).toBeUndefined();
    expect(markOf(undefined)).toBeUndefined();
    expect(
      marksByName(app.db, ["alice", "scout", "mallory", "", "nobody"]),
    ).toEqual(
      new Map([
        ["alice", "owner"],
        ["scout", "crew"],
      ]),
    );
    expect(marksByName(app.db, [])).toEqual(new Map());
  });
});
