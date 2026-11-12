/**
 * A review's line comments travel inside the review (#11479): one request
 * carries the verdict and the comments, and an origin that refuses that
 * payload still gets the verdict, with the comments posted the old way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ForgejoProvider } from "../src/origins/providers/forgejo.ts";
import { GitHubProvider } from "../src/origins/providers/github.ts";
import { staticCredential, type ReviewLine } from "../src/origins/types.ts";
import { newFakeState, serveFakeForge, type FakeForge, type FakeState } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "tok-review-lines-1";
const lines: ReviewLine[] = [
  { path: "a.ts", line: 3, side: "new", body: "one" },
  { path: "a.ts", line: 9, side: "old", body: "two" },
  { path: "b.ts", line: 1, side: "new", body: "three" },
];

for (const kind of ["forgejo", "github"] as const) {
  describe(`${kind}: line comments inside the review`, () => {
    let state: FakeState;
    let fake: FakeForge;
    beforeEach(() => {
      state = newFakeState(kind, "trevato", TOKEN);
      state.repos.push({ id: 1, fullName: "o/r", cloneUrl: "http://127.0.0.1/none.git", admin: true });
      state.issues.set("o/r", [
        { id: 5, number: 1, title: "p", body: "", state: "open", user: "x", labels: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pull: { headSha: "a".repeat(40), headRef: "h", baseRef: "main", merged: false } },
      ] as never);
      fake = serveFakeForge(state);
    });
    afterEach(() => fake.stop());
    const provider = () => {
      const credential = staticCredential({ kind, apiUrl: fake.apiUrl, webUrl: fake.url, token: TOKEN });
      return kind === "forgejo" ? new ForgejoProvider(credential) : new GitHubProvider(credential);
    };
    const posts = () => state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/pulls/1/reviews"));

    test("one request carries the verdict and the three comments", async () => {
      const sent = await provider().submitReview("o/r", 1, { state: "changes_requested", body: "see lines", comments: lines });
      expect(sent.ok).toBe(true);
      if (sent.ok) expect(sent.value.carried).toBe(3);
      expect(posts()).toHaveLength(1);
      const body = JSON.parse(posts()[0]!.body);
      expect(body.event).toBe("REQUEST_CHANGES");
      expect(body.comments).toHaveLength(3);
      expect(body.comments[0]).toMatchObject(
        kind === "forgejo" ? { path: "a.ts", new_position: 3, body: "one" } : { path: "a.ts", line: 3, side: "RIGHT", body: "one" },
      );
      expect(body.comments[1]).toMatchObject(kind === "forgejo" ? { old_position: 9 } : { line: 9, side: "LEFT" });
    });

    test("a review without lines sends no comments key", async () => {
      await provider().submitReview("o/r", 1, { state: "approved", body: "" });
      expect(posts()).toHaveLength(1);
      expect("comments" in JSON.parse(posts()[0]!.body)).toBe(false);
    });

    test("an origin that refuses the payload still gets the verdict, alone", async () => {
      state.refuseReviewComments = true;
      const sent = await provider().submitReview("o/r", 1, { state: "changes_requested", body: "ok", comments: lines });
      expect(sent.ok).toBe(true);
      if (sent.ok) expect(sent.value.carried).toBe(0);
      const bodies = posts().map((r) => JSON.parse(r.body));
      expect(bodies).toHaveLength(2);
      expect("comments" in bodies[1]).toBe(false);
      expect(bodies[1].body).toBe("ok");
    });

    test("a refusal about who we are is not retried", async () => {
      state.token = "other";
      const sent = await provider().submitReview("o/r", 1, { state: "approved", body: "", comments: lines });
      expect(sent.ok).toBe(false);
      expect(posts()).toHaveLength(1);
    });
  });
}
