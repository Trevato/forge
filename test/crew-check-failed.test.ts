/**
 * The crew with a stand-in Claude Code: a failing check comes back to the agent.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "../src/app.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import {
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: a failing check", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let promptFile: string;

  beforeAll(async () => {
    standIn = await startStandInCrew({ tickMs: 50 });
    ({ app, alice, bot, promptFile } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("a failing check on the agent's pull comes back to it, and it fixes it", async () => {
    const made = await createRepo(app, alice, {
      name: "orchard",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    const orchard = made.value;
    const seeded = await commitToBranch(app, alice, orchard, {
      message: "Start",
      files: [
        { path: "README.md", content: "# orchard\n" },
        {
          path: "forge.json",
          content:
            '{"check": {"run": "grep -q daffodils CREW.md", "install": ""}}\n',
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, orchard, "bot").ok).toBe(true);
    const issue = openIssue(app, alice, orchard, {
      title: "Plant daffodils",
      body: "Along the wall.",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, orchard, issue.value, bot).ok).toBe(true);
    const runs = (kind: "agent" | "check") =>
      listRuns(app.db, orchard.id, { kind, limit: 50 });
    const until = async <T>(
      find: () => T | undefined,
      timeoutMs = 20_000,
    ): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = find();
        if (found !== undefined) return found;
        await Bun.sleep(20);
      }
      throw new Error("did not happen in time");
    };
    const built = await until(() =>
      runs("agent").find((r) => r.reason === "assigned" && r.state === "ok"),
    );
    expect(built.summary).toMatch(/^opened pull #\d+/);
    // The pull's own commit is checked in `pull-<number>`; the initial
    // commit to the default branch (no CREW.md yet) is checked too, in
    // `production`, and fails for its own reason (no such file) — so the
    // pull's check is picked out by its environment, not just "failed".
    const pullNumber = Number(built.summary.match(/#(\d+)/)?.[1]);
    const pullChecks = () =>
      listRuns(app.db, orchard.id, {
        kind: "check",
        env: `pull-${pullNumber}`,
        limit: 50,
      });
    // The forge checks the pull: no daffodils yet.
    const failed = await until(() =>
      pullChecks().find((r) => r.state === "failed"),
    );
    expect(failed.summary).toBe("check failed: check exited with code 1");
    // …and the agent hears about it, with the log, and answers.
    const fixed = await until(() =>
      runs("agent").find(
        (r) => r.reason === "check_failed" && r.state === "ok",
      ),
    );
    expect(fixed.summary).toMatch(/^updated pull #\d+/);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("The check on your pull #");
    expect(prompt).toContain("check exited with code 1");
    expect(prompt).toContain("The end of the check log:");
    const passed = await until(() =>
      pullChecks().find((r) => r.state === "ok"),
    );
    expect(passed.summary).toMatch(/^check passed/);
  }, 15_000);
});
