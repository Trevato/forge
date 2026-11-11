/**
 * Prompts from Instagram (docs/APPS.md): once a day, the top comment on the
 * account's latest Reel becomes the crew's next tell. Instagram is a fake
 * the test scripts, the clock is the test's, and nothing here touches the
 * network — the real client is exercised against a fake `fetch`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent, removeFromCrew } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssue, listIssues } from "../src/core/issues.ts";
import {
  addPromptSource,
  getPromptSource,
  isDailyTime,
  claimPromptRun,
  listPromptSources,
  openPromptToken,
} from "../src/core/prompts.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  COMMENT_PAGES,
  graphInstagram,
  InstagramError,
  instagramSaid,
  topComment,
  type Comment,
  type InstagramClient,
  type Reel,
} from "../src/crew/instagram.ts";
import {
  startPromptRoutine,
  tellText,
  type PromptRoutineHandle,
} from "../src/crew/prompts.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Distinctive enough that its presence anywhere is unmistakable. */
const TOKEN = "IGAAQzx7k9p2m4-long-lived-token-for-the-test-QQ";
const FRESH = "IGAAQfresh-token-after-the-refresh-QQ";

const at = (iso: string): Comment["timestamp"] => iso;
const comment = (
  id: string,
  text: string,
  likeCount: number,
  timestamp: string,
  username = "someone",
): Comment => ({ id, text, username, timestamp, likeCount });
const reelOf = (id: string, day: string): Reel => ({
  id,
  permalink: `https://www.instagram.com/reel/${id}/`,
  timestamp: `${day}T18:00:00+0000`,
  caption: "new level",
  commentsCount: 3,
});

/** A page with its whitespace collapsed, for asserting on a sentence. */
const words = (html: string): string => html.replace(/\s+/g, " ");

describe("topComment", () => {
  test("picks the most liked, ties to the earliest, and ignores empty text", () => {
    const a = comment(
      "a",
      "later, same likes",
      5,
      at("2026-09-27T18:10:00+0000"),
    );
    const b = comment(
      "b",
      "earlier, same likes",
      5,
      at("2026-09-27T18:01:00+0000"),
    );
    const c = comment("c", "fewer likes", 2, at("2026-09-27T18:00:00+0000"));
    const blank = comment("d", "   ", 99, at("2026-09-27T17:00:00+0000"));
    expect(topComment([c, a, b, blank])?.id).toBe("b");
    expect(topComment([c])?.id).toBe("c");
    expect(topComment([blank])).toBeUndefined();
    expect(topComment([])).toBeUndefined();
  });
});

describe("tellText", () => {
  const reel = reelOf("r", "2026-09-27");
  const from =
    "From Instagram: the top comment (1 like) by @fan on the Reel of 2026-09-27. https://www.instagram.com/reel/r/";

  test("puts the first line as the title above the whole comment", () => {
    const c = comment("c", "  Add a boss\nIt feels empty.  ", 1, at("2026-09-27T18:00:00+0000"), "fan");
    expect(tellText(reel, c)).toBe(`Add a boss\nAdd a boss\nIt feels empty.\n\n${from}`);
  });

  test("a first line too long for a title is not repeated", () => {
    const long = "x".repeat(81);
    const c = comment("c", `${long}\nmore`, 1, at("2026-09-27T18:00:00+0000"), "fan");
    expect(tellText(reel, c)).toBe(`${long}\nmore\n\n${from}`);
  });
});

describe("the Instagram client", () => {
  /** A fetch that answers from a script and remembers what it was asked. */
  const scripted = (
    answer: (url: URL) => { status?: number; body: unknown },
  ) => {
    const asked: { url: URL; signal: AbortSignal | null | undefined }[] = [];
    const fetchFn = ((input: URL | Request | string, init?: RequestInit) => {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      asked.push({ url, signal: init?.signal });
      const { status, body } = answer(url);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return { asked, client: graphInstagram(fetchFn) };
  };

  test("asks Meta's host with the token in the query, and a timeout on every call", async () => {
    const { asked, client } = scripted(() => ({
      body: { id: "17841400000000000", username: "gamehandle" },
    }));
    expect(await client.me(TOKEN)).toEqual({
      id: "17841400000000000",
      username: "gamehandle",
    });
    const [first] = asked;
    expect(first?.url.origin).toBe("https://graph.instagram.com");
    expect(first?.url.pathname).toBe("/v25.0/me");
    expect(first?.url.searchParams.get("fields")).toBe("id,username");
    expect(first?.url.searchParams.get("access_token")).toBe(TOKEN);
    expect(first?.signal).toBeInstanceOf(AbortSignal);
  });

  test("the latest Reel: the newest REELS item, or the newest video where nothing is marked", async () => {
    const marked = scripted(() => ({
      body: {
        data: [
          {
            id: "p1",
            media_type: "IMAGE",
            media_product_type: "FEED",
            permalink: "https://www.instagram.com/p/p1/",
            timestamp: "2026-09-28T10:00:00+0000",
          },
          {
            id: "v0",
            media_type: "VIDEO",
            media_product_type: "FEED",
            permalink: "https://www.instagram.com/p/v0/",
            timestamp: "2026-09-27T10:00:00+0000",
          },
          {
            id: "r1",
            media_type: "VIDEO",
            media_product_type: "REELS",
            permalink: "https://www.instagram.com/reel/r1/",
            timestamp: "2026-09-26T10:00:00+0000",
            caption: "boss",
            comments_count: 4,
          },
        ],
      },
    }));
    expect(await marked.client.latestReel(TOKEN)).toEqual({
      id: "r1",
      permalink: "https://www.instagram.com/reel/r1/",
      timestamp: "2026-09-26T10:00:00+0000",
      caption: "boss",
      commentsCount: 4,
    });
    expect(marked.asked[0]?.url.pathname).toBe("/v25.0/me/media");

    const unmarked = scripted(() => ({
      body: {
        data: [
          {
            id: "p1",
            media_type: "IMAGE",
            timestamp: "2026-09-28T10:00:00+0000",
          },
          {
            id: "v1",
            media_type: "VIDEO",
            permalink: "https://www.instagram.com/reel/v1/",
            timestamp: "2026-09-27T10:00:00+0000",
          },
          {
            id: "v2",
            media_type: "VIDEO",
            timestamp: "2026-09-26T10:00:00+0000",
          },
        ],
      },
    }));
    expect((await unmarked.client.latestReel(TOKEN))?.id).toBe("v1");

    const none = scripted(() => ({ body: { data: [] } }));
    expect(await none.client.latestReel(TOKEN)).toBeUndefined();
  });

  test("comments follow the cursor, and stop after four pages", async () => {
    const paged = scripted((url) => {
      const after = url.searchParams.get("after");
      return {
        body: {
          data: [
            {
              id: `c-${after ?? "first"}`,
              text: "x",
              username: "u",
              timestamp: "2026-09-27T18:00:00+0000",
              like_count: 1,
            },
          ],
          paging: { cursors: { after: `cursor-${after ?? "1"}` } },
        },
      };
    });
    const all = await paged.client.comments(TOKEN, "r1");
    expect(all).toHaveLength(COMMENT_PAGES);
    expect(paged.asked).toHaveLength(COMMENT_PAGES);
    expect(paged.asked[0]?.url.pathname).toBe("/v25.0/r1/comments");
    expect(paged.asked[0]?.url.searchParams.get("after")).toBeNull();
    expect(paged.asked[1]?.url.searchParams.get("after")).toBe("cursor-1");
    expect(paged.asked[0]?.url.searchParams.get("fields")).toBe(
      "id,text,username,timestamp,like_count",
    );

    const short = scripted(() => ({
      body: {
        data: [
          {
            id: "c1",
            text: "one",
            username: "u",
            timestamp: "t",
            like_count: 3,
          },
        ],
      },
    }));
    expect(await short.client.comments(TOKEN, "r1")).toEqual([
      { id: "c1", text: "one", username: "u", timestamp: "t", likeCount: 3 },
    ]);
    expect(short.asked).toHaveLength(1);
  });

  test("Meta's errors become InstagramError, and each is a sentence", async () => {
    const refused = scripted(() => ({
      status: 400,
      body: {
        error: {
          message: "Invalid OAuth access token - Cannot parse access token",
          type: "OAuthException",
          code: 190,
        },
      },
    }));
    const failure = await refused.client.me(TOKEN).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(InstagramError);
    expect((failure as InstagramError).code).toBe(190);
    expect(instagramSaid(failure)).toBe(
      "Instagram no longer accepts the token; connect the account again.",
    );

    const limited = scripted(() => ({
      status: 400,
      body: {
        error: { message: "Application request limit reached", code: 4 },
      },
    }));
    const other = await limited.client
      .latestReel(TOKEN)
      .catch((e: unknown) => e);
    expect(instagramSaid(other)).toBe(
      "Instagram answered: Application request limit reached.",
    );

    const silent = scripted(() => ({ status: 503, body: {} }));
    const down = await silent.client.me(TOKEN).catch((e: unknown) => e);
    expect(instagramSaid(down)).toBe(
      "Instagram answered: Instagram answered 503.",
    );
    expect(instagramSaid(new Error("boom"))).toBe("The run failed: boom.");
  });

  test("a refresh asks the refresh endpoint and answers with the new token", async () => {
    const { asked, client } = scripted(() => ({
      body: { access_token: FRESH, token_type: "bearer", expires_in: 5183944 },
    }));
    expect(await client.refresh(TOKEN)).toEqual({ token: FRESH });
    expect(asked[0]?.url.pathname).toBe("/refresh_access_token");
    expect(asked[0]?.url.searchParams.get("grant_type")).toBe(
      "ig_refresh_token",
    );
    expect(asked[0]?.url.searchParams.get("access_token")).toBe(TOKEN);
  });
});

/** An Instagram the test scripts, remembering every call and the token it saw. */
class FakeInstagram implements InstagramClient {
  readonly calls: { call: string; token: string }[] = [];
  username = "gamehandle";
  reel: Reel | undefined;
  /** What the Reel's comments are, whichever Reel is asked about. */
  replies: Comment[] = [];
  /** Thrown by the next calls while set. */
  failWith: Error | undefined;
  fresh = FRESH;

  private see(call: string, token: string): void {
    this.calls.push({ call, token });
    if (this.failWith !== undefined) throw this.failWith;
  }
  me(token: string): Promise<{ id: string; username: string }> {
    this.see("me", token);
    return Promise.resolve({
      id: "17841400000000000",
      username: this.username,
    });
  }
  latestReel(token: string): Promise<Reel | undefined> {
    this.see("reel", token);
    return Promise.resolve(this.reel);
  }
  comments(token: string, mediaId: string): Promise<Comment[]> {
    this.see(`comments:${mediaId}`, token);
    return Promise.resolve(this.replies);
  }
  refresh(token: string): Promise<{ token: string }> {
    this.see("refresh", token);
    return Promise.resolve({ token: this.fresh });
  }
  names(): string[] {
    return this.calls.map((c) => c.call);
  }
}

describe("prompts from Instagram", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let routine: PromptRoutineHandle;
  let aliceCookie = "";
  let bobCookie = "";
  let adminToken = "";
  let rwToken = "";
  let bobToken = "";
  let sourceId = "";
  let instagram = new FakeInstagram();
  let clock = new Date("2026-09-28T14:59:00Z");
  const tick = (iso: string) => {
    clock = new Date(iso);
    return routine.runDue(clock);
  };

  const PROMPTS = "/api/v1/repos/alice/game/prompts";
  const SETTINGS = "/alice/game/settings/prompts";

  /** A browser's request to the forge: a cookie, and a same-origin form. */
  const web = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(servers.url).origin);
    return fetch(`${servers.url}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };
  const flashOf = (response: Response): string =>
    decodeURIComponent(response.headers.get("set-cookie") ?? "");

  const api = (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string")
      headers.set("content-type", "application/json");
    const token = init.token === undefined ? adminToken : init.token;
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };

  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };

  const source = () => getPromptSource(app.db, sourceId)!;
  const openIssues = () => listIssues(app.db, repo.id, { limit: 50 });

  /** Connect the account the way a person would, on the test's own story. */
  const connect = async (atUtc = "15:00") => {
    const made = await api(PROMPTS, {
      method: "POST",
      body: JSON.stringify({ kind: "instagram", token: TOKEN, at: atUtc }),
    });
    expect(made.status).toBe(201);
    sourceId = ((await made.json()) as { id: string }).id;
    // The API stamps the real date; the story is told on the test's clock.
    app.db
      .query(
        "UPDATE prompt_source SET token_refreshed_at = ?2, created_at = ?2 WHERE id = ?1",
      )
      .run(sourceId, "2026-09-28T14:00:00.000Z");
  };
  const reelOne = () => {
    instagram.reel = reelOf("reel-1", "2026-09-27");
    instagram.replies = [
      comment("c2", "first!!", 2, at("2026-09-27T18:01:00+0000"), "quick_one"),
      comment(
        "c1",
        "Add a boss fight at the end of level 3\nIt feels empty right now.",
        5,
        at("2026-09-27T18:05:00+0000"),
        "fan_one",
      ),
      comment("c3", "", 99, at("2026-09-27T18:00:00+0000"), "blank"),
    ];
  };
  /** An account connected whose first Reel has been told as #1. */
  const firstTell = async () => {
    await connect();
    reelOne();
    await tick("2026-09-28T15:00:00Z");
    expect(source().lastIssueNumber).toBe(1);
  };

  beforeEach(async () => {
    instagram = new FakeInstagram();
    clock = new Date("2026-09-28T14:59:00Z");
    sourceId = "";
    dataDir = await mkdtemp(join(tmpdir(), "forge-prompts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    routine = startPromptRoutine(app, {
      client: instagram,
      now: () => clock,
      // The test drives the clock; the timer must never run on its own.
      everyMs: 3_600_000,
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    adminToken = createToken(app.db, alice.id, "admin", "admin").token;
    rwToken = createToken(app.db, alice.id, "rw", "rw").token;
    bobToken = createToken(app.db, bob.id, "admin", "admin").token;

    const made = await createRepo(app, alice, {
      name: "game",
      visibility: "public",
      description: "A game with an audience",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    // A builder on the crew, so a tell has somebody to go to.
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
  });

  afterEach(async () => {
    await routine.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("adding needs a daily HH:MM, and seals the token where nothing shows it again", async () => {
    for (const good of ["00:00", "09:30", "15:00", "23:59"])
      expect(`${good}: ${isDailyTime(good)}`).toBe(`${good}: true`);
    for (const bad of ["24:00", "9:00", "15:60", "15:00:00", "noon", ""])
      expect(`${bad}: ${isDailyTime(bad)}`).toBe(`${bad}: false`);
    const insert = (token: string, atUtc: string) =>
      addPromptSource(app.db, dataDir, {
        repoId: repo.id,
        kind: "instagram",
        token,
        atUtc,
      });
    expect(insert(TOKEN, "25:00")).toEqual({ ok: false, error: "invalid_at" });
    expect(insert("", "15:00")).toEqual({ ok: false, error: "invalid_token" });
    expect(insert("has a space", "15:00")).toEqual({
      ok: false,
      error: "invalid_token",
    });
    expect(listPromptSources(app.db, repo.id)).toEqual([]);

    // Through the API: the codes, then the item — without the token.
    const badAt = await api(PROMPTS, {
      method: "POST",
      body: JSON.stringify({ kind: "instagram", token: TOKEN, at: "24:00" }),
    });
    expect(badAt.status).toBe(422);
    expect(((await badAt.json()) as { error: string }).error).toBe(
      "invalid_at",
    );
    const badKind = await api(PROMPTS, {
      method: "POST",
      body: JSON.stringify({ kind: "tiktok", token: TOKEN, at: "15:00" }),
    });
    expect(((await badKind.json()) as { error: string }).error).toBe(
      "invalid_kind",
    );

    const added = await api(PROMPTS, {
      method: "POST",
      body: JSON.stringify({ kind: "instagram", token: TOKEN, at: "15:00" }),
    });
    expect(added.status).toBe(201);
    const text = await added.text();
    expect(text).not.toContain(TOKEN);
    const item = JSON.parse(text) as {
      id: string;
      kind: string;
      account: string;
      atUtc: string;
      lastRanAt: string | null;
      lastSaid: string;
      lastIssueNumber: number | null;
      tokenRefreshedAt: string;
    };
    expect(item).toEqual({
      id: item.id,
      kind: "instagram",
      account: "",
      atUtc: "15:00",
      lastRanAt: null,
      lastSaid: "",
      lastIssueNumber: null,
      tokenRefreshedAt: item.tokenRefreshedAt,
    });
    expect("token" in item).toBe(false);
    sourceId = item.id;
    // The API stamps the real date; the story is told on the test's clock.
    app.db
      .query(
        "UPDATE prompt_source SET token_refreshed_at = ?2, created_at = ?2 WHERE id = ?1",
      )
      .run(sourceId, "2026-09-28T14:00:00.000Z");

    // Sealed in the row, opened only by its own id, absent from every listing.
    const row = app.db
      .query<
        { token_enc: string },
        [string]
      >("SELECT token_enc FROM prompt_source WHERE id = ?1")
      .get(sourceId)!;
    expect(row.token_enc).not.toContain(TOKEN);
    expect(row.token_enc.startsWith("v2:")).toBe(true);
    expect(openPromptToken(app.db, dataDir, sourceId)).toEqual({
      ok: true,
      value: TOKEN,
    });
    expect(openPromptToken(app.db, dataDir, "nope")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(JSON.stringify(listPromptSources(app.db, repo.id))).not.toContain(
      TOKEN,
    );
    expect(await (await api(PROMPTS)).text()).not.toContain(TOKEN);
    expect(await (await web(aliceCookie, SETTINGS)).text()).not.toContain(
      TOKEN,
    );
    expect(source().createdBy).toBe(alice.id);

    // One account per repository.
    const again = await api(PROMPTS, {
      method: "POST",
      body: JSON.stringify({ kind: "instagram", token: TOKEN, at: "16:00" }),
    });
    expect(again.status).toBe(422);
    expect(((await again.json()) as { error: string }).error).toBe(
      "already_connected",
    );
  });

  test("nothing before the hour; once after it; not again the same day", async () => {
    await connect();
    reelOne();
    await tick("2026-09-28T14:59:00Z");
    expect(instagram.names()).toEqual([]);
    expect(source().lastRanAt).toBeNull();
    expect(openIssues()).toEqual([]);

    await tick("2026-09-28T15:00:00Z");
    expect(instagram.names()).toEqual(["me", "reel", "comments:reel-1"]);
    expect(instagram.calls.every((c) => c.token === TOKEN)).toBe(true);
    const ran = source();
    expect(ran.account).toBe("gamehandle");
    expect(ran.lastRanAt).toBe("2026-09-28T15:00:00.000Z");
    expect(ran.lastMediaId).toBe("reel-1");
    expect(ran.lastIssueNumber).toBe(1);
    expect(ran.lastSaid).toBe(
      'Told the crew #1: "Add a boss fight at the end of level 3" — @fan_one, 5 likes.',
    );

    // The tell: the comment's first line is the title, the rest and the
    // provenance are the body, and the builder has it.
    const issue = getIssue(app.db, repo.id, 1)!;
    expect(issue.title).toBe("Add a boss fight at the end of level 3");
    expect(issue.body).toBe(
      "Add a boss fight at the end of level 3\nIt feels empty right now.\n\nFrom Instagram: the top comment (5 likes) by @fan_one on the Reel of 2026-09-27. https://www.instagram.com/reel/reel-1/",
    );
    expect(issue.authorName).toBe("alice");
    expect(issue.assigneeName).toBe("scout");
    const told = listEvents(app.db, { repoId: repo.id, limit: 50 }).filter(
      (e) => e.kind === "prompt.told",
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toEqual({
      source: sourceId,
      kind: "instagram",
      mediaId: "reel-1",
      commentId: "c1",
      issue: 1,
    });
    expect(told[0]?.actorId).toBeNull();

    // Later the same day: nothing more.
    await tick("2026-09-28T15:30:00Z");
    await tick("2026-09-28T23:59:00Z");
    expect(instagram.names()).toEqual(["me", "reel", "comments:reel-1"]);
    expect(source().lastRanAt).toBe("2026-09-28T15:00:00.000Z");
  });

  test("the same Reel is never told twice", async () => {
    await firstTell();
    instagram.calls.length = 0;
    await tick("2026-09-29T15:00:00Z");
    // The account is known, so `me` is not asked again; the Reel is known,
    // so its comments are not read.
    expect(instagram.names()).toEqual(["reel"]);
    expect(source().lastSaid).toBe(
      "No new Reel since 2026-09-27; the last one was told as #1.",
    );
    expect(source().lastRanAt).toBe("2026-09-29T15:00:00.000Z");
    expect(openIssues()).toHaveLength(1);
  });

  test("a Reel with no comments yet is looked at again tomorrow", async () => {
    await firstTell();
    instagram.calls.length = 0;
    instagram.reel = reelOf("reel-2", "2026-09-29");
    instagram.replies = [];
    await tick("2026-09-30T15:00:00Z");
    expect(instagram.names()).toEqual(["reel", "comments:reel-2"]);
    expect(source().lastSaid).toBe("The latest Reel has no comments yet.");
    expect(source().lastMediaId).toBe("reel-1");
    expect(source().lastIssueNumber).toBe(1);
    expect(openIssues()).toHaveLength(1);

    instagram.calls.length = 0;
    instagram.replies = [
      comment(
        "c9",
        "Make the jump feel heavier",
        1,
        at("2026-09-30T09:00:00+0000"),
        "ana",
      ),
    ];
    await tick("2026-10-01T15:00:00Z");
    expect(instagram.names()).toEqual(["reel", "comments:reel-2"]);
    expect(source().lastMediaId).toBe("reel-2");
    expect(source().lastIssueNumber).toBe(2);
    expect(source().lastSaid).toBe(
      'Told the crew #2: "Make the jump feel heavier" — @ana, 1 like.',
    );
    expect(getIssue(app.db, repo.id, 2)?.body).toContain(
      "the top comment (1 like) by @ana on the Reel of 2026-09-29.",
    );
  });

  test("no Reel at all is a sentence", async () => {
    await firstTell();
    instagram.reel = reelOf("reel-2", "2026-09-29");
    instagram.replies = [comment("c9", "Heavier jump", 1, at("2026-09-30T09:00:00+0000"), "ana")];
    await tick("2026-10-01T15:00:00Z");
    expect(source().lastMediaId).toBe("reel-2");
    instagram.reel = undefined;
    await tick("2026-10-02T15:00:00Z");
    expect(source().lastSaid).toBe("No Reel yet.");
    expect(source().lastMediaId).toBe("reel-2");
  });

  test("Instagram's refusals are sentences, never throws", async () => {
    await firstTell();
    instagram.failWith = new InstagramError(
      190,
      "Error validating access token: Session has expired",
      "OAuthException",
    );
    await tick("2026-10-03T15:00:00Z");
    expect(source().lastSaid).toBe(
      "Instagram no longer accepts the token; connect the account again.",
    );
    expect(source().lastRanAt).toBe("2026-10-03T15:00:00.000Z");

    instagram.failWith = new InstagramError(
      4,
      "Application request limit reached",
    );
    await tick("2026-10-04T15:00:00Z");
    expect(source().lastSaid).toBe(
      "Instagram answered: Application request limit reached.",
    );
    instagram.failWith = new Error("socket hang up");
    await tick("2026-10-05T15:00:00Z");
    expect(source().lastSaid).toBe("The run failed: socket hang up.");
    instagram.failWith = undefined;
    // Nothing above told anybody anything.
    expect(openIssues()).toHaveLength(1);
  });

  test("a token older than fifty days is refreshed, and the new one is what runs from then on", async () => {
    await connect();
    const before = source().tokenRefreshedAt;
    instagram.calls.length = 0;
    instagram.reel = reelOf("reel-3", "2026-11-19");
    instagram.replies = [
      comment("c20", "A hard mode", 8, at("2026-11-19T20:00:00+0000"), "vet"),
    ];
    // Pasted 2026-09-28; fifty-three days on.
    await tick("2026-11-20T15:00:00Z");
    expect(instagram.calls).toEqual([
      { call: "refresh", token: TOKEN },
      { call: "me", token: FRESH },
      { call: "reel", token: FRESH },
      { call: "comments:reel-3", token: FRESH },
    ]);
    expect(source().tokenRefreshedAt).toBe("2026-11-20T15:00:00.000Z");
    expect(source().tokenRefreshedAt).not.toBe(before);
    expect(openPromptToken(app.db, dataDir, sourceId)).toEqual({
      ok: true,
      value: FRESH,
    });
    expect(source().lastIssueNumber).toBe(1);

    // The next day: fresh, no refresh.
    instagram.calls.length = 0;
    await tick("2026-11-21T15:00:00Z");
    expect(instagram.calls).toEqual([{ call: "reel", token: FRESH }]);
    // And the sealed row never held either token in the clear.
    const row = app.db
      .query<
        { token_enc: string },
        [string]
      >("SELECT token_enc FROM prompt_source WHERE id = ?1")
      .get(sourceId)!;
    expect(row.token_enc).not.toContain(FRESH);
    expect(row.token_enc).not.toContain(TOKEN);
  });

  test("Fetch now runs at once, whatever the hour, through the API", async () => {
    await connect();
    clock = new Date("2026-11-21T15:00:00Z");
    // A token pasted the day before: no refresh is due.
    app.db
      .query("UPDATE prompt_source SET token_refreshed_at = ?2 WHERE id = ?1")
      .run(sourceId, "2026-11-20T15:00:00.000Z");
    instagram.calls.length = 0;
    instagram.reel = reelOf("reel-4", "2026-11-21");
    instagram.replies = [
      comment("c30", "Co-op please", 12, at("2026-11-21T12:00:00+0000"), "duo"),
    ];
    const ran = await api(`${PROMPTS}/${sourceId}/run`, { method: "POST" });
    expect(ran.status).toBe(200);
    const text = await ran.text();
    expect(text).not.toContain(FRESH);
    const item = JSON.parse(text) as {
      lastSaid: string;
      lastIssueNumber: number;
      account: string;
    };
    expect(item.lastSaid).toBe(
      'Told the crew #1: "Co-op please" — @duo, 12 likes.',
    );
    expect(item.lastIssueNumber).toBe(1);
    expect(item.account).toBe("gamehandle");
    expect(instagram.names()).toEqual(["me", "reel", "comments:reel-4"]);
    expect(getIssue(app.db, repo.id, 1)?.title).toBe("Co-op please");

    const unknown = await api(`${PROMPTS}/nope/run`, { method: "POST" });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: string }).error).toBe(
      "no_such_source",
    );
  });

  test("admin only, like the domains: scope, then admin over the repository", async () => {
    await connect();
    expect((await api(PROMPTS, { token: rwToken })).status).toBe(403);
    expect((await api(PROMPTS, { token: null })).status).toBe(401);
    expect((await api(PROMPTS, { token: bobToken })).status).toBe(404);
    expect(
      (
        await api(PROMPTS, {
          method: "POST",
          body: JSON.stringify({
            kind: "instagram",
            token: "stolen",
            at: "15:00",
          }),
          token: bobToken,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`${PROMPTS}/${sourceId}/run`, {
          method: "POST",
          token: bobToken,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`${PROMPTS}/${sourceId}/run`, {
          method: "POST",
          token: rwToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(`${PROMPTS}/${sourceId}`, {
          method: "DELETE",
          token: rwToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(`${PROMPTS}/${sourceId}`, {
          method: "DELETE",
          token: bobToken,
        })
      ).status,
    ).toBe(404);
    expect(getPromptSource(app.db, sourceId)).toBeDefined();

    // The pages: a non-admin meets the one 404; another origin, 403.
    expect((await web(bobCookie, SETTINGS)).status).toBe(404);
    expect((await web("", SETTINGS)).status).toBe(404);
    expect(
      (
        await web(bobCookie, SETTINGS, {
          form: { token: "stolen", at: "15:00" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await web(bobCookie, `${SETTINGS}/${sourceId}/run`, { form: {} }))
        .status,
    ).toBe(404);
    expect(
      (await web(bobCookie, `${SETTINGS}/${sourceId}/delete`, { form: {} }))
        .status,
    ).toBe(404);
    expect(
      (
        await web(aliceCookie, `${SETTINGS}/${sourceId}/delete`, {
          form: {},
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(getPromptSource(app.db, sourceId)).toBeDefined();
    expect(listPromptSources(app.db, repo.id)).toHaveLength(1);
  });

  test("the settings page: the card, the steps, the doors", async () => {
    await connect();
    clock = new Date("2026-11-21T15:00:00Z");
    instagram.reel = reelOf("reel-4", "2026-11-21");
    instagram.replies = [
      comment("c30", "Co-op please", 12, at("2026-11-21T12:00:00+0000"), "duo"),
    ];
    await routine.runNow(sourceId);
    app.db
      .query("UPDATE prompt_source SET token_refreshed_at = ?2 WHERE id = ?1")
      .run(sourceId, "2026-11-20T15:00:00.000Z");
    const page = words(await (await web(aliceCookie, SETTINGS)).text());
    expect(page).toContain(">Prompts<");
    expect(page).toContain("<h2>Instagram</h2>");
    expect(page).toContain("@gamehandle");
    expect(page).toContain("every day at 15:00 UTC");
    expect(page).toContain("Told the crew #1");
    expect(page).toContain("Token refreshed");
    expect(page).toContain("refreshes it again around 2027-01-09");
    expect(page).toContain("Fetch now");
    expect(page).toContain(`${SETTINGS}/${sourceId}/run`);
    expect(page).toContain(
      encodeURIComponent(`${SETTINGS}/${sourceId}/delete`),
    );
    expect(page).toContain("instagram_business_basic");
    expect(page).toContain("instagram_business_manage_comments");
    expect(page).toContain("Business Login for Instagram");
    expect(page).toContain("never shown again");
    expect(page).not.toContain(FRESH);
    expect(page).not.toContain(TOKEN);

    // The confirm page knows this door.
    const confirm = await web(
      aliceCookie,
      `/-/confirm?to=${encodeURIComponent(`${SETTINGS}/${sourceId}/delete`)}`,
    );
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Disconnect Instagram?");

    // Fetch now from the page flashes what the run said.
    instagram.calls.length = 0;
    const fetched = await web(aliceCookie, `${SETTINGS}/${sourceId}/run`, {
      form: {},
    });
    expect(fetched.status).toBe(303);
    expect(fetched.headers.get("location")).toBe(SETTINGS);
    expect(flashOf(fetched)).toContain(
      "No new Reel since 2026-11-21; the last one was told as #1.",
    );
    expect(instagram.names()).toEqual(["reel"]);

    // Remove, and the form is back.
    const removed = await web(aliceCookie, `${SETTINGS}/${sourceId}/delete`, {
      form: {},
    });
    expect(removed.status).toBe(303);
    expect(flashOf(removed)).toContain("Instagram is disconnected");
    expect(getPromptSource(app.db, sourceId)).toBeUndefined();
    const empty = words(await (await web(aliceCookie, SETTINGS)).text());
    expect(empty).toContain(
      "Once a day, the top comment on your latest Reel becomes the crew's next tell.",
    );
    expect(empty).toContain('type="password"');
    expect(empty).toContain('name="token"');
    expect(empty).toContain('type="time"');
    expect(empty).toContain('value="15:00"');
    expect(empty).not.toContain("Fetch now");
    const gone = await web(aliceCookie, `${SETTINGS}/${sourceId}/delete`, {
      form: {},
    });
    expect(flashOf(gone)).toContain("No account by that id");

    // Adding from the form, at another hour.
    const refused = await web(aliceCookie, SETTINGS, {
      form: { token: TOKEN, at: "9:00" },
    });
    expect(flashOf(refused)).toContain("hours and minutes in UTC");
    const added = await web(aliceCookie, SETTINGS, {
      form: { token: TOKEN, at: "09:30" },
    });
    expect(added.status).toBe(303);
    expect(flashOf(added)).toContain("Instagram is connected");
    expect(flashOf(added)).toContain("09:30 UTC");
    const fresh = words(await (await web(aliceCookie, SETTINGS)).text());
    expect(fresh).toContain("every day at 09:30 UTC");
    expect(fresh).toContain("not read yet");
    expect(fresh).toContain("Has not run yet.");
    expect(fresh).not.toContain(TOKEN);
    const events = listEvents(app.db, { repoId: repo.id, limit: 50 }).map(
      (e) => e.kind,
    );
    expect(events.filter((k) => k === "prompt.source_added")).toHaveLength(2);
    expect(events.filter((k) => k === "prompt.source_removed")).toHaveLength(1);
  });

  test("the API removes, and says so once", async () => {
    await connect("09:30");
    const listed = (await (await api(PROMPTS)).json()) as {
      items: { id: string; atUtc: string; account: string }[];
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.atUtc).toBe("09:30");
    expect(listed.items[0]?.account).toBe("");
    const id = listed.items[0]!.id;
    const removed = await api(`${PROMPTS}/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({});
    expect(
      ((await (await api(PROMPTS)).json()) as { items: unknown[] }).items,
    ).toEqual([]);
    const again = await api(`${PROMPTS}/${id}`, { method: "DELETE" });
    expect(again.status).toBe(422);
    expect(((await again.json()) as { error: string }).error).toBe(
      "no_such_source",
    );
    // A run now finds nothing due, and asks Instagram nothing.
    instagram.calls.length = 0;
    await tick("2026-11-22T15:00:00Z");
    expect(instagram.names()).toEqual([]);
  });
  test("a tell nobody can take is said honestly: opened, not told", async () => {
    const made = await api(PROMPTS, {
      method: "POST",
      body: JSON.stringify({ kind: "instagram", token: TOKEN, at: "15:00" }),
    });
    expect(made.status).toBe(201);
    sourceId = ((await made.json()) as { id: string }).id;
    expect(removeFromCrew(app, alice, repo, "scout").ok).toBe(true);
    instagram.failWith = undefined;
    instagram.reel = reelOf("reel-7", "2026-10-09");
    instagram.replies = [
      comment("c7", "Let us pet the dog", 8, at("2026-10-09T18:00:00+0000"), "dogfan"),
    ];
    clock = new Date("2026-10-10T15:00:00Z");
    const before = openIssues().length;
    await routine.runNow(sourceId);
    const issue = openIssues().find((i) => i.title === "Let us pet the dog")!;
    expect(issue).toBeDefined();
    expect(issue.assigneeName).toBeNull();
    expect(openIssues()).toHaveLength(before + 1);
    expect(source().lastSaid).toBe(
      `Opened #${issue.number}: "Let us pet the dog" — @dogfan, 8 likes; nobody on the crew to take it yet.`,
    );
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
  });

  test("a sentence about an error never carries the token, even when Instagram's words quote the request", async () => {
    await connect();
    instagram.failWith = new InstagramError(
      400,
      `Bad request to https://graph.instagram.com/v25.0/me/media?fields=id&access_token=${TOKEN}`,
    );
    clock = new Date("2026-10-11T15:00:00Z");
    await routine.runNow(sourceId);
    const said = source().lastSaid;
    expect(said).toContain("Instagram answered:");
    expect(said).not.toContain(TOKEN);
    expect(await (await api(PROMPTS)).text()).not.toContain(TOKEN);
    expect(await (await web(aliceCookie, SETTINGS)).text()).not.toContain(TOKEN);
    // A plain failure that quotes it, the same.
    instagram.failWith = new Error(`socket closed while sending ${TOKEN}`);
    await routine.runNow(sourceId);
    expect(source().lastSaid).not.toContain(TOKEN);
    instagram.failWith = undefined;
  });

  test("a run claims its row before any network work: two sweeps over one row tell the crew once", async () => {
    // A second routine over the same database — two forges over one data
    // directory, or a timer started twice — with a slow Instagram.
    await connect();
    let release: (() => void) | undefined;
    const slow = new FakeInstagram();
    slow.reel = reelOf("reel-8", "2026-10-11");
    slow.replies = [
      comment("c8", "Add a secret door", 6, at("2026-10-11T18:00:00+0000"), "sneak"),
    ];
    const slowReel = slow.latestReel.bind(slow);
    slow.latestReel = async (token) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return slowReel(token);
    };
    instagram.reel = slow.reel;
    instagram.replies = slow.replies;
    const other = startPromptRoutine(app, {
      client: slow,
      now: () => clock,
      everyMs: 3_600_000,
    });
    clock = new Date("2026-10-12T15:00:00Z");
    const before = openIssues().length;
    const a = other.runDue(clock);
    const b = routine.runDue(clock);
    await Bun.sleep(20);
    release?.();
    await Promise.all([a, b]);
    await other.stop();
    expect(openIssues()).toHaveLength(before + 1);
    expect(source().lastMediaId).toBe("reel-8");
    // Only one of the two ever spoke to Instagram.
    expect([slow.names().length > 0, instagram.names().some((n) => n === "comments:reel-8")].filter(Boolean)).toHaveLength(1);
    // The claim itself, in the open: once a day, unless a person insists.
    expect(claimPromptRun(app.db, sourceId, clock)).toBe(false);
    expect(claimPromptRun(app.db, sourceId, clock, { force: true })).toBe(true);
  });

  test("stop waits for a run in flight, but not forever", async () => {
    await connect();
    let hang: (() => void) | undefined;
    const stuck: InstagramClient = {
      me: (t) => instagram.me(t),
      refresh: (t) => instagram.refresh(t),
      comments: (t, id) => instagram.comments(t, id),
      latestReel: () =>
        new Promise<Reel | undefined>((resolve) => {
          hang = () => resolve(undefined);
        }),
    };
    const other = startPromptRoutine(app, {
      client: stuck,
      now: () => clock,
      everyMs: 3_600_000,
      stopDeadlineMs: 50,
    });
    const running = other.runNow(sourceId);
    const began = Date.now();
    await other.stop();
    expect(Date.now() - began).toBeLessThan(2_000);
    hang?.();
    await running;
  });

});
