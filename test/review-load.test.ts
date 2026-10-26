/**
 * Reviews in flight per reviewer (#4733): `reviewLoad` counts queued and
 * running review runs; /boards and the terminal's Flow dialog say it, and a
 * reader kept to public repositories is told nothing of a private one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { reviewLoad } from "../src/crew/review.ts";
import { reviewersBusy, reviewingSays } from "../src/flow/reviewing.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("reviews in flight", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let agentToken = "";
  let quill = "";

  const review = (repoId: string, issueId: string, state: string) => {
    const run = createRun(app.db, { repoId, kind: "agent", issueId, actorId: quill, reason: "review" });
    app.db.query("UPDATE run SET state = ?2 WHERE id = ?1").run(run.id, state);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-load-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    const agent = await createAgent(app, alice, { username: "quill" });
    if (!agent.ok) throw new Error(String(agent.error));
    quill = getUserByName(app.db, "quill")!.id;
    agentToken = createToken(app.db, quill, "t", "ro").token;
    for (const [name, visibility] of [["open", "public"], ["shut", "private"]] as const) {
      const r = await createRepo(app, alice, { name, visibility });
      if (!r.ok) throw new Error(String(r.error));
      const i = createIssue(app.db, { repoId: r.value.id, authorId: alice.id, title: name, kind: "pull" });
      if (!i.ok) throw new Error(i.error);
      review(r.value.id, i.value.id, "running");
      // A finished review is not in flight.
      review(r.value.id, i.value.id, "ok");
      if (visibility === "private") review(r.value.id, i.value.id, "queued");
    }
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the count is queued and running runs, and a public reader's leaves out private repositories", () => {
    expect(reviewLoad(app.db).get(quill)).toBe(3);
    expect(reviewLoad(app.db, true).get(quill)).toBe(1);
    expect(reviewingSays(reviewersBusy(app.db))).toBe("3 reviews in flight: quill 3.");
    expect(reviewingSays(reviewersBusy(app.db, true))).toBe("1 review in flight: quill 1.");
  });

  test("the Flow dialog says it, and an agent reader's is cut to public", () => {
    expect(flowLines(app.db).join(" ")).toContain("3 reviews in flight: quill 3.");
    const cut = flowLines(app.db, new Date(), [], { queues: [] }).join(" ");
    expect(cut).toContain("1 review in flight: quill 1.");
    expect(cut).not.toContain("quill 3");
  });

  test("/boards says it to the owner and, cut to public, to an agent", async () => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie } })).text();
    expect(page).toContain(`id="review-load"`);
    expect(page).toContain("3 reviews in flight: quill 3.");
    const guest = await (await fetch(`${servers.url}/boards`)).text();
    expect(guest).not.toContain("review-load");
    const agent = await (await fetch(`${servers.url}/boards`, { headers: { authorization: `Bearer ${agentToken}` } })).text();
    expect(agent).not.toContain("quill 3");
  });

  test("the flow telemetry (MCP `flow`, API) carries it, cut to public for an agent", () => {
    const owner = flowFor(app, { kind: "owner" }).reviewing;
    expect(owner.says).toBe("3 reviews in flight: quill 3.");
    const cut = flowFor(app, { kind: "agent" }).reviewing;
    expect(cut.says).toBe("1 review in flight: quill 1.");
    expect(cut.reviewers).toEqual([{ reviewer: "quill", count: 1 }]);
  });
});
