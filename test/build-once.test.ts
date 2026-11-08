/**
 * An issue never has two build runs at once: a second assigned dispatch
 * while one runs, or within 10 minutes of its pull opening, is refused (#6574).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { getAgent } from "../src/core/agents.ts";
import type { User } from "../src/core/users.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

let standIn: StandInCrew;
let app: App;
let alice: User;
let bot: User;
let repo: Repo;
let issue: Issue;

beforeAll(async () => {
  standIn = await startStandInCrew();
  ({ app, alice, bot, repo } = standIn);
  const opened = openIssue(app, alice, repo, { title: "Plant tulips", body: "Along the fence." });
  if (!opened.ok) throw new Error("issue not opened");
  issue = opened.value;
  assignIssue(app, alice, repo, issue, bot);
  const run = await agentRunSettled(app, repo, (r) => r.reason === "assigned");
  expect(run.state).toBe("ok");
}, 60_000);

afterAll(() => stopStandInCrew(standIn));

test("a second build dispatch within 10 minutes of the pull opening is refused; later it starts", () => {
  const agent = getAgent(app.db, bot.id)!;
  const fresh = getIssue(app.db, repo.id, issue.number)!;
  const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
  expect(queueAgentRun(app, repo, fresh, agent, "assigned")).toBeUndefined();
  // Other runs are unaffected by the pull's age.
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(old, pull.id);
  const run = queueAgentRun(app, repo, fresh, agent, "assigned");
  expect(run?.state).toBe("queued");
  // And now that one is queued, a third is refused.
  expect(queueAgentRun(app, repo, fresh, agent, "assigned")).toBeUndefined();
});
