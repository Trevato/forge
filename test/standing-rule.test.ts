/**
 * A standing rule per repository: hand-overs on a repository ruled
 * "decider" are answered by the sweep without a person; a shelved one
 * closes with no model call; "decider_tell" leaves the unsure ones; the
 * settings form saves the rule; a manual tap follows it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { decideAsk } from "../src/actions/asks_decide.ts";
import { createOrg } from "../src/core/orgs.ts";
import { recordInteraction } from "../src/core/interactions.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listDecisions } from "../src/core/decisions.ts";
import type { Issue } from "../src/core/issues.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import type { Decider } from "../src/crew/decide.ts";
import { undoHandled } from "../src/crew/handover.ts";
import { sweepStanding } from "../src/crew/standing.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a standing rule per repository", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie = "";
  let calls = 0;
  let says = 0.9;

  const standIn: Decider = {
    name: "stand-in",
    async decide(_state, questions) {
      calls++;
      const out: Record<string, any> = {};
      for (const [key, q] of Object.entries(questions)) {
        const [a, b] = q.options as [string, string];
        out[key] = { choice: a, p: says, probabilities: { [a]: says, [b]: 1 - says } };
      }
      return out as any;
    },
  };

  const rule = (by: "me" | "decider" | "decider_tell", autonomy: "off" | "assisted" = "assisted") => {
    repo = updateRepoSettings(app.db, repo, { decisionsBy: by, autonomy });
  };
  const parked = (title: string): Issue => {
    const made = openIssue(app, alice, repo, { title });
    if (!made.ok) throw new Error(String(made.error));
    expect(addComment(app, alice, repo, made.value, BREAKER_NOTE).ok).toBe(true);
    return made.value;
  };
  const asking = (issue: Issue): boolean =>
    askLinesFor(app.db, alice).some((r) => r.items.includes(`parked:${issue.id}`));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-standing-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-standing-passphrase",
    });
    if (!made.ok) throw new Error("no alice");
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-standing-passphrase" }),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    alice = getUserByName(app.db, "alice")!;
    const r = await createRepo(app, alice, { name: "shelf", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    app.config.decider = standIn;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a repository ruled me is left alone", async () => {
    rule("me");
    const issue = parked("mine");
    const before = calls;
    await sweepStanding(app);
    expect(asking(issue)).toBe(true);
    expect(calls).toBe(before);
  });

  test("ruled decider, a hand-over is answered without a person, once", async () => {
    rule("decider");
    says = 0.9;
    const issue = parked("old idea");
    // The card left over from the "me" test is the rule's too, now.
    const swept = await sweepStanding(app);
    expect(swept.byDecider).toBe(2);
    expect(asking(issue)).toBe(false);
    const row = listDecisions(app.db, repo.id, { kind: "hand" }).find((d) => d.issueId === issue.id)!;
    expect(row.by).toBe("stand-in");
    expect(row.outcome).toBe("set_aside");
    const after = calls;
    await sweepStanding(app);
    expect(calls).toBe(after);
  });

  test("decider_tell leaves an unsure one with the owner; decider's word stands", async () => {
    says = 0.55;
    rule("decider_tell");
    const unsure = parked("hard call");
    await sweepStanding(app);
    expect(asking(unsure)).toBe(true);
    const row = listDecisions(app.db, repo.id, { kind: "hand" }).find((d) => d.issueId === unsure.id)!;
    expect(row.outcome).toBe("asked");

    rule("decider");
    const standing = parked("settled");
    await sweepStanding(app);
    expect(asking(standing)).toBe(false);
    // The unsure one was already answered: it is not asked again.
    expect(asking(unsure)).toBe(true);
    says = 0.9;
  });

  test("a shelved repository's hand-over closes with no model call, and undo restores it", async () => {
    rule("decider_tell", "off");
    const issue = parked("shelved");
    const before = calls;
    const swept = await sweepStanding(app);
    expect(swept.byRule).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(before);
    expect(asking(issue)).toBe(false);
    const row = listDecisions(app.db, repo.id, { kind: "hand" }).find((d) => d.issueId === issue.id)!;
    expect(row.by).toBe("rule");
    expect((row.state as any).evidence.title).toBe("shelved");
    expect(undoHandled(app, alice, row.id)).toMatchObject({ outcome: "undone" });
    expect(asking(issue)).toBe(true);
    await sweepStanding(app);
    expect(asking(issue)).toBe(true);
  });

  test("the settings form saves the rule and refuses a made-up one", async () => {
    const post = (decisions: string) =>
      fetch(`${servers.url}/alice/shelf/settings/autonomy`, {
        method: "POST",
        headers: { cookie, origin: servers.url },
        body: new URLSearchParams({ autonomy: "assisted", ceiling: "20", slots: "1", direction: "", decisions }),
        redirect: "manual",
      });
    expect((await post("decider")).status).toBe(303);
    expect(getRepoById(app.db, repo.id)!.decisionsBy).toBe("decider");
    await post("nobody");
    expect(getRepoById(app.db, repo.id)!.decisionsBy).toBe("decider");
    const page = await (await fetch(`${servers.url}/alice/shelf/settings`, { headers: { cookie } })).text();
    expect(page).toContain("Decisions here");
  });

  test("a manual tap follows the repository's rule, as the sweep does", async () => {
    const tap = async (title: string) => {
      const issue = parked(title);
      const done = await decideAsk(app, alice, `parked:${issue.id}`);
      expect(done.ok).toBe(true);
      return issue;
    };
    says = 0.6;
    rule("decider_tell");
    expect(asking(await tap("tap cautious"))).toBe(true);
    rule("decider");
    expect(asking(await tap("tap ruled"))).toBe(false);
  });

  test("on an organisation's repository the rule closes the card for its person admin", async () => {
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error("no org");
    const r = await createRepo(app, alice, { owner: "acme", name: "svc", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    const orgRepo = updateRepoSettings(app.db, r.value, { decisionsBy: "decider", autonomy: "assisted" });
    const made = openIssue(app, alice, orgRepo, { title: "org idea" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addComment(app, alice, orgRepo, made.value, BREAKER_NOTE).ok).toBe(true);
    const item = `parked:${made.value.id}`;
    expect(askLinesFor(app.db, alice).some((l) => l.items.includes(item))).toBe(true);
    says = 0.9;
    await sweepStanding(app);
    expect(askLinesFor(app.db, alice).some((l) => l.items.includes(item))).toBe(false);
    const row = listDecisions(app.db, orgRepo.id, { kind: "hand" }).find((d) => d.issueId === made.value.id)!;
    expect(row.outcome).toBe("set_aside");
    expect((row.state as any).actor).toBe("standing");
    // Any admin takes it back, and it asks again.
    expect(undoHandled(app, alice, row.id)).toMatchObject({ outcome: "undone" });
    expect(askLinesFor(app.db, alice).some((l) => l.items.includes(item))).toBe(true);
  });

  test("a dismissal from an earlier park does not shield a later one", async () => {
    rule("decider");
    says = 0.9;
    const issue = parked("twice");
    recordInteraction(app.db, {
      viewerId: alice.id,
      itemId: `ask:parked:${issue.id}`,
      kind: "dismissed",
      repoId: repo.id,
      actorId: alice.id,
    });
    await Bun.sleep(5);
    expect(addComment(app, alice, repo, issue, BREAKER_NOTE).ok).toBe(true);
    const before = calls;
    await sweepStanding(app);
    expect(calls).toBe(before + 1);
  });

  test("a tick on a card answered a moment ago does not pay again", async () => {
    rule("decider");
    const issue = parked("tap then tick");
    await decideAsk(app, alice, `parked:${issue.id}`);
    // A newer park inside the ten minutes waits for the next tick.
    expect(addComment(app, alice, repo, issue, BREAKER_NOTE).ok).toBe(true);
    const before = calls;
    await sweepStanding(app);
    expect(calls).toBe(before);
  });
});
