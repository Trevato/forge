/**
 * The probe as a service: a production deploy is followed by a knock, a
 * mismatch opens one issue and keeps it single, and the first clean probe
 * after closes it. The nightly round is the same knock for every app.
 *
 * The doors are asked by a scripted prober (`startProbes`' `knock` seam):
 * what the running app answers is `probe.test.ts`'s business; here the
 * verdict is whatever the test says, so it is the same every run and in
 * every order. Each test owns its own app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import type { AppsRuntime } from "../src/apps/runtime.ts";
import type { Probed } from "../src/contract/probe.ts";
import {
  PROBE_ISSUE_TITLE,
  latestProbes,
  listProbes,
  probeIssue,
  startProbes,
  untilNightly,
  type ProbesHandle,
} from "../src/contract/probes.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";

const SAID = "note.delete as anon: the table says no, the app said 404";

describe("the probe follows deploys and keeps one issue", () => {
  let dataDir: string;
  let app: App;
  let probes: ProbesHandle;
  let alice: User;
  /** What the doors of each app say, by app id: the test sets it. */
  const answers = new Map<string, "ok" | "mismatch">();

  const until = async (what: () => boolean, ms = 10_000): Promise<void> => {
    const start = Date.now();
    while (!what()) {
      if (Date.now() - start > ms) throw new Error("not in time");
      await Bun.sleep(50);
    }
  };
  const made = async (name: string): Promise<{ repo: Repo; record: AppRecord }> => {
    const out = await newApp(app, alice, { name, visibility: "public" });
    if (!out.ok) throw new Error(String(out.error));
    return { repo: out.value.repo, record: out.value.app };
  };
  /** A production deploy finished green, as the runtime says it. */
  const deployed = (repo: Repo): void => {
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      payload: { kind: "deploy", state: "ok", env: "production" },
    });
  };
  const probesOf = (record: AppRecord) => listProbes(app.db, record.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-probes-"));
    app = createApp({ dataDir, port: 0 });
    // No app ever runs: the prober below answers for its doors.
    const runtime = {} as AppsRuntime;
    probes = startProbes(app, runtime, {
      nightly: false,
      knock: async (input): Promise<Probed> => {
        const verdict = answers.get(input.record.id) ?? "ok";
        return {
          repo: input.repo,
          commitOid: input.repo.id,
          at: new Date().toISOString(),
          verdict,
          knocks: [],
          said: verdict === "mismatch" ? [SAID] : [],
        };
      },
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
  }, 30_000);

  afterAll(async () => {
    await probes.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a production deploy is followed by a knock, and a clean app has no issue", async () => {
    const { repo, record } = await made("clean");
    answers.set(record.id, "ok");
    deployed(repo);
    await until(() => probesOf(record).length >= 1);
    const latest = latestProbes(app.db, [record.id]).get(record.id)!;
    expect(latest.verdict).toBe("ok");
    expect(latest.said).toEqual([]);
    expect(probeIssue(app, repo)).toBeUndefined();
  }, 15_000);

  test("a disobeying deploy opens one issue; a second probe does not double it", async () => {
    const { repo, record } = await made("broken");
    answers.set(record.id, "mismatch");
    deployed(repo);
    await until(() => probesOf(record).length >= 1);
    const latest = latestProbes(app.db, [record.id]).get(record.id)!;
    expect(latest.verdict).toBe("mismatch");
    const issue = probeIssue(app, repo);
    expect(issue).toBeDefined();
    expect(issue!.title).toBe(PROBE_ISSUE_TITLE);
    expect(issue!.body).toContain(SAID);
    expect(issue!.authorId).toBe(alice.id);

    // A round knocks again: still one issue.
    const rows = await probes.round();
    expect(rows.filter((r) => r.appId === record.id).map((r) => r.verdict)).toEqual([
      "mismatch",
    ]);
    expect(
      listIssues(app.db, repo.id, { state: "open", limit: 50 }).filter(
        (i) => i.title === PROBE_ISSUE_TITLE,
      ),
    ).toHaveLength(1);
  }, 15_000);

  test("the first clean probe after closes the issue", async () => {
    const { repo, record } = await made("mended");
    answers.set(record.id, "mismatch");
    await probes.round();
    expect(probeIssue(app, repo)).toBeDefined();

    // The door obeys again, and the deploy that says so is knocked on.
    answers.set(record.id, "ok");
    deployed(repo);
    await until(() => probesOf(record).length >= 2);
    expect(latestProbes(app.db, [record.id]).get(record.id)!.verdict).toBe("ok");
    expect(probeIssue(app, repo)).toBeUndefined();
    const closed = listIssues(app.db, repo.id, { state: "closed", limit: 50 }).find(
      (i) => i.title === PROBE_ISSUE_TITLE,
    );
    expect(closed).toBeDefined();
    // The history is rows, newest first.
    expect(probesOf(record).map((r) => r.verdict)).toEqual(["ok", "mismatch"]);
  }, 15_000);

  test("the nightly round is scheduled for the next 09:00 UTC", () => {
    const at = Date.UTC(2026, 8, 21, 8, 59, 0);
    expect(untilNightly(at)).toBe(60_000);
    const after = Date.UTC(2026, 8, 21, 9, 0, 1);
    expect(untilNightly(after)).toBe(24 * 3_600_000 - 1_000);
  });
});
