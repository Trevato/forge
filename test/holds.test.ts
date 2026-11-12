/**
 * A pull can be held (#773): a person who writes the repository says "not
 * this one yet", and until it is released no rule sends the pull to review
 * or lands it. The refusals come first.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent, removeFromCrew } from "../src/actions/crew.ts";
import { expireCrewHolds, holdPull, releaseOnGreen, releasePull } from "../src/actions/holds.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {} from "../src/core/agents.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import {
  cleanWhy,
  getHold,
  holdsFor,
  lastRelease,
  releaseHold,
  setHold,
  WHY_MAX,
} from "../src/core/holds.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { landIfGreen, parkPull } from "../src/crew/autonomy.ts";
import { sendToReview, sweepReviews } from "../src/crew/review.ts";
import { startChecks } from "../src/checks/service.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordAskLedger } from "../src/web/studio/asks.ts";

/** One forge for a describe: people, a repository with a seed commit, and pulls on it. */
async function forge(prefix: string, visibility: "public" | "private") {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const app = createApp({ dataDir, port: 0 });
  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const alice = await person("alice");
  const made = await createRepo(app, alice, { name: "garden", visibility });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "# garden\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  /** An open pull from a new branch; `body` may say what it closes. */
  const pullOn = async (branch: string, body = ""): Promise<Pull> => {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: `Change ${branch}`,
      body,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  /** A passing check on the pull's head, finished `minutesAgo`. */
  const passCheck = (pull: Pull, minutesAgo = 0): Pull => {
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    if (minutesAgo > 0)
      app.db
        .query("UPDATE run SET finished_at = ?2 WHERE id = ?1")
        .run(
          check.id,
          new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        );
    return pull;
  };
  const close = async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, alice, repo, person, pullOn, passCheck, close };
}

describe("who may hold a pull, and who may not", () => {
  let f: Awaited<ReturnType<typeof forge>>;
  let servers: Servers;
  let base: string;
  let bob: User;
  let bot: User;
  let pull: Pull;
  let hidden: Pull;
  let vault: Repo;
  const tokens: Record<string, string> = {};

  const api = (
    token: string | null,
    method: "PUT" | "DELETE" | "GET",
    repo: string,
    number: number,
    payload?: unknown,
  ) =>
    fetch(`${base}/api/v1/repos/${repo}/pulls/${number}/hold`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  const mcp = async (token: string, args: Record<string, unknown>) => {
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
        params: { name: "hold", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text, value: undefined }
      : { error: undefined, value: JSON.parse(text) };
  };

  beforeAll(async () => {
    f = await forge("forge-holds-who-", "public");
    servers = await serve(f.app);
    base = servers.url;
    bob = await f.person("bob");
    const agent = await createAgent(f.app, f.alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    expect(addToCrew(f.app, f.alice, f.repo, "bot").ok).toBe(true);
    const made = await createRepo(f.app, f.alice, {
      name: "vault",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    vault = made.value;
    await commitToBranch(f.app, f.alice, vault, {
      message: "seed",
      files: [{ path: "README.md", content: "# vault\n" }],
    });
    await commitToBranch(f.app, f.alice, vault, {
      branch: "secret",
      base: "main",
      message: "secret",
      files: [{ path: "s.md", content: "x\n" }],
    });
    const opened = await openPull(f.app, f.alice, vault, {
      title: "Hidden change",
      body: "",
      baseBranch: "main",
      headBranch: "secret",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    hidden = opened.value;
    pull = await f.pullOn("one");
    tokens["alice"] = createToken(f.app.db, f.alice.id, "t", "rw").token;
    tokens["aliceRo"] = createToken(f.app.db, f.alice.id, "t", "ro").token;
    tokens["bob"] = createToken(f.app.db, bob.id, "t", "rw").token;
    tokens["bot"] = createToken(f.app.db, bot.id, "run", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    await f.close();
  });

  const WHY = { why: "a second review is under way" };
  const held = () => getHold(f.app.db, pull.id);

  test("a reader who cannot write cannot hold, by the API, the MCP, the form or the action", async () => {
    expect(
      (await api(tokens["bob"]!, "PUT", "alice/garden", pull.number, WHY))
        .status,
    ).toBe(403);
    const told = await mcp(tokens["bob"]!, {
      app: "alice/garden",
      pull: pull.number,
      why: WHY.why,
      dryRun: false,
    });
    expect(told.error).toContain("forbidden");
    // Even a dry run does not tell a reader it would work.
    expect(
      (
        await mcp(tokens["bob"]!, {
          app: "alice/garden",
          pull: pull.number,
          why: WHY.why,
        })
      ).error,
    ).toContain("forbidden");
    const form = await fetch(`${base}/alice/garden/pulls/${pull.number}/hold`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens["bob"]!}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(WHY).toString(),
      redirect: "manual",
    });
    expect(form.status).toBe(404);
    expect(holdPull(f.app, bob, f.repo, pull, WHY.why)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(held()).toBeUndefined();
  });

  test("a stranger cannot hold, and a pull they cannot see is no pull at all", async () => {
    expect(
      (await api(null, "PUT", "alice/garden", pull.number, WHY)).status,
    ).toBe(401);
    expect(holdPull(f.app, undefined, f.repo, pull, WHY.why)).toEqual({
      ok: false,
      error: "unauthorized",
    });
    const unseen = await api(
      tokens["bob"]!,
      "PUT",
      "alice/vault",
      hidden.number,
      WHY,
    );
    const missing = await api(tokens["bob"]!, "PUT", "alice/vault", 999, WHY);
    expect(unseen.status).toBe(404);
    expect(await unseen.json()).toEqual(await missing.json());
    expect(holdPull(f.app, bob, vault, hidden, WHY.why)).toEqual({
      ok: false,
      error: "not_found",
    });
    // A pull of another repository is not this repository's to hold.
    expect(holdPull(f.app, f.alice, vault, pull, WHY.why)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(held()).toBeUndefined();
    expect(getHold(f.app.db, hidden.id)).toBeUndefined();
  });

  test("an agent on the crew cannot hold, and a read-only token cannot either", async () => {
    expect(
      (await api(tokens["bot"]!, "PUT", "alice/garden", pull.number, WHY))
        .status,
    ).toBe(403);
    expect(holdPull(f.app, bot, f.repo, pull, WHY.why)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      (
        await mcp(tokens["bot"]!, {
          app: "alice/garden",
          pull: pull.number,
          why: WHY.why,
          dryRun: false,
        })
      ).error,
    ).toContain("forbidden");
    expect(
      (await api(tokens["aliceRo"]!, "PUT", "alice/garden", pull.number, WHY))
        .status,
    ).toBe(403);
    expect(
      (
        await mcp(tokens["aliceRo"]!, {
          app: "alice/garden",
          pull: pull.number,
          why: WHY.why,
          dryRun: false,
        })
      ).error,
    ).toContain("forbidden");
    expect(held()).toBeUndefined();
  });

  test("none of them can release what a person holds", async () => {
    expect(
      (await api(tokens["alice"]!, "PUT", "alice/garden", pull.number, WHY))
        .status,
    ).toBe(200);
    expect(held()?.heldByName).toBe("alice");
    for (const who of ["bob", "bot", "aliceRo"])
      expect(
        (await api(tokens[who]!, "DELETE", "alice/garden", pull.number)).status,
      ).toBe(403);
    expect(
      (await api(null, "DELETE", "alice/garden", pull.number)).status,
    ).toBe(401);
    for (const actor of [bob, bot])
      expect(releasePull(f.app, actor, f.repo, pull)).toEqual({
        ok: false,
        error: "forbidden",
      });
    expect(
      (
        await mcp(tokens["bot"]!, {
          app: "alice/garden",
          pull: pull.number,
          release: true,
          dryRun: false,
        })
      ).error,
    ).toContain("forbidden");
    const form = await fetch(
      `${base}/alice/garden/pulls/${pull.number}/release`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens["bob"]!}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
        redirect: "manual",
      },
    );
    expect(form.status).toBe(404);
    expect(held()?.why).toBe(WHY.why);
  });

  test("a hold needs its one line, and only an open pull takes one", async () => {
    const other = await f.pullOn("two");
    for (const [why, code] of [
      ["", "empty_why"],
      ["  \n ", "empty_why"],
      ["x".repeat(WHY_MAX + 1), "why_too_long"],
    ] as const) {
      const refused = await api(
        tokens["alice"]!,
        "PUT",
        "alice/garden",
        other.number,
        { why },
      );
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as any).error).toBe(code);
    }
    expect(getHold(f.app.db, other.id)).toBeUndefined();
    const merged = await mergePull(f.app, f.alice, f.repo, other, "squash");
    expect(merged.ok).toBe(true);
    const late = await api(
      tokens["alice"]!,
      "PUT",
      "alice/garden",
      other.number,
      WHY,
    );
    expect(late.status).toBe(409);
    expect(((await late.json()) as any).error).toBe("not_open");
  });
});

describe("a held pull and the rules", () => {
  let f: Awaited<ReturnType<typeof forge>>;
  let mason: User;
  let quill: User;
  const fresh = () => getRepoById(f.app.db, f.repo.id)!;
  const reviewRuns = (pull: Pull) =>
    listRuns(f.app.db, f.repo.id, { issueId: pull.id }).filter(
      (r) => r.reason === "review",
    );
  const merged = (pull: Pull) =>
    getPull(f.app.db, f.repo.id, pull.number)!.mergedAt !== null;
  /** A green pull an agent wrote, as the gate reads it. */
  const greenPull = async (name: string, author: User, minutesAgo = 0) => {
    const pull = await f.pullOn(name);
    f.app.db
      .query("UPDATE issue SET author_id = ?2 WHERE id = ?1")
      .run(pull.id, author.id);
    f.passCheck(pull, minutesAgo);
    // Read again: the author decides whose pull it is (#7572).
    return getPull(f.app.db, f.repo.id, pull.number)!;
  };
  const approve = (pull: Pull, by: User) =>
    submitReview(f.app.db, {
      issueId: pull.id,
      authorId: by.id,
      state: "approved",
      commitOid: pull.headOid,
    });
  const hold = (pull: Pull, why = "not this one yet") => {
    const held = holdPull(f.app, f.alice, fresh(), pull, why);
    if (!held.ok) throw new Error(held.error);
  };
  const release = (pull: Pull) => {
    const released = releasePull(f.app, f.alice, fresh(), pull);
    if (!released.ok) throw new Error(released.error);
  };

  beforeAll(async () => {
    f = await forge("forge-holds-rules-", "private");
    for (const name of ["mason", "quill"]) {
      const agent = await createAgent(f.app, f.alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(f.app, f.alice, f.repo, name).ok).toBe(true);
    }
    mason = getUserByName(f.app.db, "mason")!;
    quill = getUserByName(f.app.db, "quill")!;
    f.app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1",
      )
      .run(f.repo.id, f.alice.id);
  }, 30_000);

  afterAll(() => f.close());

  test("with no reviewer, a held green pull does not land; released, it does", async () => {
    const pull = await greenPull("plain", f.alice);
    hold(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    expect(merged(pull)).toBe(false);
    release(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(true);
    expect(merged(pull)).toBe(true);
  });

  test("a held green pull with an approving review does not land", async () => {
    seatAs(f.app.db, f.repo.id, quill.id, "reviewer");
    const pull = await greenPull("approved", mason);
    approve(pull, f.alice);
    hold(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    expect(merged(pull)).toBe(false);
    // The approval stands: released, the same head lands.
    release(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(true);
    expect(merged(pull)).toBe(true);
  });

  test("a held pull is not sent to the reviewer: not by the landing rule, not when asked, not by the sweep", async () => {
    const pull = await greenPull("unsent", mason);
    hold(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    expect(await sendToReview(f.app, fresh(), pull)).toBe("held");
    expect(await sweepReviews(f.app)).toBe(0);
    expect(reviewRuns(pull)).toHaveLength(0);
    // Released, it goes to review like any green pull, and waits for it.
    release(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    expect(reviewRuns(pull)).toHaveLength(1);
    expect(reviewRuns(pull)[0]!.actorId).toBe(quill.id);
    expect(merged(pull)).toBe(false);
  });

  test("holding a pull past the review's lapse and letting it go is not a way past the review", async () => {
    // Green two hours ago: unheld, the gate would call the review lapsed
    // and land it without one.
    const pull = await greenPull("waited", mason, 120);
    hold(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    release(pull);
    expect(await landIfGreen(f.app, fresh(), pull)).toBe(false);
    expect(merged(pull)).toBe(false);
    expect(reviewRuns(pull)).toHaveLength(1);
  });

  test("a held pull is not parked: the crew does not close it and build the same change beside it", async () => {
    const pull = await greenPull("stuck", mason);
    const state = () => getPull(f.app.db, f.repo.id, pull.number)!.state;
    hold(pull);
    expect(parkPull(f.app, fresh(), pull, "the check stayed red")).toBe(false);
    expect(state()).toBe("open");
    release(pull);
    expect(parkPull(f.app, fresh(), pull, "the check stayed red")).toBe(true);
    expect(state()).toBe("closed");
  });

  test("a person's own merge still works on a held pull", async () => {
    const pull = await greenPull("by-hand", f.alice);
    approve(pull, f.alice);
    hold(pull);
    const landed = await mergePull(f.app, f.alice, fresh(), pull, "squash");
    expect(landed.ok).toBe(true);
    expect(merged(pull)).toBe(true);
  });
});

describe("a hold is set, shown and lifted", () => {
  let f: Awaited<ReturnType<typeof forge>>;
  let servers: Servers;
  let base: string;
  let rw = "";
  let ro = "";
  let pull: Pull;
  let issueNumber = 0;
  const WHY = "a second review is under way";

  const api = (method: string, path: string, token = rw, payload?: unknown) =>
    fetch(`${base}/api/v1/repos/alice/garden${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  const mcp = async (
    name: string,
    args: Record<string, unknown>,
    token = rw,
  ) => {
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
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text, value: undefined }
      : { error: undefined, value: JSON.parse(text) };
  };
  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const page = async (path: string, cookie: string) =>
    (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const form = (path: string, cookie: string, fields: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  const events = (kind: string): number =>
    (
      f.app.db
        .query("SELECT count(*) AS n FROM event WHERE kind = ?1")
        .get(kind) as { n: number }
    ).n;

  beforeAll(async () => {
    f = await forge("forge-holds-shown-", "private");
    servers = await serve(f.app);
    base = servers.url;
    const record = insertApp(f.app.db, {
      repoId: f.repo.id,
      slug: "garden",
      access: "private",
    });
    if (!record.ok) throw new Error(record.error);
    rw = createToken(f.app.db, f.alice.id, "t", "rw").token;
    ro = createToken(f.app.db, f.alice.id, "t", "ro").token;
    const asked = openIssue(f.app, f.alice, f.repo, {
      title: "Water the beds",
    });
    if (!asked.ok) throw new Error(String(asked.error));
    issueNumber = asked.value.number;
    pull = f.passCheck(await f.pullOn("beds", `Closes #${issueNumber}`));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    await f.close();
  });

  test("the API holds with a line of why, says so on the pull, and lets go; each is said once in the outbox", async () => {
    const put = await api("PUT", `/pulls/${pull.number}/hold`, rw, {
      why: `  ${WHY}\n`,
    });
    expect(put.status).toBe(200);
    const held = (await put.json()) as any;
    expect([held.held, held.hold.by, held.hold.why]).toEqual([
      true,
      "alice",
      WHY,
    ]);
    const read = (await (
      await api("GET", `/pulls/${pull.number}`)
    ).json()) as any;
    expect(read.hold).toEqual(held.hold);
    expect(events("pull.held")).toBe(1);
    const gone = await api("DELETE", `/pulls/${pull.number}/hold`);
    expect(await gone.json()).toEqual({ held: false, released: true });
    expect(
      await (await api("DELETE", `/pulls/${pull.number}/hold`)).json(),
    ).toEqual({
      held: false,
      released: false,
    });
    expect(events("pull.released")).toBe(1);
    expect(
      ((await (await api("GET", `/pulls/${pull.number}`)).json()) as any).hold,
    ).toBeNull();
  });

  test("the MCP tool plans by default and changes nothing until told dryRun: false", async () => {
    const args = { app: "alice/garden", pull: pull.number, why: WHY };
    // A read-only token may ask what would happen.
    const planned = await mcp("hold", args, ro);
    expect(planned.value.says).toBe(
      `Would hold alice/garden#${pull.number}: "${WHY}". Nothing changed; send dryRun: false to do it.`,
    );
    expect([planned.value.held, planned.value.dryRun]).toEqual([false, true]);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect((await mcp("hold", { ...args, why: " " })).error).toContain(
      "empty_why",
    );
    expect((await mcp("hold", { ...args, pull: 999 })).error).toContain(
      "no_such_pull",
    );
    const done = await mcp("hold", { ...args, dryRun: false });
    expect(done.value.says).toBe(
      `Held alice/garden#${pull.number}. No rule reviews or lands it until it is released.`,
    );
    expect(getHold(f.app.db, pull.id)?.why).toBe(WHY);
    const wouldGo = await mcp("hold", { ...args, release: true }, ro);
    expect(wouldGo.value.says).toStartWith(
      `Would release alice/garden#${pull.number}.`,
    );
    expect(getHold(f.app.db, pull.id)).toBeDefined();
    const went = await mcp("hold", { ...args, release: true, dryRun: false });
    expect(went.value.says).toBe(
      `Released alice/garden#${pull.number}. The rules take it from here.`,
    );
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(
      (await mcp("hold", { ...args, release: true, dryRun: false })).value.says,
    ).toBe(`Nothing holds alice/garden#${pull.number}.`);
  });

  test("the change page offers the hold, then says who holds it and why, with the way to let it go", async () => {
    const cookie = await signIn("alice");
    const change = `/alice/garden/pulls/${pull.number}`;
    const before = await page(change, cookie);
    expect(before).toContain(`id="hold"`);
    expect(before).toContain("Hold this pull request");
    expect(before).toContain(
      `action="/alice/garden/pulls/${pull.number}/hold"`,
    );
    expect(before).not.toContain("holds this");
    // No words, no hold.
    const blank = await form(
      `/alice/garden/pulls/${pull.number}/hold`,
      cookie,
      { why: " " },
    );
    expect(blank.status).toBe(303);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    const sent = await form(`/alice/garden/pulls/${pull.number}/hold`, cookie, {
      why: WHY,
    });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe(`${change}#hold`);
    const after = await page(change, cookie);
    expect(after).toContain("holds this");
    expect(after).toContain(WHY);
    expect(after).toContain(
      "No rule sends it to review or lands it until it is released",
    );
    expect(after).toContain(
      `action="/alice/garden/pulls/${pull.number}/release"`,
    );
    expect(after).not.toContain("Hold this pull request");
    // The change's Files step, the one that reads the code, says it too
    // (#628: one change page; `?mode=dev` answers the same page now).
    const dev = await page(`/alice/garden/pulls/${pull.number}/files`, cookie);
    expect(dev).toContain("holds this");
    expect(dev).toContain(WHY);
    expect(dev).not.toContain(
      `action="/alice/garden/pulls/${pull.number}/release"`,
    );
  });

  test("the map says held on the issue the pull answers, with who and why", async () => {
    const cookie = await signIn("alice");
    const map = await page("/alice/garden/map", cookie);
    const card =
      map.match(
        /<a[^>]*class="map-node"[^>]*>(?:(?!<\/a>)[\s\S])*Water the beds(?:(?!<\/a>)[\s\S])*<\/a>/,
      )?.[0] ?? "";
    expect(card).toContain('data-state="held"');
    expect(card).toContain(`held by alice: ${WHY}`);
    const told = (await mcp("map", { app: "alice/garden" })).value;
    const issue = told.issues.find((i: any) => i.number === issueNumber);
    expect([issue.word, issue.heldBy]).toEqual(["held", `alice: ${WHY}`]);
    expect(told.counts.held).toBe(1);
  });

  test("a hold asks nothing of the person who set it; another person who writes is still asked", async () => {
    const dana = await f.person("dana");
    f.app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(dana.id);
    const mine = await signIn("alice");
    const theirs = await signIn("dana");
    // What needs you, pinned on the home (#634), is the part to read: the
    // feed below it may well mention the change as news.
    const asks = async (cookie: string) => {
      const home = await page("/asks", cookie);
      const at = home.indexOf('<section id="needs-you"');
      return at === -1 ? "" : home.slice(at, home.indexOf("</section>", at));
    };
    // Held by alice (the test above): the green change is not on her asks.
    expect(await asks(mine)).not.toContain(pull.title);
    expect(await asks(theirs)).toContain(pull.title);
    // Let go, it asks her for a look like any green change here.
    const let_go = await form(
      `/alice/garden/pulls/${pull.number}/release`,
      mine,
      {},
    );
    expect(let_go.status).toBe(303);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(await asks(mine)).toContain(pull.title);
    // And the map goes back to saying a pull waits.
    const card =
      (await page("/alice/garden/map", mine)).match(
        /<a[^>]*class="map-node"[^>]*>(?:(?!<\/a>)[\s\S])*Water the beds/,
      )?.[0] ?? "";
    expect(card).toContain('data-state="waiting"');
  });
  test("in the asks ledger a hold is the holder's answer, not an ask that went away", async () => {
    const dana = getUserByName(f.app.db, "dana")!;
    const how = (viewer: User) =>
      f.app.db
        .query<{ how: string | null }, [string, string]>(
          "SELECT ended_how AS how FROM ask_ledger WHERE viewer_id = ?1 AND ask_id = ?2",
        )
        .all(viewer.id, `look:${pull.id}`)
        .map((r) => r.how);
    recordAskLedger(f.app.db);
    expect([how(f.alice), how(dana)]).toEqual([[null], [null]]);
    const held = holdPull(f.app, f.alice, f.repo, pull, WHY);
    expect(held.ok).toBe(true);
    recordAskLedger(f.app.db);
    // She said "not yet"; dana is still asked.
    expect([how(f.alice), how(dana)]).toEqual([["acted"], [null]]);
  });

  test("until green: the form sets it, the card says it, and the release shows on the pull page as the forge's line", async () => {
    const cookie = await signIn("alice");
    const mine = await f.pullOn("until-green-page");
    const change = `/alice/garden/pulls/${mine.number}`;
    expect(await page(change, cookie)).toContain('name="until"');
    const sent = await form(`${change}/hold`, cookie, {
      why: "red alone",
      until: "green",
    });
    expect(sent.status).toBe(303);
    expect(getHold(f.app.db, mine.id)?.until).toBe("green");
    expect(await page(change, cookie)).toContain("Releases on green.");
    // The MCP door sets it too.
    releaseHold(f.app.db, mine.id, f.alice.id);
    const planned = await mcp("hold", {
      app: "alice/garden",
      pull: mine.number,
      why: "red alone",
      until: "green",
      dryRun: false,
    });
    expect(planned.error).toBeUndefined();
    expect(getHold(f.app.db, mine.id)?.until).toBe("green");
    releaseHold(f.app.db, mine.id, f.alice.id);
    const typo = await mcp("hold", {
      app: "alice/garden",
      pull: mine.number,
      why: "red alone",
      until: "red",
      dryRun: false,
    });
    expect(typo.error).toContain("bad_until");
    expect(getHold(f.app.db, mine.id)).toBeUndefined();
    holdPull(f.app, f.alice, f.repo, mine, "red alone", false, "green");
    const check = createRun(f.app.db, {
      repoId: f.repo.id,
      kind: "check",
      issueId: mine.id,
      env: `pull-${mine.number}`,
      commitOid: mine.headOid,
      reason: "pull",
    });
    claimRun(f.app.db, check.id);
    const done = finishRun(f.app.db, check.id, { state: "ok", summary: "ok" })!;
    expect(releaseOnGreen(f.app, done)).toBe(true);
    const text = await page(change, cookie);
    expect(text).toContain(`hold released: green on ${mine.headOid.slice(0, 7)}`);
    expect(text).toContain("the forge");
  });
});

describe("a hold, as it is kept", () => {
  let f: Awaited<ReturnType<typeof forge>>;
  let app: App;
  let alice: User;
  let bob: User;
  let pull: Pull;
  let other: Pull;

  beforeAll(async () => {
    f = await forge("forge-holds-core-", "private");
    app = f.app;
    alice = f.alice;
    bob = await f.person("bob");
    pull = await f.pullOn("one");
    other = await f.pullOn("two");
  }, 30_000);

  afterAll(() => f.close());

  test("the reason is one plain line, and there must be one", () => {
    expect(cleanWhy("  a second review\n is under way ")).toEqual({
      ok: true,
      value: "a second review is under way",
    });
    expect(cleanWhy(" \n ")).toEqual({ ok: false, error: "empty_why" });
    expect(cleanWhy("x".repeat(WHY_MAX)).ok).toBe(true);
    expect(cleanWhy("x".repeat(WHY_MAX + 1))).toEqual({
      ok: false,
      error: "why_too_long",
    });
  });

  test("a pull holds one hold, with who and why; a second replaces the words and keeps the time", () => {
    expect(getHold(app.db, pull.id)).toBeUndefined();
    const first = setHold(app.db, pull.id, alice.id, "second review under way");
    expect([first.heldByName, first.why]).toEqual([
      "alice",
      "second review under way",
    ]);
    const second = setHold(app.db, pull.id, bob.id, "waiting for the release");
    expect([second.heldByName, second.why, second.heldAt]).toEqual([
      "bob",
      "waiting for the release",
      first.heldAt,
    ]);
    const rows = app.db
      .query("SELECT count(*) AS n FROM pull_hold WHERE issue_id = ?1")
      .get(pull.id) as { n: number };
    expect(rows.n).toBe(1);
    expect([...holdsFor(app.db, [pull.id, other.id]).keys()]).toEqual([
      pull.id,
    ]);
  });

  test("a release is kept: nothing stands, and the pull remembers when it was let go", () => {
    expect(lastRelease(app.db, other.id)).toBeUndefined();
    expect(releaseHold(app.db, other.id, alice.id)).toBe(false);
    expect(releaseHold(app.db, pull.id, alice.id)).toBe(true);
    expect(getHold(app.db, pull.id)).toBeUndefined();
    expect(holdsFor(app.db, [pull.id]).size).toBe(0);
    const released = lastRelease(app.db, pull.id);
    expect(Date.parse(released ?? "")).toBeGreaterThan(Date.now() - 60_000);
    // Held again, it is a new hold; the earlier one is history.
    setHold(app.db, pull.id, alice.id, "once more");
    expect(getHold(app.db, pull.id)?.why).toBe("once more");
    expect(lastRelease(app.db, pull.id)).toBe(released);
  });
});

describe("a hold set until green", () => {
  let f: Awaited<ReturnType<typeof forge>>;
  let app: App;

  beforeAll(async () => {
    f = await forge("forge-holds-green-", "private");
    app = f.app;
  }, 30_000);

  afterAll(() => f.close());

  /** A finished check on the pull's head, as the verdict leaves it. */
  const verdict = (pull: Pull, state: "ok" | "failed", oid = pull.headOid) => {
    const check = createRun(app.db, {
      repoId: f.repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: oid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    return finishRun(app.db, check.id, { state, summary: state })!;
  };
  const notes = (pull: Pull) =>
    (
      app.db
        .query("SELECT payload FROM event WHERE kind = 'pull.released'")
        .all() as { payload: string }[]
    )
      .map((r) => JSON.parse(r.payload))
      .filter((p) => p.number === pull.number)
      .map((p) => p.note);

  test("a green check on the head releases it, with one line saying so", async () => {
    const pull = await f.pullOn("green-one");
    const held = setHold(app.db, pull.id, f.alice.id, "red alone", "green");
    expect(held.until).toBe("green");
    expect(releaseOnGreen(app, verdict(pull, "failed"))).toBe(false);
    expect(getHold(app.db, pull.id)).toBeDefined();
    expect(releaseOnGreen(app, verdict(pull, "ok", "0".repeat(40)))).toBe(false);
    expect(getHold(app.db, pull.id)).toBeDefined();
    expect(releaseOnGreen(app, verdict(pull, "ok"))).toBe(true);
    expect(getHold(app.db, pull.id)).toBeUndefined();
    expect(lastRelease(app.db, pull.id)).toBeDefined();
    expect(notes(pull)).toEqual([
      `hold released: green on ${pull.headOid.slice(0, 7)}`,
    ]);
  });

  test("a plain hold stays through a green check", async () => {
    const pull = await f.pullOn("green-two");
    setHold(app.db, pull.id, f.alice.id, "waiting");
    expect(getHold(app.db, pull.id)?.until).toBeUndefined();
    expect(releaseOnGreen(app, verdict(pull, "ok"))).toBe(false);
    expect(getHold(app.db, pull.id)?.why).toBe("waiting");
    expect(notes(pull)).toEqual([]);
  });

  test("holding a held pull again sets whether it waits for green", async () => {
    const pull = await f.pullOn("green-three");
    setHold(app.db, pull.id, f.alice.id, "waiting", "green");
    expect(setHold(app.db, pull.id, f.alice.id, "waiting").until).toBeUndefined();
    expect(releaseOnGreen(app, verdict(pull, "ok"))).toBe(false);
  });

  test("holdPull takes until: green", async () => {
    const pull = await f.pullOn("green-four");
    const held = holdPull(app, f.alice, f.repo, pull, "red alone", false, "green");
    expect(held.ok && held.value.until).toBe("green");
    expect(releaseOnGreen(app, verdict(pull, "ok"))).toBe(true);
  });
});

describe("a crew hold that outlives its reason expires", () => {
  const HOUR = 3_600_000;
  async function setup() {
    const f = await forge("forge-holds-expire-", "private");
    const agent = await createAgent(f.app, f.alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(f.app, f.alice, f.repo, "mason").ok).toBe(true);
    const mason = getUserByName(f.app.db, "mason")!;
    /** A pull mason built, held by `by` since `hours` ago. */
    const held = async (branch: string, by: User, hours: number) => {
      const pull = await f.pullOn(branch);
      f.app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, mason.id);
      setHold(f.app.db, pull.id, by.id, "waiting on the vault key", undefined);
      f.app.db
        .query("UPDATE pull_hold SET held_at = ?2 WHERE issue_id = ?1")
        .run(pull.id, new Date(Date.now() - hours * HOUR).toISOString());
      return pull;
    };
    return { ...f, mason, held };
  }

  test("a 25 h crew hold is released with a note naming the reason, and the pull goes back to its builder", async () => {
    const f = await setup();
    const pull = await f.held("old", f.mason, 25);
    expect(expireCrewHolds(f.app)).toBe(1);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    const issue = getIssueById(f.app.db, pull.id)!;
    expect(issue.assigneeId).toBe(f.mason.id);
    const said = listComments(f.app.db, pull.id).map((c) => c.body);
    expect(said).toContain("Hold expired after 24 h: waiting on the vault key. Back to @mason.");
    expect(expireCrewHolds(f.app)).toBe(0);
    await f.close();
  });

  test("a 25 h crew hold on a closed pull is released with no comment and no hand-back", async () => {
    const f = await setup();
    const pull = await f.held("closed", f.mason, 25);
    f.app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
    const before = getIssueById(f.app.db, pull.id)!.assigneeId;
    expect(expireCrewHolds(f.app)).toBe(1);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(listComments(f.app.db, pull.id)).toHaveLength(0);
    expect(getIssueById(f.app.db, pull.id)!.assigneeId).toBe(before);
    await f.close();
  });

  test("a 25 h crew hold on a pull a person authored is released with a note that has no 'Back to'", async () => {
    const f = await setup();
    const pull = await f.held("person-built", f.mason, 25);
    f.app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, f.alice.id);
    const before = getIssueById(f.app.db, pull.id)!.assigneeId;
    expect(expireCrewHolds(f.app)).toBe(1);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(listComments(f.app.db, pull.id).map((c) => c.body)).toEqual([
      "Hold expired after 24 h: waiting on the vault key.",
    ]);
    expect(getIssueById(f.app.db, pull.id)!.assigneeId).toBe(before);
    expect(before).not.toBe(f.mason.id);
    await f.close();
  });

  test("when the holder has left the crew the note is still posted, by the builder", async () => {
    const f = await setup();
    const quill = await createAgent(f.app, f.alice, { username: "quill" });
    if (!quill.ok) throw new Error(String(quill.error));
    expect(addToCrew(f.app, f.alice, f.repo, "quill").ok).toBe(true);
    const pull = await f.held("left", getUserByName(f.app.db, "quill")!, 25);
    expect(removeFromCrew(f.app, f.alice, f.repo, "quill").ok).toBe(true);
    expect(expireCrewHolds(f.app)).toBe(1);
    const comments = listComments(f.app.db, pull.id);
    expect(comments.map((c) => c.body)).toEqual([
      "Hold expired after 24 h: waiting on the vault key. Back to @mason.",
    ]);
    expect(comments[0]!.authorId).toBe(f.mason.id);
    await f.close();
  });

  test("when nobody can post the note the hold is still released and the loss is logged", async () => {
    const f = await setup();
    const quill = await createAgent(f.app, f.alice, { username: "quill" });
    if (!quill.ok) throw new Error(String(quill.error));
    expect(addToCrew(f.app, f.alice, f.repo, "quill").ok).toBe(true);
    const pull = await f.held("lost", getUserByName(f.app.db, "quill")!, 25);
    f.app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, f.alice.id);
    expect(removeFromCrew(f.app, f.alice, f.repo, "quill").ok).toBe(true);
    const warn = spyOn(f.app.log, "warn").mockImplementation(() => {});
    expect(expireCrewHolds(f.app)).toBe(1);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(listComments(f.app.db, pull.id)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("hold expiry note not posted", expect.objectContaining({ pull: pull.number }));
    await f.close();
  });

  test("a 23 h crew hold stays", async () => {
    const f = await setup();
    const pull = await f.held("young", f.mason, 23);
    expect(expireCrewHolds(f.app)).toBe(0);
    expect(getHold(f.app.db, pull.id)).toBeDefined();
    expect(listComments(f.app.db, pull.id)).toHaveLength(0);
    await f.close();
  });

  test("a person's hold never expires", async () => {
    const f = await setup();
    const pull = await f.held("person", f.alice, 500);
    expect(expireCrewHolds(f.app)).toBe(0);
    expect(getHold(f.app.db, pull.id)).toBeDefined();
    await f.close();
  });
});

describe("an until-green hold, through the checks service", () => {
  let f: Awaited<ReturnType<typeof forge>>;
  let servers: Servers;
  let checks: ReturnType<typeof startChecks>;

  beforeAll(async () => {
    f = await forge("forge-holds-service-", "private");
    servers = await serve(f.app);
    checks = startChecks(f.app, { forgeUrl: servers.url, concurrency: 1 });
    const declared = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Declare a check",
      files: [
        {
          path: "forge.json",
          content: '{"check": {"run": "true", "install": ""}}\n',
        },
      ],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
  }, 30_000);

  afterAll(async () => {
    await checks.stop();
    servers.stop();
    await f.close();
  });

  const notes = (pull: Pull) =>
    (
      f.app.db
        .query("SELECT payload FROM event WHERE kind = 'pull.released'")
        .all() as { payload: string }[]
    )
      .map((r) => JSON.parse(r.payload))
      .filter((p) => p.number === pull.number)
      .map((p) => p.note);

  test("a passing check run by the service releases the hold", async () => {
    const pull = await f.pullOn("svc-one");
    setHold(f.app.db, pull.id, f.alice.id, "red alone", "green");
    const run = await checks.request(f.repo, `pull-${pull.number}`, pull.headOid, "pull", pull.id);
    expect(run).toBeDefined();
    const deadline = Date.now() + 30_000;
    while (getHold(f.app.db, pull.id) && Date.now() < deadline) await Bun.sleep(50);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(notes(pull)).toEqual([
      `hold released: green on ${pull.headOid.slice(0, 7)}`,
    ]);
  }, 60_000);

  test("holding a head that is already green releases at once", async () => {
    const pull = f.passCheck(await f.pullOn("svc-two"));
    const held = holdPull(f.app, f.alice, f.repo, pull, "red alone", false, "green");
    expect(held.ok).toBe(true);
    expect(getHold(f.app.db, pull.id)).toBeUndefined();
    expect(notes(pull)).toEqual([
      `hold released: green on ${pull.headOid.slice(0, 7)}`,
    ]);
    // A plain hold on a green head stays; so does one on a head with no green.
    const plain = f.passCheck(await f.pullOn("svc-three"));
    holdPull(f.app, f.alice, f.repo, plain, "waiting");
    expect(getHold(f.app.db, plain.id)).toBeDefined();
    const bare = await f.pullOn("svc-four");
    holdPull(f.app, f.alice, f.repo, bare, "red alone", false, "green");
    expect(getHold(f.app.db, bare.id)).toBeDefined();
  });
});
