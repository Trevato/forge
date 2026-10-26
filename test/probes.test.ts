/**
 * The probe as a service: a production deploy is followed by a knock, a
 * mismatch opens one issue and keeps it single, and the first clean probe
 * after closes it. The nightly round is the same knock for every app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { scaffoldFiles } from "../src/apps/scaffold.ts";
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
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the probe follows deploys and keeps one issue", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let probes: ProbesHandle;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;

  const until = async (what: () => boolean, ms = 90_000): Promise<void> => {
    const start = Date.now();
    while (!what()) {
      if (Date.now() - start > ms) throw new Error("not in time");
      await Bun.sleep(100);
    }
  };
  const deployedAfter = (since: string) =>
    until(() => {
      const run = listRuns(app.db, repo.id, { kind: "deploy", limit: 20 }).find(
        (r) => r.env === "production" && r.createdAt > since,
      );
      return run !== undefined && run.state === "ok";
    });
  const probesSoFar = () => listProbes(app.db, record.id).length;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-probes-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    probes = startProbes(app, runtime, { nightly: false });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await newApp(app, alice, { name: "notes", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
    await deployedAfter("");
  }, 150_000);

  afterAll(async () => {
    await probes.stop();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a production deploy is followed by a knock, and a clean app has no issue", async () => {
    await until(() => probesSoFar() >= 1, 30_000);
    const latest = latestProbes(app.db, [record.id]).get(record.id)!;
    expect(latest.verdict).toBe("ok");
    expect(latest.said).toEqual([]);
    expect(probeIssue(app, repo)).toBeUndefined();
  }, 60_000);

  test("a disobeying deploy opens one issue; a second probe does not double it", async () => {
    const files = new Map(
      scaffoldFiles({ name: "notes", description: "" }).map((f) => [f.path, f.content]),
    );
    const actions = files.get("src/actions.ts") as string;
    const broken = actions.replace(
      'if (permit(who, "note", verb, row) !== "yes")',
      'if (verb !== "delete" && permit(who, "note", verb, row) !== "yes")',
    );
    expect(broken).not.toBe(actions);
    // The door asks the same table before the action does, so the rule is
    // written there too: a hand-written rule has to open both to be heard.
    const door = files.get("src/security.ts") as string;
    const opened = door.replace(
      ": !mayKnock(who, found.resource, found.verb);",
      ': found.verb !== "delete" && !mayKnock(who, found.resource, found.verb);',
    );
    expect(opened).not.toBe(door);
    const before = probesSoFar();
    const since = new Date().toISOString();
    await Bun.sleep(5);
    const wrote = await commitToBranch(app, alice, repo, {
      message: "a hand-written rule, and the tests that knew better",
      files: [
        { path: "src/actions.ts", content: broken },
        { path: "src/security.ts", content: opened },
        { path: "src/contract.test.ts", content: null },
        { path: "src/actions.test.ts", content: null },
        { path: "src/server.test.ts", content: null },
        { path: "src/audit.test.ts", content: null },
      ],
    });
    expect(wrote.ok).toBe(true);
    await deployedAfter(since);
    await until(() => probesSoFar() > before, 30_000);
    const latest = latestProbes(app.db, [record.id]).get(record.id)!;
    expect(latest.verdict).toBe("mismatch");
    const issue = probeIssue(app, repo);
    expect(issue).toBeDefined();
    expect(issue!.title).toBe(PROBE_ISSUE_TITLE);
    expect(issue!.body).toContain("note.delete as anon: the table says no, the app said 404");
    expect(issue!.authorId).toBe(alice.id);

    // A round knocks again: still one issue.
    const rows = await probes.round();
    expect(rows.map((r) => r.verdict)).toEqual(["mismatch"]);
    expect(
      listIssues(app.db, repo.id, { state: "open", limit: 50 }).filter(
        (i) => i.title === PROBE_ISSUE_TITLE,
      ),
    ).toHaveLength(1);
  }, 150_000);

  test("the first clean probe after closes the issue", async () => {
    const files = new Map(
      scaffoldFiles({ name: "notes", description: "" }).map((f) => [f.path, f.content]),
    );
    const before = probesSoFar();
    const since = new Date().toISOString();
    await Bun.sleep(5);
    const wrote = await commitToBranch(app, alice, repo, {
      message: "the door obeys again",
      files: [
        { path: "src/actions.ts", content: files.get("src/actions.ts") as string },
        { path: "src/security.ts", content: files.get("src/security.ts") as string },
        { path: "src/contract.test.ts", content: files.get("src/contract.test.ts") as string },
        { path: "src/actions.test.ts", content: files.get("src/actions.test.ts") as string },
        { path: "src/server.test.ts", content: files.get("src/server.test.ts") as string },
        { path: "src/audit.test.ts", content: files.get("src/audit.test.ts") as string },
      ],
    });
    expect(wrote.ok).toBe(true);
    await deployedAfter(since);
    await until(() => probesSoFar() > before, 30_000);
    expect(latestProbes(app.db, [record.id]).get(record.id)!.verdict).toBe("ok");
    expect(probeIssue(app, repo)).toBeUndefined();
    const closed = listIssues(app.db, repo.id, { state: "closed", limit: 50 }).find(
      (i) => i.title === PROBE_ISSUE_TITLE,
    );
    expect(closed).toBeDefined();
    // The history is rows, newest first.
    expect(listProbes(app.db, record.id).map((r) => r.verdict)).toEqual([
      "ok",
      "mismatch",
      "mismatch",
      "ok",
    ]);
    expect(getRepoById(app.db, repo.id)).toBeDefined();
  }, 150_000);

  test("the nightly round is scheduled for the next 09:00 UTC", () => {
    const at = Date.UTC(2026, 8, 21, 8, 59, 0);
    expect(untilNightly(at)).toBe(60_000);
    const after = Date.UTC(2026, 8, 21, 9, 0, 1);
    expect(untilNightly(after)).toBe(24 * 3_600_000 - 1_000);
  });
});
