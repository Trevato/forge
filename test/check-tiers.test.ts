import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { askCheck } from "../src/checks/again.ts";
import { failuresOf } from "../src/checks/failures.ts";
import { addLearned, readLearned } from "../src/checks/learned.ts";
import { gateOnLand } from "../src/checks/landing.ts";
import { repoDir } from "../src/git/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  duration,
  fastSet,
  importsOf,
  landVerdict,
  tierLine,
} from "../src/checks/tiers.ts";
import { parseCheck } from "../src/apps/manifest.ts";

const tests = [
  "test/snapshot-store.test.ts",
  "test/snapshot.test.ts",
  "test/web-phone.test.ts",
  "test/deep.test.ts",
  "test/tiny.test.ts",
];
const times = new Map([
  ["test/snapshot-store.test.ts", 30],
  ["test/snapshot.test.ts", 30],
  ["test/web-phone.test.ts", 90],
  ["test/deep.test.ts", 20],
  ["test/tiny.test.ts", 0.2],
]);
const graph: Record<string, string[]> = {
  "test/snapshot.test.ts": ["src/snapshot/service.ts"],
  "src/snapshot/service.ts": ["src/snapshot/store.ts"],
  "test/deep.test.ts": ["src/a.ts"],
  "src/a.ts": ["src/b.ts"],
  "src/b.ts": ["src/c.ts"],
  "src/c.ts": ["src/d.ts"],
};
const imports = (file: string): string[] => graph[file] ?? [];

describe("the fast set", () => {
  const plan = fastSet({
    changed: ["src/snapshot/store.ts"],
    tests,
    imports,
    times,
  });

  test("a diff touching src/snapshot/store.ts runs the snapshot tests, not web-phone", () => {
    expect(plan.files).toContain("test/snapshot-store.test.ts");
    expect(plan.files).toContain("test/snapshot.test.ts");
    expect(plan.files).not.toContain("test/web-phone.test.ts");
  });

  test("a quick test always runs, and each file says why", () => {
    expect(plan.files).toContain("test/tiny.test.ts");
    expect(plan.why.get("test/snapshot-store.test.ts")).toContain("named for");
    expect(plan.why.get("test/tiny.test.ts")).toBe("quick");
  });

  test("the import graph stops after two hops", () => {
    const far = fastSet({ changed: ["src/d.ts"], tests, imports, times });
    expect(far.files).not.toContain("test/deep.test.ts");
    const near = fastSet({ changed: ["src/c.ts"], tests, imports, times });
    expect(near.files).toContain("test/deep.test.ts");
  });

  test("a changed test, and a learned test run; an unknown one does not", () => {
    const more = fastSet({
      changed: ["test/web-phone.test.ts"],
      tests: [...tests, "test/new.test.ts"],
      imports,
      times,
      learned: ["test/deep.test.ts"],
    });
    expect(more.files).toContain("test/web-phone.test.ts");
    expect(more.files).toContain("test/deep.test.ts");
    expect(more.files).not.toContain("test/new.test.ts");
  });

  test("a plan over five minutes says so", () => {
    const slow = fastSet({
      changed: ["test/web-phone.test.ts"],
      tests,
      imports,
      times: new Map([["test/web-phone.test.ts", 400]]),
    });
    expect(slow.overBudget).toBe(true);
    expect(plan.overBudget).toBe(false);
  });
});

describe("importsOf", () => {
  test("resolves relative specifiers and leaves packages out", () => {
    const source = `import { a } from "../src/snapshot/store.ts";\nimport x from "node:fs";\nconst m = await import("./helper.ts");`;
    expect(importsOf(source, "test/x.test.ts")).toEqual([
      "src/snapshot/store.ts",
      "test/helper.ts",
    ]);
  });
});

describe("the checks line", () => {
  test("words", () => {
    expect(tierLine("green", 220)).toBe(
      "fast tier: green in 3m40s · full gate runs on land",
    );
    expect(tierLine("running")).toBe(
      "fast tier: running · full gate runs on land",
    );
    expect(tierLine("red", 45)).toBe("fast tier: red in 45s");
    expect(duration(60)).toBe("1m00s");
  });
});

describe("the full gate on land", () => {
  test("green lands", () => {
    expect(landVerdict(true, [])).toEqual({ lands: true });
  });

  test("red reopens the pull, names the tests, and teaches their files", () => {
    const verdict = landVerdict(
      false,
      ["snapshot > restores", "web > phone"],
      ["test/snapshot.test.ts", "test/snapshot.test.ts"],
    );
    if (verdict.lands) throw new Error("a red gate landed");
    expect(verdict.reopen).toBe(true);
    expect(verdict.comment).toContain("- snapshot > restores");
    expect(verdict.comment).toContain("- web > phone");
    expect(verdict.learn).toEqual(["test/snapshot.test.ts"]);
  });

  test("red with no test named still reopens", () => {
    const verdict = landVerdict(false, []);
    expect(verdict.lands).toBe(false);
  });
});

describe("forge.json", () => {
  test("check declares fast and full", () => {
    const parsed = parseCheck(
      JSON.stringify({ check: { run: "a", fast: "b", full: "c" } }),
      undefined,
    );
    if (!parsed.ok || parsed.value === undefined) throw new Error("refused");
    expect(parsed.value.fast).toBe("b");
    expect(parsed.value.full).toBe("c");
    const plain = parseCheck(JSON.stringify({ check: { run: "a" } }), undefined);
    if (!plain.ok || plain.value === undefined) throw new Error("refused");
    expect(plain.value.fast).toBeNull();
    expect(plain.value.full).toBe("a");
  });
});

describe("the tiers in the forge's own checks service", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let alice: User;
  let repo: Repo;

  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    // The tiers are not about the cell; where one cannot open, none is asked.
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-tiers-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "tiered",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    await checks.stop();
    app.close();
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
    await rm(dataDir, { recursive: true, force: true });
  });

  const forgeJson = (full: string): string =>
    JSON.stringify({
      check: {
        run: "echo WHOLE",
        fast:
          'echo "FAST base=$FORGE_CHECK_BASE learned=$FORGE_CHECK_LEARNED"; git diff --name-only "$FORGE_CHECK_BASE"..HEAD',
        full,
      },
    });

  test("a pull's check runs the fast command with the fork point, and land runs the full one", async () => {
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        { path: "forge.json", content: forgeJson("echo FULL-GREEN") },
        { path: "a.txt", content: "a\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branched = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Touch b",
      files: [{ path: "b.txt", content: "b\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    // Main moves on after the fork: the diff is still the pull's own.
    const moved = await commitToBranch(app, alice, repo, {
      message: "Main moves",
      files: [{ path: "c.txt", content: "c\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;

    const deadline = Date.now() + 30_000;
    let run: Run | undefined;
    while (Date.now() < deadline) {
      run = listRuns(app.db, repo.id, { kind: "check", limit: 20 }).find(
        (r) => r.issueId === pull.id && r.commitOid === branched.value.commitOid,
      );
      if (run && (run.state === "ok" || run.state === "failed")) break;
      await Bun.sleep(50);
    }
    expect(run?.state).toBe("ok");
    const log = readRunLog(dataDir, run!.id).lines.join("\n");
    expect(log).toContain(`FAST base=${moved.value.commitOid}`);
    expect(log).toContain(
      `merge of ${branched.value.commitOid.slice(0, 7)} into main@${moved.value.commitOid.slice(0, 7)}`,
    );
    expect(log).not.toContain("WHOLE");
    expect(log).toContain("b.txt");
    expect(log).not.toContain("c.txt");

    const green = await checks.gate(repo, pull, branched.value.commitOid);
    expect(green.ok).toBe(true);
    expect(green.lines.join("\n")).toContain("FULL-GREEN");
  });

  test("a red full gate names its tests and the pull learns the files", async () => {
    const red = await commitToBranch(app, alice, repo, {
      message: "Full goes red",
      files: [
        {
          path: "forge.json",
          content: forgeJson(
            "echo test/x.test.ts:; echo '(fail) boom [1.00ms]'; exit 1",
          ),
        },
      ],
    });
    if (!red.ok) throw new Error(JSON.stringify(red.error));
    const pull = listPulls(app.db, repo.id, { state: "open", limit: 5 })[0]!;
    const done = await checks.gate(repo, pull, red.value.commitOid);
    expect(done.ok).toBe(false);
    const failed = failuresOf(done.lines);
    expect(failed).toEqual({ tests: ["boom"], files: ["test/x.test.ts"] });
    const verdict = landVerdict(false, failed.tests, failed.files);
    if (verdict.lands) throw new Error("expected red");
    expect(verdict.comment).toContain("- boom");
    addLearned(dataDir, pull.id, verdict.learn);
    expect(readLearned(dataDir, pull.id)).toEqual(["test/x.test.ts"]);
    addLearned(dataDir, pull.id, ["../../etc/passwd", "x; rm -rf.test.ts"]);
    expect(readLearned(dataDir, pull.id)).toEqual(["test/x.test.ts"]);
  });

  test("landing runs the full gate on the merge with its base; red is told and taught", async () => {
    const pull0 = listPulls(app.db, repo.id, { state: "open", limit: 5 })[0]!;
    const pushed = await commitToBranch(app, alice, repo, {
      message: "Main goes red on land",
      files: [
        {
          path: "forge.json",
          content: forgeJson(
            "echo test/y.test.ts:; echo '(fail) lands red [1.00ms]'; exit 1",
          ),
        },
      ],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const pull = pull0;
    const base = (await resolveOid(
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      "refs/heads/main",
    ))!;
    const verdict = await gateOnLand(
      app,
      repo,
      pull,
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      base,
    );
    if (verdict.lands) throw new Error("expected the full gate to be red");
    expect(verdict.comment).toContain("- lands red");
    expect(readLearned(dataDir, pull.id)).toContain("test/y.test.ts");
  });

  const finished = async (pullId: string, oid: string): Promise<Run> => {
    const deadline = Date.now() + 30_000;
    let run: Run | undefined;
    while (Date.now() < deadline) {
      run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.issueId === pullId && r.commitOid === oid,
      );
      if (run && (run.state === "ok" || run.state === "failed")) return run;
      await Bun.sleep(50);
    }
    throw new Error("the check did not finish");
  };

  test("the tier comes from the base: a head without check.fast, or editing it, is checked with the base's", async () => {
    const own = (fast: string | undefined): string =>
      JSON.stringify({
        check: { run: "echo HEAD-RUN", ...(fast ? { fast } : {}) },
      });
    const old = await commitToBranch(app, alice, repo, {
      branch: "old",
      message: "Branched before the fast tier",
      files: [{ path: "forge.json", content: own(undefined) }],
    });
    if (!old.ok) throw new Error(JSON.stringify(old.error));
    const weak = await commitToBranch(app, alice, repo, {
      branch: "weak",
      message: "Weakens its own gate",
      files: [{ path: "forge.json", content: own("echo HEAD-FAST") }],
    });
    if (!weak.ok) throw new Error(JSON.stringify(weak.error));
    const main = await commitToBranch(app, alice, repo, {
      message: "Base declares the tier",
      files: [{ path: "forge.json", content: forgeJson("echo FULL") }],
    });
    if (!main.ok) throw new Error(JSON.stringify(main.error));
    for (const [head, oid] of [
      ["old", old.value.commitOid],
      ["weak", weak.value.commitOid],
    ] as const) {
      const opened = await openPull(app, alice, repo, {
        title: head,
        baseBranch: "main",
        headBranch: head,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const run = await finished(opened.value.id, oid);
      expect(run.state).toBe("ok");
      const log = readRunLog(dataDir, run.id).lines.join("\n");
      expect(log).toContain(`tier fast from main@${main.value.commitOid.slice(0, 7)}`);
      expect(log).toContain("FAST base=");
      expect(log).not.toContain("HEAD-");
    }
  });
});

describe("a pull's fast check is of the merge", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let alice: User;
  let repo: Repo;
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-merged-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "merged", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    await checks.stop();
    app.close();
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
    await rm(dataDir, { recursive: true, force: true });
  });

  const commit = async (
    branch: string | undefined,
    files: { path: string; content: string }[],
  ): Promise<string> => {
    const done = await commitToBranch(app, alice, repo, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files,
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    return done.value.commitOid;
  };

  const settled = async (commitOid: string): Promise<Run> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.commitOid === commitOid && r.issueId !== null,
      );
      if (run && (run.state === "ok" || run.state === "failed")) return run;
      await Bun.sleep(50);
    }
    throw new Error("the check did not finish");
  };

  test("a head lacking what the base's fast command needs is green once merged; a conflict is red with its paths", async () => {
    const manifest = JSON.stringify({
      check: { run: "echo WHOLE", fast: "sh needs.sh; git diff --name-only $FORGE_CHECK_BASE..HEAD" },
    });
    await commit(undefined, [
      { path: "forge.json", content: manifest },
      { path: "shared.txt", content: "one\n" },
    ]);
    const fork = await commit("late", [{ path: "late.txt", content: "late\n" }]);
    const conflicting = await commit("clash", [{ path: "shared.txt", content: "mine\n" }]);
    // Main learns what the fast command needs, and moves a file the clash edits.
    await commit(undefined, [
      { path: "needs.sh", content: "echo NEEDS-FOUND\n" },
      { path: "shared.txt", content: "theirs\n" },
    ]);
    for (const [title, branch] of [["Late", "late"], ["Clash", "clash"]] as const) {
      const opened = await openPull(app, alice, repo, {
        title,
        baseBranch: "main",
        headBranch: branch,
      });
      if (!opened.ok) throw new Error(String(opened.error));
    }

    const late = await settled(fork);
    expect(late.state).toBe("ok");
    const log = readRunLog(dataDir, late.id).lines.join("\n");
    expect(log).toContain("NEEDS-FOUND");
    expect(log).toContain("late.txt");
    expect(log).not.toContain("needs.sh\n");

    const clash = await settled(conflicting);
    expect(clash.state).toBe("failed");
    expect(clash.summary).toContain("does not merge into main: shared.txt");
  });

  test("a writer asks for a check again at the current head", async () => {
    const pull = listPulls(app.db, repo.id, { state: "open", limit: 5 }).find(
      (p) => p.headBranch === "late",
    )!;
    const asked = await askCheck(app, alice, repo, pull);
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.run.reason).toBe("asked");
    expect(asked.run.commitOid).toBe(pull.headOid);
  });
});
