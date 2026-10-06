/**
 * One way to post a review: the verdict and its line comments in one call
 * to `…/review-states`. Every anchor is checked before anything is written,
 * and a refused anchor says how an anchor is written, so a reviewer can
 * send the review right the second time. A verdict sent to the line-comment
 * route — the call the reviewer brief used to make — is told where it goes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listEvents } from "../src/core/events.ts";
import { listReviewComments, listReviews } from "../src/core/reviews.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a review with line comments", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let pull: Pull;
  let token: string;

  const post = (path: string, payload: unknown) =>
    fetch(`${servers.url}/api/v1/repos/alice/engine/pulls/${pull.number}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-lines-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "a.ts", content: "one\ntwo\n" }],
    });
    await commitToBranch(app, alice, repo, {
      branch: "feature/three",
      base: "main",
      message: "three",
      files: [{ path: "a.ts", content: "one\ntwo\nthree\n" }],
    });
    const opened = await openPull(app, alice, repo, {
      title: "three",
      baseBranch: "main",
      headBranch: "feature/three",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
    const agent = await createAgent(app, alice, { username: "juniper" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "juniper").ok).toBe(true);
    token = createToken(
      app.db,
      getUserByName(app.db, "juniper")!.id,
      "run",
      "rw",
    ).token;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a bad anchor posts nothing and says how an anchor is written", async () => {
    const refused = await post("review-states", {
      state: "changes_requested",
      body: "two things",
      comments: [
        { path: "a.ts", line: 3, side: "new", body: "fine anchor" },
        { path: "a.ts", line: 99, side: "new", body: "no such line" },
      ],
    });
    expect(refused.status).toBe(422);
    const said = (await refused.json()) as { error: string; message: string };
    expect(said.error).toBe("bad_anchor");
    expect(said.message).toContain("nothing was posted");
    expect(said.message).toContain("@@ -a,b +c,d @@");
    expect(listReviews(app.db, pull.id)).toHaveLength(0);
    expect(listReviewComments(app.db, pull.id)).toHaveLength(0);
  });

  test("the verdict and its line comments land in one call", async () => {
    const sent = await post("review-states", {
      state: "changes_requested",
      body: "one thing",
      comments: [{ path: "a.ts", line: 3, side: "new", body: "say why" }],
    });
    expect(sent.status).toBe(201);
    expect(listReviews(app.db, pull.id).map((r) => r.state)).toEqual([
      "changes_requested",
    ]);
    const lines = listReviewComments(app.db, pull.id);
    expect(lines.map((c) => [c.path, c.line, c.body])).toEqual([
      ["a.ts", 3, "say why"],
    ]);
    // One event for the line, one for the verdict: only the second carries
    // a state, and only that one wakes the builder.
    const kinds = listEvents(app.db, { repoId: repo.id })
      .filter((e) => e.kind === "pull.reviewed")
      .map((e) => (typeof e.payload["state"] === "string" ? "verdict" : "line"));
    expect(kinds.sort()).toEqual(["line", "verdict"]);
  });

  test("the same verdict sent twice on one head is one review", async () => {
    const again = await post("review-states", {
      state: "changes_requested",
      body: "one thing",
      comments: [{ path: "a.ts", line: 3, side: "new", body: "say why" }],
    });
    expect(again.status).toBe(201);
    expect(listReviews(app.db, pull.id)).toHaveLength(1);
    expect(listReviewComments(app.db, pull.id)).toHaveLength(1);
  });

  test("comments that are not a list of objects are refused", async () => {
    const refused = await post("review-states", {
      state: "commented",
      comments: "a.ts:3 looks off",
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_comments",
    );
  });

  test("a verdict sent to the line-comment route is told where it goes", async () => {
    const wrong = await post("reviews", { state: "approved", body: "ok" });
    expect(wrong.status).toBe(422);
    const said = (await wrong.json()) as { error: string; message: string };
    expect(said.error).toBe("bad_anchor");
    expect(said.message).toContain("review-states");
    expect(said.message).toContain('"side"');
  });
});
