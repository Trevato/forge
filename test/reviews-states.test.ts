import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listEvents } from "../src/core/events.ts";

/**
 * Review states: the verdict that gates a merge.
 *
 * Everything here goes through the API against a real forge, because the
 * interesting parts are the refusals — a reader who cannot approve, an
 * author who cannot approve their own change, a merge that will not land
 * without one, and an approval that a later push dismisses. A unit test of
 * `reviewSummary` proves none of those.
 */

const PASSWORD = "review-states-pass";

describe("review states, and the merge they gate", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const tokens: Record<string, string> = {};

  /** An authenticated JSON call as `who`. */
  const as = (who: string, method: string, path: string, payload?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[who]}`,
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

  const read = async <T>(response: Response): Promise<T> =>
    (await response.json()) as T;

  async function mkUser(username: string): Promise<void> {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@f.dev`,
        password: PASSWORD,
      }),
    });
    const token = await read<{ token: string }>(
      await fetch(`${base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true,
          username,
          password: PASSWORD,
          name: "t",
          scope: "admin",
        }),
      }),
    );
    tokens[username] = token.token;
  }

  /** The pull number of a fresh branch with one file changed on it. */
  async function proposeFrom(
    who: string,
    branch: string,
    content: string,
    title: string,
  ): Promise<number> {
    const edit = await as(who, "POST", "/api/v1/repos/acme/lib/edits", {
      newBranch: branch,
      base: "main",
      message: title,
      files: [{ path: "a.txt", content }],
      openPull: { title },
    });
    expect(edit.status).toBe(201);
    const created = await read<{ pull: { number: number } }>(edit);
    return created.pull.number;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-rs-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    for (const who of ["ada", "bob", "cas"]) await mkUser(who);

    // An org, so there is more than one writer: a repo with one owner cannot
    // express "somebody else approved this".
    expect(
      (await as("ada", "POST", "/api/v1/orgs", { name: "acme" })).status,
    ).toBe(201);
    expect(
      (
        await as("ada", "POST", "/api/v1/orgs/acme/teams", {
          name: "devs",
          permission: "write",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await as("ada", "POST", "/api/v1/orgs/acme/teams/devs/members", {
          user: "bob",
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await as("ada", "POST", "/api/v1/repos", {
          owner: "acme",
          name: "lib",
          visibility: "public",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await as("ada", "POST", "/api/v1/repos/acme/lib/edits", {
          branch: "main",
          message: "first",
          files: [{ path: "a.txt", content: "one\n" }],
        })
      ).status,
    ).toBe(201);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ---- who may say what ----

  test("a reader may comment and may not approve", async () => {
    const number = await proposeFrom("bob", "topic-1", "two\n", "add two");

    const approve = await as(
      "cas",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "approved" },
    );
    // cas can read a public repo and cannot write it: the verdict that
    // carries authority is a writer's.
    expect(approve.status).toBe(403);
    expect((await read<{ error: string }>(approve)).error).toBe("forbidden");

    const commented = await as(
      "cas",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "commented", body: "reads well" },
    );
    expect(commented.status).toBe(201);
    expect((await read<{ state: string }>(commented)).state).toBe("commented");

    // A comment is not an approval, and the gate must not read it as one.
    const listed = await read<{ state: string }[]>(
      await as(
        "cas",
        "GET",
        `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      ),
    );
    expect(listed.map((r) => r.state)).toEqual(["commented"]);
  });

  test("you cannot approve your own pull request", async () => {
    const number = await proposeFrom("bob", "topic-2", "three\n", "add three");
    const refused = await as(
      "bob",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "approved" },
    );
    expect(refused.status).toBe(422);
    expect((await read<{ error: string }>(refused)).error).toBe("self_review");

    // …but the author may still request changes on it, and may comment.
    expect(
      (
        await as(
          "bob",
          "POST",
          `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
          { state: "commented", body: "still working" },
        )
      ).status,
    ).toBe(201);
  });

  test("an unknown verdict is refused rather than coerced", async () => {
    const number = await proposeFrom("bob", "topic-3", "four\n", "add four");
    const refused = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "lgtm" },
    );
    expect(refused.status).toBe(422);
    expect((await read<{ error: string }>(refused)).error).toBe(
      "invalid_state",
    );
  });

  // ---- the gate ----

  test("require_review blocks a merge until a writer approves", async () => {
    expect(
      (
        await as("ada", "PATCH", "/api/v1/repos/acme/lib", {
          requireReview: true,
        })
      ).status,
    ).toBe(200);
    const settings = await read<{ requireReview: boolean }>(
      await as("ada", "GET", "/api/v1/repos/acme/lib"),
    );
    expect(settings.requireReview).toBe(true);

    const number = await proposeFrom("bob", "gated", "gated\n", "gated work");

    // The status a client renders says so before it tries.
    const before = await read<{
      status: {
        mergeable: boolean;
        reviews: { approved: number; required: boolean; mergeable: boolean };
      };
    }>(await as("ada", "GET", `/api/v1/repos/acme/lib/pulls/${number}`));
    expect(before.status.mergeable).toBe(true);
    expect(before.status.reviews.required).toBe(true);
    expect(before.status.reviews.approved).toBe(0);
    expect(before.status.reviews.mergeable).toBe(false);

    const refused = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/merge`,
      {},
    );
    expect(refused.status).toBe(409);
    expect((await read<{ error: string }>(refused)).error).toBe(
      "review_required",
    );

    // A reader's comment does not unlock it.
    await as(
      "cas",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "commented", body: "nice" },
    );
    expect(
      (
        await as(
          "ada",
          "POST",
          `/api/v1/repos/acme/lib/pulls/${number}/merge`,
          {},
        )
      ).status,
    ).toBe(409);

    // A writer's approval does.
    expect(
      (
        await as(
          "ada",
          "POST",
          `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
          { state: "approved", body: "ship it" },
        )
      ).status,
    ).toBe(201);
    const merged = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/merge`,
      {},
    );
    expect(merged.status).toBe(200);
    expect((await read<{ merged: boolean }>(merged)).merged).toBe(true);

    await as("ada", "PATCH", "/api/v1/repos/acme/lib", {
      requireReview: false,
    });
  });

  test("changes requested on the current head blocks; on an older head it does not", async () => {
    const number = await proposeFrom("bob", "blocked", "blocked\n", "blocked");

    expect(
      (
        await as(
          "ada",
          "POST",
          `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
          { state: "changes_requested", body: "rename this" },
        )
      ).status,
    ).toBe(201);

    // Requested against the head that is there now: the merge is refused,
    // even with `require_review` off — a request for changes is a stop sign
    // regardless of whether an approval was ever required.
    const refused = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/merge`,
      {},
    );
    expect(refused.status).toBe(409);
    expect((await read<{ error: string }>(refused)).error).toBe(
      "review_required",
    );

    // Push again. The verdict was passed on the old head and is now stale:
    // new code is new code, and nobody has objected to *this* one.
    expect(
      (
        await as("bob", "POST", "/api/v1/repos/acme/lib/edits", {
          branch: "blocked",
          message: "renamed",
          files: [{ path: "a.txt", content: "renamed\n" }],
        })
      ).status,
    ).toBe(201);

    const after = await read<{
      status: { reviews: { changesRequested: number; mergeable: boolean } };
    }>(await as("ada", "GET", `/api/v1/repos/acme/lib/pulls/${number}`));
    expect(after.status.reviews.changesRequested).toBe(0);
    expect(after.status.reviews.mergeable).toBe(true);

    expect(
      (
        await as(
          "ada",
          "POST",
          `/api/v1/repos/acme/lib/pulls/${number}/merge`,
          {},
        )
      ).status,
    ).toBe(200);
  });

  test("an approval of an older head does not satisfy require_review", async () => {
    const number = await proposeFrom("bob", "stale", "stale\n", "stale work");
    expect(
      (
        await as(
          "ada",
          "POST",
          `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
          { state: "approved" },
        )
      ).status,
    ).toBe(201);
    // Push after the approval, then demand one.
    await as("bob", "POST", "/api/v1/repos/acme/lib/edits", {
      branch: "stale",
      message: "more",
      files: [{ path: "b.txt", content: "more\n" }],
    });
    await as("ada", "PATCH", "/api/v1/repos/acme/lib", { requireReview: true });

    const refused = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/merge`,
      {},
    );
    expect(refused.status).toBe(409);
    expect((await read<{ error: string }>(refused)).error).toBe(
      "review_required",
    );
    await as("ada", "PATCH", "/api/v1/repos/acme/lib", {
      requireReview: false,
    });
  });

  test("the latest verdict per reviewer is the one that counts", async () => {
    const number = await proposeFrom("bob", "turned", "turned\n", "turned");
    await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "changes_requested", body: "no" },
    );
    await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      { state: "approved", body: "fine, yes" },
    );
    const status = await read<{
      status: {
        reviews: { approved: number; changesRequested: number };
      };
    }>(await as("ada", "GET", `/api/v1/repos/acme/lib/pulls/${number}`));
    expect(status.status.reviews.changesRequested).toBe(0);
    expect(status.status.reviews.approved).toBe(1);
    // Both are kept: the record of who said what is the point of the table.
    const all = await read<{ state: string }[]>(
      await as(
        "ada",
        "GET",
        `/api/v1/repos/acme/lib/pulls/${number}/review-states`,
      ),
    );
    expect(all.map((r) => r.state)).toEqual(["changes_requested", "approved"]);
  });

  // ---- threads ----

  test("a review thread resolves, unresolves, and refuses a stranger", async () => {
    const number = await proposeFrom("bob", "thread", "thread\n", "threaded");
    const detail = await read<{
      diff: { files: { path: string }[] };
    }>(await as("ada", "GET", `/api/v1/repos/acme/lib/pulls/${number}`));
    expect(detail.diff.files.length).toBeGreaterThan(0);

    const comment = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/reviews`,
      { body: "why?", path: "a.txt", line: 1, side: "new" },
    );
    expect(comment.status).toBe(201);

    const comments = await read<{ anchor: string }[]>(
      await as("ada", "GET", `/api/v1/repos/acme/lib/pulls/${number}/reviews`),
    );
    const anchor = comments[0]!.anchor;
    expect(anchor).toMatch(/^[0-9a-f]{16}$/);

    // A reader who never spoke in the thread may not settle it.
    const stranger = await as(
      "cas",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/threads/${anchor}/resolve`,
      {},
    );
    expect(stranger.status).toBe(403);
    expect((await read<{ error: string }>(stranger)).error).toBe("forbidden");

    const resolved = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/threads/${anchor}/resolve`,
      {},
    );
    expect(resolved.status).toBe(200);
    expect(
      (await read<{ resolvedAt: string | null }>(resolved)).resolvedAt,
    ).not.toBeNull();

    const threads = await read<
      { anchor: string; resolvedAt: string | null; comments: unknown[] }[]
    >(await as("ada", "GET", `/api/v1/repos/acme/lib/pulls/${number}/threads`));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.anchor).toBe(anchor);
    expect(threads[0]!.resolvedAt).not.toBeNull();

    const reopened = await as(
      "ada",
      "DELETE",
      `/api/v1/repos/acme/lib/pulls/${number}/threads/${anchor}/resolve`,
    );
    expect(reopened.status).toBe(200);
    expect(
      (await read<{ resolvedAt: string | null }>(reopened)).resolvedAt,
    ).toBeNull();

    // A thread that does not exist is not_found, not "forbidden".
    const missing = await as(
      "ada",
      "POST",
      `/api/v1/repos/acme/lib/pulls/${number}/threads/deadbeefdeadbeef/resolve`,
      {},
    );
    expect(missing.status).toBe(404);
    expect((await read<{ error: string }>(missing)).error).toBe("not_found");
  });

  // ---- the outbox ----

  test("every verdict and resolution reaches the event outbox", () => {
    const kinds = listEvents(app.db, { limit: 500 }).map((e) => e.kind);
    expect(kinds).toContain("pull.reviewed");
    expect(kinds).toContain("pull.thread_resolved");
    const reviewed = listEvents(app.db, { limit: 500 }).find(
      (e) => e.kind === "pull.reviewed" && "state" in e.payload,
    );
    expect(reviewed?.payload.state).toBeDefined();
  });
});
