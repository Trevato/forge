/**
 * A reply on a feed post is a comment on the issue or pull it is about: the
 * card offers it, the same handler takes it, and the person lands back on the
 * home with a flash. A reader who cannot see the repository is refused.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { feedCard } from "../src/web/studio/feed.ts";
import type { FeedItem } from "../src/feed/rank.ts";
import { replyRepo } from "../src/feed/reply.ts";
import { listComments } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let aliceCookie = "";
let bobCookie = "";
let publicIssue = 0;
let secretIssue = 0;
let publicId = "";
let secretId = "";
let pullNumber = 0;
let pullId = "";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-feed-reply-"));
  app = createApp({ dataDir: root, port: 0, disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
  servers = await serve(app);
  const person = async (username: string, first: boolean) =>
    must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        allowReserved: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      }),
    );
  await person("root", true);
  const alice = await person("alice", false);
  const bob = await person("bob", false);
  promote(app.db, alice, bob);
  aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
  for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
    const repo = must(await createRepo(app, alice, { name, visibility }));
    must(
      await commitToBranch(app, alice, repo, {
        message: "seed",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      }),
    );
    const issue = must(openIssue(app, alice, repo, { title: `Question for ${name}`, body: "why?" }));
    if (name === "open") {
      must(
        await commitToBranch(app, alice, repo, {
          branch: "idea",
          base: "main",
          message: "an idea",
          files: [{ path: "idea.md", content: "idea\n" }],
        }),
      );
      const pull = must(
        await openPull(app, alice, repo, { title: "An idea", body: "", baseBranch: "main", headBranch: "idea" }),
      );
      pullNumber = pull.number;
      pullId = pull.id;
      publicIssue = issue.number;
      publicId = issue.id;
    } else {
      secretIssue = issue.number;
      secretId = issue.id;
    }
  }
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

test("a card about an issue offers Reply, as a plain form", async () => {
  const res = await fetch(`${servers.url}/feed`, { headers: { cookie: aliceCookie } });
  const page = await res.text();
  expect(page).toContain(`action="/alice/open/issues/${publicIssue}/comments"`);
  expect(page).toContain('name="back" value="feed"');
});

test("a reply posts the comment and returns to the feed with a flash", async () => {
  const res = await post(`/alice/open/issues/${publicIssue}/comments`, aliceCookie, {
    body: "On it.",
    back: "feed",
  });
  expect(res.status).toBe(303);
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe("/feed");
  expect(listComments(app.db, publicId).map((c) => c.body)).toContain("On it.");
});

const flashOf = (res: Response): { message?: string; tone?: string } => {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("forge_flash=")) ?? "";
  return JSON.parse(decodeURIComponent(cookie.slice("forge_flash=".length).split(";")[0]!));
};

test("a reader of a repository they cannot see is refused", async () => {
  const res = await post(`/alice/secret/issues/${secretIssue}/comments`, bobCookie, {
    body: "Let me in.",
    back: "feed",
  });
  expect(res.status).toBe(404);
  expect(listComments(app.db, secretId)).toHaveLength(0);
});

test("Reply is offered only to a signed-in viewer who may comment there", () => {
  const db = app.db;
  const bob = db.query("SELECT * FROM user WHERE username = 'bob'").get() as never;
  expect(replyRepo(db, bob, "alice/open")).toBeDefined();
  expect(replyRepo(db, bob, "alice/secret")).toBeUndefined();
  expect(replyRepo(db, undefined, "alice/open")).toBeUndefined();
  expect(replyRepo(db, bob, "alice/missing")).toBeUndefined();
});

test("a card drawn for a viewer who may not reply has no Reply form", () => {
  const item: FeedItem = {
    id: "x",
    kind: "tell",
    app: "alice/open",
    actor: "alice",
    at: new Date().toISOString(),
    link: `/alice/open/issues/${publicIssue}`,
    what: "opened an issue: Question",
    reason: "",
    score: 1,
  } as FeedItem;
  expect(String(feedCard(item, new Map(), undefined, false))).not.toContain("/comments");
  expect(String(feedCard(item, new Map(), undefined, true))).toContain(`/alice/open/issues/${publicIssue}/comments`);
});

const cardOf = (over: Partial<FeedItem>): string =>
  String(
    feedCard(
      {
        id: "y",
        kind: "tell",
        app: "alice/open",
        actor: "alice",
        at: new Date().toISOString(),
        link: `/alice/open/issues/${publicIssue}`,
        what: "opened an issue",
        reason: "",
        score: 1,
        ...over,
      } as FeedItem,
      new Map(),
      undefined,
      true,
    ),
  );

test("the Reply form posts back=feed, and its label escapes a hostile title", () => {
  const card = cardOf({ what: 'opened an issue: "><script>alert(1)</script>' });
  const form = card.slice(card.indexOf(`action="/alice/open/issues/${publicIssue}/comments"`));
  expect(form).toContain('name="back" value="feed"');
  expect(form).toContain('name="body"');
  expect(card).not.toContain("<script>alert(1)</script>");
  expect(card).toContain("&lt;script&gt;");
});

test("one primary button per card: Reply is the accent, Tell is not", () => {
  const card = cardOf({});
  expect(card.match(/data-variant="primary"/g)).toHaveLength(1);
  const told = cardOf({ link: "/alice/open" });
  expect(told).not.toContain("/comments");
  expect(told.match(/data-variant="primary"/g)).toHaveLength(1);
});

test("a post linking to a thread in another repository offers no Reply", () => {
  expect(cardOf({ app: "alice/secret" })).not.toContain("/comments");
});

test("an empty reply on an issue returns to the feed with a danger flash", async () => {
  const res = await post(`/alice/open/issues/${publicIssue}/comments`, aliceCookie, { body: "  ", back: "feed" });
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe("/feed");
  expect(flashOf(res).tone).toBe("danger");
});

test("an empty comment from the issue page stays on it", async () => {
  const res = await post(`/alice/open/issues/${publicIssue}/comments`, aliceCookie, { body: "  " });
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe(`/alice/open/issues/${publicIssue}`);
});

test("a signed-out visitor to the feed sees no Reply form", async () => {
  const page = await (await fetch(`${servers.url}/feed`, { redirect: "manual" })).text();
  expect(page).not.toContain('name="back" value="feed"');
});

test("a reader of a public repository sees the card and may reply", async () => {
  const page = await (await fetch(`${servers.url}/feed`, { headers: { cookie: bobCookie } })).text();
  expect(page).toContain(`action="/alice/open/issues/${publicIssue}/comments"`);
  expect(page).not.toContain("/alice/secret/issues");
});

test("a reply on a pull comments on it and returns to the feed with a flash", async () => {
  const res = await post(`/alice/open/pulls/${pullNumber}/comments`, aliceCookie, { body: "Looks good.", back: "feed" });
  expect(res.status).toBe(303);
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe("/feed");
  expect(flashOf(res).message).toBe("Reply posted.");
  expect(listComments(app.db, pullId).map((c) => c.body)).toContain("Looks good.");
});

test("an empty reply on a pull returns to the feed with a danger flash", async () => {
  const res = await post(`/alice/open/pulls/${pullNumber}/comments`, aliceCookie, { body: "  ", back: "feed" });
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe("/feed");
  expect(flashOf(res).tone).toBe("danger");
});

test("a pull comment with an unknown back returns to the pull page", async () => {
  for (const back of ["https://evil.example/", "constructor", ""]) {
    const res = await post(`/alice/open/pulls/${pullNumber}/comments`, aliceCookie, { body: "Fine.", back });
    expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe(`/alice/open/pulls/${pullNumber}`);
  }
});

test("the issue reply flashes Reply posted.", async () => {
  const res = await post(`/alice/open/issues/${publicIssue}/comments`, aliceCookie, { body: "Noted.", back: "feed" });
  expect(flashOf(res).message).toBe("Reply posted.");
});

test("a back that is not the feed's word goes nowhere new", async () => {
  const res = await post(`/alice/open/issues/${publicIssue}/comments`, aliceCookie, {
    body: "Again.",
    back: "constructor",
  });
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe(`/alice/open/issues/${publicIssue}`);
});
