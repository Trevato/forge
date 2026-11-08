/**
 * The decider: fixed-choice questions, a rule that always answers, and a
 * decider that may answer better — or late, or wrong, or not at all — in
 * which case the rule's answer stands and the caller never knows the
 * difference except by `by`.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listCrewRoles } from "../src/core/agents.ts";
import { getIssueById } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import {
  certain,
  decideOr,
  typeSafeAnswers,
  typeSafeDecider,
  typeSafeRequest,
  type Decider,
} from "../src/crew/decide.ts";
import { kindByWords, routeIssue, sizeByWords } from "../src/crew/route.ts";

const Q = {
  builder: { options: ["mason", "scout"], about: "who" },
  size: { options: ["tiny", "small", "large"] },
} as const;

describe("decideOr", () => {
  const rule = () => ({
    builder: certain(Q.builder.options, "mason"),
    size: certain(Q.size.options, "small"),
  });

  test("with no decider the rule answers, instantly", async () => {
    const d = await decideOr(undefined, "state", Q, rule);
    expect(d.by).toBe("rule");
    expect(d.answers.builder.choice).toBe("mason");
    expect(d.answers.size.p).toBe(1);
  });

  test("a decider's answer within the options is taken, with its probabilities", async () => {
    const jev: Decider = {
      name: "fake",
      async decide() {
        return {
          builder: {
            choice: "scout",
            p: 0.8,
            probabilities: { mason: 0.2, scout: 0.8 },
          },
          size: {
            choice: "tiny",
            p: 0.6,
            probabilities: { tiny: 0.6, small: 0.3, large: 0.1 },
          },
        } as never;
      },
    };
    const d = await decideOr(jev, "state", Q, rule);
    expect(d.by).toBe("fake");
    expect(d.answers.builder.choice).toBe("scout");
    expect(d.answers.size.probabilities.small).toBe(0.3);
  });

  test("an answer outside the options, an error, or a slow reply leaves the rule's answer", async () => {
    const outside: Decider = {
      name: "outside",
      async decide() {
        return {
          builder: { choice: "nobody", p: 1, probabilities: { nobody: 1 } },
          size: { choice: "tiny", p: 1, probabilities: { tiny: 1 } },
        } as never;
      },
    };
    expect((await decideOr(outside, "s", Q, rule)).by).toBe("rule");
    const broken: Decider = {
      name: "broken",
      async decide() {
        throw new Error("boom");
      },
    };
    expect((await decideOr(broken, "s", Q, rule)).by).toBe("rule");
    const slow: Decider = {
      name: "slow",
      decide(_s, _q, signal) {
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    };
    const started = Date.now();
    const d = await decideOr(slow, "s", Q, rule, 80);
    expect(d.by).toBe("rule");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("TypeSafe over the wire", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: { headers: Record<string, string>; body: unknown } | undefined;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json();
        seen = { headers: Object.fromEntries(request.headers.entries()), body };
        if (new URL(request.url).pathname !== "/v1/systemone")
          return new Response("nope", { status: 404 });
        return Response.json({
          model: "jev-1.13.0",
          answers: {
            builder: {
              type: "choice",
              choice: "scout",
              confidence: 0.8,
              probabilities: { mason: 0.15, scout: 0.85 },
            },
            // `large` unsaid, and a choice named that we never offered.
            size: {
              type: "choice",
              choice: "huge",
              confidence: 0.5,
              probabilities: { tiny: 0.7, small: 0.2, huge: 0.1 },
            },
          },
          usage: { input_tokens: 42, output_tokens: 6 },
        });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("the request is TypeSafe's: the key, the state, choice questions with criteria; the answer is read per option", async () => {
    const jev = typeSafeDecider({
      apiKey: "apik_test_only",
      url: `http://127.0.0.1:${server.port}`,
      model: "jev",
    });
    const rule = () => ({
      builder: certain(Q.builder.options, "mason"),
      size: certain(Q.size.options, "small"),
    });
    const d = await decideOr(jev, { told: "the state" }, Q, rule);
    expect(d.by).toBe("typesafe");
    expect(seen?.headers["authorization"]).toBe("Bearer apik_test_only");
    expect(seen?.body).toEqual(
      typeSafeRequest({ told: "the state" }, Q, "jev"),
    );
    const sent = seen?.body as {
      model: string;
      state: unknown;
      questions: {
        builder: {
          type: string;
          instructions: string;
          criteria: Record<string, unknown>;
        };
        size: { criteria: Record<string, unknown> };
      };
    };
    expect(sent.model).toBe("jev");
    expect(sent.state).toEqual({ told: "the state" });
    expect(sent.questions.builder.type).toBe("choice");
    expect(sent.questions.builder.instructions).toBe("who");
    expect(Object.keys(sent.questions.builder.criteria)).toEqual([
      "mason",
      "scout",
    ]);
    expect(sent.questions.size.criteria).toEqual({
      tiny: null,
      small: null,
      large: null,
    });
    expect(d.answers.builder.choice).toBe("scout");
    expect(d.answers.builder.p).toBe(0.85);
    // The choice the model named was not one of ours: the best of ours wins,
    // and `large`, unsaid, is 0.
    expect(d.answers.size.choice).toBe("tiny");
    expect(d.answers.size.probabilities.large).toBe(0);
  });

  test("described options travel as criteria; an empty answer is the first option at 0", () => {
    const request = typeSafeRequest(
      "s",
      { size: { options: ["tiny", "large"], describe: { tiny: "one line" } } },
      undefined,
    ) as { model: string; questions: { size: { criteria: unknown } } };
    expect(request.model).toBe("jev-latest");
    expect(request.questions.size.criteria).toEqual({
      tiny: "one line",
      large: null,
    });
    const a = typeSafeAnswers(
      {
        answers: {
          builder: {
            type: "choice",
            choice: "mason",
            confidence: 0.9,
            probabilities: { mason: 0.1, scout: 0.9 },
          },
        },
      },
      { builder: Q.builder },
    );
    expect(a.builder.choice).toBe("scout");
    const c = typeSafeAnswers({ answers: {} }, { builder: Q.builder });
    expect(c.builder.choice).toBe("mason");
    expect(c.builder.p).toBe(0);
  });
});

describe("routing an issue", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let scout: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-route-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    for (const [name, brief] of [
      ["mason", "I maintain: I make what works robust."],
      ["scout", "I ship small things fast."],
      ["atlas", "I plan, I do not build."],
    ] as const) {
      const agent = await createAgent(app, alice, { username: name, brief });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    scout = getUserByName(app.db, "scout")!;
    seatAs(app.db, repo.id, getUserByName(app.db, "atlas")!.id, "planner");
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the rules size and sort a sentence, and pick the freest builder by name", async () => {
    expect(sizeByWords("Fix the typo")).toBe("tiny");
    expect(sizeByWords("a ".repeat(30))).toBe("small");
    expect(kindByWords("The search box is broken on mobile")).toBe("bug");
    expect(kindByWords("Rename the old module")).toBe("chore");
    expect(kindByWords("Why does it reload?")).toBe("question");
    expect(kindByWords("Add dark mode")).toBe("feature");
    const issue = openIssue(app, alice, repo, { title: "Add dark mode" });
    if (!issue.ok) throw new Error(String(issue.error));
    const routed = await routeIssue(
      app,
      repo,
      issue.value,
      listCrewRoles(app.db, repo.id),
      new Map(),
    );
    expect(routed?.builder.user.username).toBe("mason");
    expect(routed?.by).toBe("rule");
    expect(routed?.size).toBe("tiny");
    expect(routed?.kind).toBe("feature");
  });

  test("a decider picks among the builders only, sees the crew's briefs, and never overrides an assignment", async () => {
    const asked: string[] = [];
    const jev: Decider = {
      name: "fake",
      async decide(state, questions) {
        asked.push(JSON.stringify(state));
        const names = questions["builder"]!.options;
        expect(names).toEqual(["mason", "scout"]);
        expect(questions["builder"]!.describe?.["scout"]).toContain(
          "small things",
        );
        return {
          builder: {
            choice: "scout",
            p: 0.9,
            probabilities: { mason: 0.1, scout: 0.9 },
          },
          size: {
            choice: "large",
            p: 0.5,
            probabilities: { tiny: 0.2, small: 0.3, large: 0.5 },
          },
          kind: {
            choice: "feature",
            p: 0.8,
            probabilities: {
              bug: 0.1,
              feature: 0.8,
              question: 0.05,
              chore: 0.05,
            },
          },
        } as never;
      },
    };
    const withJev = createApp({ dataDir, port: 0, decider: jev });
    const issue = openIssue(withJev, alice, repo, {
      title: "Ship a quick banner",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    const routed = await routeIssue(
      withJev,
      repo,
      issue.value,
      listCrewRoles(withJev.db, repo.id),
      new Map(),
    );
    expect(routed?.builder.user.username).toBe("scout");
    expect(routed?.by).toBe("fake");
    expect(routed?.size).toBe("large");
    expect(asked[0]).toContain("I plan, I do not build");
    expect(asked[0]).toContain("Ship a quick banner");
    // Assigned to a builder already: the rule keeps it; the decider is not asked.
    withJev.db
      .query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1")
      .run(issue.value.id, scout.id);
    const kept = await routeIssue(
      withJev,
      repo,
      getIssueById(withJev.db, issue.value.id)!,
      listCrewRoles(withJev.db, repo.id),
      new Map(),
    );
    expect(kept?.builder.user.username).toBe("scout");
    expect(kept?.by).toBe("rule");
    expect(asked).toHaveLength(1);
    // The preference is a ranking: with scout busy and mason idle, mason
    // takes it; with both busy, the favourite does (#7006).
    const next = openIssue(withJev, alice, repo, { title: "Ship another banner" });
    if (!next.ok) throw new Error(String(next.error));
    const crew = listCrewRoles(withJev.db, repo.id);
    const mason = getUserByName(withJev.db, "mason")!;
    const busy = await routeIssue(withJev, repo, next.value, crew, new Map([[scout.id, 1]]));
    expect(busy?.builder.user.username).toBe("mason");
    expect(busy?.p).toBe(0.1);
    const allBusy = await routeIssue(withJev, repo, next.value, crew, new Map([[scout.id, 1], [mason.id, 1]]));
    expect(allBusy?.builder.user.username).toBe("scout");
    withJev.close();
  });
});
