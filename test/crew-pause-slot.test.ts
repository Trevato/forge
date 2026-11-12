/**
 * A run paused for a limit gives up its slot, says why in the log, keeps the
 * provider's words on its queued task, and shows the time it resumes on its
 * card (#11564). The pause is a real one: the stand-in provider turns the
 * run away with its session limit.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { pauseCause, pausedNote } from "../src/crew/pacing.ts";
import { listRuns } from "../src/core/runs.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("a paused run does not hold the crew's only slot", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  const lines: string[] = [];
  const info = spyOn(console, "info");

  beforeAll(async () => {
    info.mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    standIn = await startStandInCrew({ tickMs: 20 });
    ({ app, alice, bot, repo } = standIn);
  }, 30_000);
  afterAll(async () => {
    info.mockRestore();
    await stopStandInCrew(standIn);
  });

  test("a real pause names its cause, keeps its words, shows its time, and B runs", async () => {
    const a = openIssue(app, alice, repo, {
      title: "Paused work",
      body: "LIMIT-ME: once a day, before noon.",
    });
    const b = openIssue(app, alice, repo, { title: "Review follow-up", body: "Now." });
    if (!a.ok || !b.ok) throw new Error("issues");
    expect(assignIssue(app, alice, repo, a.value, bot).ok).toBe(true);
    const paused = await agentRunSettled(
      app,
      repo,
      (r) => r.issueId === a.value.id && r.attempt === 0,
      20_000,
      20,
    );
    expect(paused.state).toBe("cancelled");

    // The log line names the cause (fails without `cause:` in dispatch.ts).
    const line = lines.find((l) => l.includes("run paused") && l.includes(`run=${paused.id}`));
    expect(line).toBeDefined();
    expect(line).toContain(`cause="rate limit"`);

    // The queued task keeps the provider's words (fails without the
    // `summary` the runner hands back).
    const waiting = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.issueId === a.value.id && r.state === "queued",
    )!;
    expect(waiting).toBeDefined();
    expect(waiting.summary).toBe(paused.summary);
    expect(waiting.summary).toMatch(/^paused: the 5-hour window is full/);

    // With the only slot, B starts while A waits for its limit to lift.
    expect(assignIssue(app, alice, repo, b.value, bot).ok).toBe(true);
    const ran = await agentRunSettled(
      app,
      repo,
      (r) => r.issueId === b.value.id,
      20_000,
      20,
    );
    expect(ran.state).toBe("ok");
    const still = listRuns(app.db, repo.id, { kind: "agent" }).find(
      (r) => r.id === waiting.id,
    )!;
    expect(still.state).toBe("queued");

    // The card says so in plain words, with the time.
    const signin = await fetch(`${standIn.servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: standIn.servers.url,
      },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await (
      await fetch(`${standIn.servers.url}/alice/garden/runs?state=queued`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain(pausedNote(waiting.notBefore!));
  }, 60_000);

  test("the cause is named, by whole words", () => {
    const rate = "paused: the 5-hour window is full until 00:52; resumes 00:52";
    expect(pauseCause(rate)).toBe("rate limit");
    expect(pauseCause("paused: credit balance is too low; resumes 09:00")).toBe("credit");
    expect(pauseCause("paused: network error, resumes 01:00")).toBe("network");
    expect(pauseCause("paused: accurate generated text")).toBe("other");
  });
});
