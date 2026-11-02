import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { CACHE_KEEP, CHECK_CACHE, keepCache, restoreCache } from "../src/checks/cache.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { askCheck } from "../src/checks/again.ts";
import { failuresOf } from "../src/checks/failures.ts";
import { addLearned, readLearned } from "../src/checks/learned.ts";
import { gateCandidate } from "../src/checks/landing.ts";
import { repoDir } from "../src/git/repos.ts";
import { runGit } from "../src/git/env.ts";
import { mergeable, resolveOid } from "../src/git/merge.ts";
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
import {
  executedFiles,
  formatImpact,
  gateListAdds,
  handedImpact,
  mergeImpact,
  parseImpact,
  reach,
} from "../src/checks/impact.ts";
import { resolveLimits } from "../src/apps/contain.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import { IMPACT_FILE, keepImpact, seedImpact } from "../src/checks/impact-store.ts";

const IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
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

describe("the fast set, by measured coverage", () => {
  const impact = new Map([
    ["test/snapshot-store.test.ts", ["src/snapshot/store.ts"]],
    ["test/snapshot.test.ts", ["src/snapshot/service.ts", "src/snapshot/store.ts"]],
    ["test/web-phone.test.ts", ["src/web/phone.ts"]],
    ["test/deep.test.ts", ["src/a.ts"]],
    ["test/tiny.test.ts", ["src/tiny.ts"]],
  ]);
  const base = { tests: [...tests, "test/new.test.ts"], imports, times, impact };

  test("a diff to one source file picks exactly its tests", () => {
    const plan = fastSet({ ...base, changed: ["src/snapshot/store.ts"] });
    expect(plan.files).toEqual([
      "test/snapshot-store.test.ts",
      "test/snapshot.test.ts",
    ]);
    expect(plan.why.get("test/snapshot.test.ts")).toBe("executes src/snapshot/store.ts");
    expect(plan.line).toBe("by coverage: 1 changed file reaches 2 tests");
  });

  test("a changed file no test executes is said, and judged by the guesses", () => {
    const plan = fastSet({ ...base, changed: ["src/web/phone.ts", "src/web/x.ts"] });
    expect(plan.files).toEqual(["test/web-phone.test.ts", "test/tiny.test.ts"]);
    expect(plan.line).toBe(
      "by coverage and imports: 2 changed files reach 1 test; src/web/x.ts reaches none",
    );
  });

  test("beside an unreached file, a measured test is guessed only against what the map cannot see", () => {
    // store.ts is reached by coverage, x.ts by nothing: only x.ts may bring
    // in a measured test by a guess.
    const imports2 = (file: string): readonly string[] =>
      file === "test/web-phone.test.ts" ? ["src/snapshot/store.ts"] : imports(file);
    const plan = fastSet({
      ...base,
      imports: imports2,
      times: new Map(),
      changed: ["src/snapshot/store.ts", "src/web/x.ts"],
    });
    // web-phone imports store.ts but never executed it: not picked.
    expect(plan.files).toEqual(["test/snapshot-store.test.ts", "test/snapshot.test.ts"]);
    const unseen = fastSet({
      ...base,
      imports: (file) => (file === "test/web-phone.test.ts" ? ["src/web/x.ts"] : imports(file)),
      times: new Map(),
      changed: ["src/snapshot/store.ts", "src/web/x.ts"],
    });
    expect(unseen.why.get("test/web-phone.test.ts")).toBe("imports src/web/x.ts");
  });

  test("an unreached source file is found by the name guess, not left to run nothing", () => {
    const plan = fastSet({ ...base, changed: ["src/snapshot/extra.ts"], tests: [...tests, "test/snapshot-extra.test.ts"] });
    expect(plan.files).toContain("test/snapshot-extra.test.ts");
    expect(plan.why.get("test/snapshot-extra.test.ts")).toBe("named for src/snapshot/extra.ts");
  });

  test("a non-src file the map cannot see turns the guesses on", () => {
    const plan = fastSet({
      ...base,
      changed: ["static/app.js"],
      imports: (file) => (file === "test/deep.test.ts" ? ["static/app.js"] : imports(file)),
    });
    expect(plan.files).toContain("test/deep.test.ts");
  });

  test("a test the map has never seen is picked by the hop rule", () => {
    const hop = fastSet({
      ...base,
      changed: ["src/c.ts"],
      imports: (file) => (file === "test/new.test.ts" ? ["src/a.ts"] : imports(file)),
    });
    expect(hop.files).toContain("test/new.test.ts");
    expect(hop.why.get("test/new.test.ts")).toBe("imports src/c.ts");
  });

  test("a kernel, manifest or scripts change runs full", () => {
    for (const file of ["src/kernel/db.ts", "forge.json", "package.json", "scripts/gate.ts"]) {
      const plan = fastSet({ ...base, changed: [file] });
      expect(plan.files).toEqual(base.tests);
      expect(plan.line).toContain("full tier");
    }
    expect(fastSet({ ...base, changed: ["scripts/test-times.json"] }).files).toEqual([]);
  });

  test("a gate.ts diff that only edits EXCLUDED selects the tests it admits; logic runs full", () => {
    const listed = [
      "@@ -10,2 +10,0 @@",
      '-  { file: "test/new.test.ts", reason: "slow", issue: 5 },',
      "-  {",
      '-    file: "test/other.test.ts",',
      '-    reason: "flaky",',
      "-    issue: 6,",
      "-  },",
      "@@ -20,0 +18,2 @@",
      '+  { file: "test/old.test.ts", reason: "flaky", issue: 7 },',
      '+  { file: "test/other.test.ts", reason: "moved", issue: 6 },',
    ].join("\n");
    const adds = gateListAdds(listed);
    // Quarantining old selects nothing; other only moved, so it stays out.
    expect(adds).toEqual(["test/new.test.ts"]);
    const plan = fastSet({ ...base, changed: ["scripts/gate.ts"], gateAdds: adds! });
    expect(plan.line).not.toContain("full tier");
    expect(plan.files).not.toContain("test/web-phone.test.ts");
    expect(plan.files.length).toBeLessThan(base.tests.length);
    const more = fastSet({
      ...base,
      tests: [...base.tests, "test/new.test.ts"],
      changed: ["scripts/gate.ts"],
      gateAdds: adds!,
    });
    expect(more.why.get("test/new.test.ts")).toBe("changed");
    const hunk = "@@ -1,2 +1,0 @@\n";
    const entry = '-  { file: "test/a.test.ts", reason: "slow", issue: 1 },';
    expect(gateListAdds(`${hunk}${entry}\n+export const X = 1;`)).toBeUndefined();
    expect(gateListAdds("@@ -1 +1 @@\n-  if (x) return;")).toBeUndefined();
    // A bare name is no list entry now: there is no GATE to put it in.
    expect(gateListAdds('@@ -1 +1 @@\n+  "test/a.test.ts",')).toBeUndefined();
    expect(gateListAdds(`${hunk}${entry}\n+++i;`)).toBeUndefined();
    expect(gateListAdds(`${hunk}${entry}\n---n;`)).toBeUndefined();
    expect(gateListAdds(`--- a/scripts/gate.ts\n+++ b/scripts/gate.ts\n${hunk}${entry}`)).toEqual(["test/a.test.ts"]);
    const logic = fastSet({ ...base, changed: ["scripts/gate.ts"] });
    expect(logic.files).toEqual(base.tests);
  });

  test("lcov: only src files with a line hit count as executed", () => {
    const lcov = "SF:src/a.ts\nDA:1,0\nend_of_record\nSF:src/b.ts\nDA:1,3\nend_of_record\nSF:test/x.test.ts\nDA:1,1\nend_of_record\n";
    expect(executedFiles(lcov)).toEqual(["src/b.ts"]);
  });

  test("lcov: where a file has functions, one must be called; loading it is not executing it", () => {
    const lcov = [
      // imported only: its top level ran, none of its three functions did
      "SF:src/loaded.ts\nFNF:3\nFNH:0\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nend_of_record",
      "SF:src/called.ts\nFNF:3\nFNH:1\nDA:1,1\nDA:5,2\nend_of_record",
      // constants only: no functions to call, so a line hit counts
      "SF:src/table.ts\nFNF:0\nFNH:0\nDA:1,1\nend_of_record",
      "SF:src/unloaded.ts\nFNF:0\nFNH:0\nDA:1,0\nend_of_record",
    ].join("\n");
    expect(executedFiles(lcov)).toEqual(["src/called.ts", "src/table.ts"]);
  });
});

describe("the impact map", () => {
  test("parseImpact accepts a map and rejects bad shapes and paths", () => {
    const ok = parseImpact('{"test/a.test.ts":["src/a.ts"]}');
    expect(ok).toEqual({ ok: true, value: new Map([["test/a.test.ts", ["src/a.ts"]]]) });
    for (const bad of [
      "nope",
      "[]",
      "null",
      '{"test/a.test.ts":"src/a.ts"}',
      '{"test/a.test.ts":[1]}',
      '{"test/a.test.ts":["../etc/passwd"]}',
      '{"test/a.test.ts":["scripts/x.ts"]}',
      '{"src/a.ts":["src/a.ts"]}',
      '{"test/../a.test.ts":[]}',
    ])
      expect(parseImpact(bad).ok).toBe(false);
  });

  test("formatImpact sorts and round-trips", () => {
    const map = new Map([
      ["test/b.test.ts", ["src/z.ts", "src/a.ts"]],
      ["test/a.test.ts", ["src/a.ts"]],
    ]);
    const text = formatImpact(map);
    expect(text.indexOf("test/a.test.ts")).toBeLessThan(text.indexOf("test/b.test.ts"));
    expect(text).toContain('["src/a.ts","src/z.ts"]');
    const back = parseImpact(text);
    if (!back.ok) throw new Error(back.error);
    expect(formatImpact(back.value)).toBe(text);
    expect(formatImpact(new Map())).toBe("{}\n");
  });

  test("reach names the first file that meets the diff and the unreached", () => {
    const map = new Map([["test/a.test.ts", ["src/a.ts", "src/b.ts"]]]);
    const got = reach(["src/b.ts", "src/c.ts", "README.md"], map);
    expect(got.tests).toEqual(new Map([["test/a.test.ts", "src/b.ts"]]));
    expect(got.unreached).toEqual(["src/c.ts"]);
  });

  test("mergeImpact refreshes what was measured and drops tests that left the gate", () => {
    const old = new Map([
      ["test/a.test.ts", ["src/old.ts"]],
      ["test/b.test.ts", ["src/b.ts"]],
      ["test/gone.test.ts", ["src/g.ts"]],
    ]);
    const measured = new Map([
      ["test/a.test.ts", ["src/new.ts"]],
      ["test/c.test.ts", ["src/c.ts"]],
    ]);
    const merged = mergeImpact(old, measured, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
    expect(merged).toEqual(
      new Map([
        ["test/a.test.ts", ["src/new.ts"]],
        ["test/b.test.ts", ["src/b.ts"]],
        ["test/c.test.ts", ["src/c.ts"]],
      ]),
    );
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

describe("forge.json: check.fast", () => {
  const parse = (check: string) => parseCheck(`{"check": ${check}}`, undefined);

  test("is trimmed", () => {
    const r = parse('{"run": "a", "fast": " b "}');
    expect(r.ok && r.value?.fast).toBe("b");
  });

  test("an empty fast is no fast tier", () => {
    const r = parse('{"run": "a", "fast": ""}');
    expect(r.ok && r.value?.fast).toBeNull();
  });

  test("a non-string or multi-line fast fails with the reason", () => {
    for (const fast of ["1", '"a\\nb"']) {
      const r = parse(`{"run": "a", "fast": ${fast}}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.error)).toContain("check.fast");
    }
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
      origin: "seed",
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

    // The same commit gated again is not run: the first verdict stands (#1795).
    const again = await checks.gate(repo, pull, branched.value.commitOid);
    expect(again.ok).toBe(true);
    expect(again.lines.join("\n")).toContain("already proven green by gate-");
    expect(again.lines.join("\n")).not.toContain("FULL-GREEN");

    // Each gate leaves its slot minutes, opened and closed, for the flow (#6426).
    const traced = app.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM check_gate WHERE issue_id = ?1 AND commit_oid = ?2 AND finished_at >= started_at",
      )
      .get(pull.id, branched.value.commitOid);
    expect(traced?.n).toBe(2);

    // The same tree under another commit — a batch of one is a new squash of
    // the same files — is the same verdict: it names the run it came from and
    // runs nothing (#7782).
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const head = branched.value.commitOid;
    const treeOid = (await runGit(["rev-parse", `${head}^{tree}`], { cwd: bare }));
    if (!treeOid.ok) throw new Error("no tree");
    const squash = await runGit(["commit-tree", treeOid.value, "-m", "Squash of the pull"], { cwd: bare, env: IDENT });
    if (!squash.ok) throw new Error("no commit");
    expect(squash.value).not.toBe(head);
    const batch = await checks.gate(repo, pull, squash.value);
    expect(batch.ok).toBe(true);
    expect(batch.lines.join("\n")).toContain("already proven green by gate-");
    expect(batch.lines.join("\n")).not.toContain("FULL-GREEN");

    // Another tree is another question: it runs.
    const blob = await runGit(["hash-object", "-w", "--stdin"], { cwd: bare, stdin: "other\n" });
    if (!blob.ok) throw new Error("no blob");
    const index = join(dataDir, "tree-index");
    const env = { GIT_INDEX_FILE: index };
    await runGit(["read-tree", treeOid.value], { cwd: bare, env });
    await runGit(["update-index", "--add", "--cacheinfo", `100644,${blob.value},other.txt`], { cwd: bare, env });
    const changed = await runGit(["write-tree"], { cwd: bare, env });
    if (!changed.ok) throw new Error("no tree");
    const other = await runGit(["commit-tree", changed.value, "-m", "Another tree"], { cwd: bare, env: IDENT });
    if (!other.ok) throw new Error("no commit");
    const rerun = await checks.gate(repo, pull, other.value);
    expect(rerun.ok).toBe(true);
    expect(rerun.lines.join("\n")).toContain("FULL-GREEN");
  });

  test("a check's environment carries its cell's CPU limit (#2257)", async () => {
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Declare check limits",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            check: { run: "echo WHOLE", fast: 'echo "CELL-CPUS=$FORGE_CELL_CPUS"', limits: { cpus: 3 } },
          }),
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branched = await commitToBranch(app, alice, repo, {
      branch: "cpu-limit",
      message: "Touch d",
      files: [{ path: "d.txt", content: "d\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, repo, {
      title: "Limits",
      baseBranch: "main",
      headBranch: "cpu-limit",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const deadline = Date.now() + 30_000;
    let run: Run | undefined;
    while (Date.now() < deadline) {
      run = listRuns(app.db, repo.id, { kind: "check", limit: 20 }).find(
        (r) => r.issueId === opened.value.id && r.commitOid === branched.value.commitOid,
      );
      if (run && (run.state === "ok" || run.state === "failed")) break;
      await Bun.sleep(50);
    }
    expect(run?.state).toBe("ok");
    const want = resolveLimits("step", { cpus: 3 }).cpus;
    expect(readRunLog(dataDir, run!.id).lines.join("\n")).toContain(`CELL-CPUS=${want}`);
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
    // Red in the check step, not before it: the queue searches it (#5276).
    expect(done.stage).toBe("check");
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

  test("landing runs the full gate on the merge with its base; red names its tests", async () => {
    // What the merge queue gates (#2036): a commit that is the pull on its
    // base. Handing the red back, and teaching the pull, is the queue's
    // (test/merge-queue.test.ts).
    const pull = listPulls(app.db, repo.id, { state: "open", limit: 5 })[0]!;
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
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const base = (await resolveOid(dir, "refs/heads/main"))!;
    const merged = await mergeable(dir, base, pull.headOid);
    if (!merged.ok) throw new Error("expected the pull to merge with its base");
    const commit = Bun.spawnSync(
      ["git", "commit-tree", merged.value.treeOid, "-p", base, "-p", pull.headOid, "-m", "candidate"],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "forge",
          GIT_AUTHOR_EMAIL: "forge@localhost",
          GIT_COMMITTER_NAME: "forge",
          GIT_COMMITTER_EMAIL: "forge@localhost",
        },
      },
    ).stdout.toString().trim();
    const verdict = await gateCandidate(app, repo, pull, dir, commit);
    if (verdict.lands || "interrupted" in verdict) throw new Error("expected the full gate to be red");
    expect(verdict.comment).toContain("- lands red");
    expect(verdict.learn).toContain("test/y.test.ts");
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
    // The base declares the tier first: a head that then drops or weakens
    // `check.fast` merges cleanly and is still judged with the base's.
    const main = await commitToBranch(app, alice, repo, {
      message: "Base declares the tier",
      files: [{ path: "forge.json", content: forgeJson("echo FULL") }],
    });
    if (!main.ok) throw new Error(JSON.stringify(main.error));
    const old = await commitToBranch(app, alice, repo, {
      branch: "old",
      message: "Drops the fast tier from its own manifest",
      files: [{ path: "forge.json", content: own(undefined) }],
    });
    if (!old.ok) throw new Error(JSON.stringify(old.error));
    const weak = await commitToBranch(app, alice, repo, {
      branch: "weak",
      message: "Weakens its own gate",
      files: [{ path: "forge.json", content: own("echo HEAD-FAST") }],
    });
    if (!weak.ok) throw new Error(JSON.stringify(weak.error));
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
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1, redHoldMs: 60_000 });
    const a = await createUser(app.db, {
      origin: "seed",
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

  test("a green default-branch run keeps the impact map, and the next fast check is seeded with it", async () => {
    const map = '{"test/a.test.ts":["src/a.ts"]}';
    const main = await commitToBranch(app, alice, repo, {
      message: "Measure",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            check: {
              run: `printf '%s' '${map}' > "$FORGE_CHECK_IMPACT"; echo MEASURED`,
              fast: 'echo "SEEDED $(cat "$FORGE_CHECK_IMPACT")"',
            },
          }),
        },
      ],
    });
    if (!main.ok) throw new Error(JSON.stringify(main.error));
    const deadline = Date.now() + 30_000;
    let run: Run | undefined;
    while (Date.now() < deadline) {
      run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.issueId === null && r.commitOid === main.value.commitOid,
      );
      if (run && (run.state === "ok" || run.state === "failed")) break;
      await Bun.sleep(50);
    }
    expect(run?.state).toBe("ok");
    expect(readRunLog(dataDir, run!.id).lines.join("\n")).toContain("impact map kept: 1 tests");

    const branched = await commitToBranch(app, alice, repo, {
      branch: "measured",
      message: "Touch m",
      files: [{ path: "m.txt", content: "m\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, repo, {
      title: "Measured",
      baseBranch: "main",
      headBranch: "measured",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const fast = await settled(branched.value.commitOid);
    expect(fast.state).toBe("ok");
    const log = readRunLog(dataDir, fast.id).lines.join("\n");
    expect(log).toContain("impact map: 1 tests, from the last green main");
    expect(log).toContain('SEEDED {\n  "test/a.test.ts": ["src/a.ts"]\n}'.split("\n")[0]!);
    // A pull's own run never replaces the kept map.
    expect(log).not.toContain("impact map kept");
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

  test("a red main holds pulls' checks; a person's ask runs; green main releases the rest", async () => {
    const mainRun = async (commitOid: string): Promise<Run> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
          (r) => r.commitOid === commitOid && r.issueId === null,
        );
        if (run && (run.state === "ok" || run.state === "failed")) return run;
        await Bun.sleep(50);
      }
      throw new Error("main's check did not finish");
    };
    // Settle what earlier tests left in the lane first.
    await askCheck(app, alice, repo, listPulls(app.db, repo.id, { state: "open", limit: 5 }).find((p) => p.headBranch === "late")!);
    await settled((await resolveOid(repoDir(app.reposRoot, "alice", "merged"), "refs/heads/late"))!);
    const red = await commit(undefined, [
      { path: "forge.json", content: JSON.stringify({ check: { run: "exit 1", fast: "true" } }) },
    ]);
    expect((await mainRun(red)).state).toBe("failed");
    const heads: Record<string, string> = {};
    for (const branch of ["held", "asked"]) {
      heads[branch] = await commit(branch, [{ path: `${branch}.txt`, content: "x\n" }]);
      const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
      if (!opened.ok) throw new Error(String(opened.error));
    }
    await Bun.sleep(500);
    const queuedFor = (oid: string) =>
      listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find((r) => r.commitOid === oid && r.issueId !== null);
    expect(queuedFor(heads["held"]!)?.state).toBe("queued");
    expect(queuedFor(heads["asked"]!)?.state).toBe("queued");

    const pull = listPulls(app.db, repo.id, { state: "open", limit: 10 }).find((p) => p.headBranch === "asked")!;
    const asked = await askCheck(app, alice, repo, pull);
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.run.reason).toBe("asked");
    expect((await settled(heads["asked"]!)).state).toBe("ok");
    expect(queuedFor(heads["held"]!)?.state).toBe("queued");

    const green = await commit(undefined, [
      { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true" } }) },
    ]);
    expect((await mainRun(green)).state).toBe("ok");
    expect((await settled(heads["held"]!)).state).toBe("ok");
  }, 90_000);
});

describe("what a check keeps for the next one", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  const fresh = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "forge-cache-"));
    dirs.push(dir);
    return dir;
  };
  const oid = (c: string): string => c.repeat(40);

  test("a kept cache seeds the next checkout: by its key, else the newest", async () => {
    const data = await fresh();
    const one = await fresh();
    mkdirSync(join(one, CHECK_CACHE));
    writeFileSync(join(one, CHECK_CACHE, "tsc.tsbuildinfo"), "A");
    expect(keepCache(data, "r1", oid("a"), one)).toBe(true);
    writeFileSync(join(one, CHECK_CACHE, "tsc.tsbuildinfo"), "B");
    expect(keepCache(data, "r1", oid("b"), one)).toBe(true);
    utimesSync(join(data, "check-cache", "r1", oid("a")), 1, 1);

    const next = await fresh();
    expect(restoreCache(data, "r1", [oid("a")], next)).toBe(oid("a"));
    expect(readFileSync(join(next, CHECK_CACHE, "tsc.tsbuildinfo"), "utf8")).toBe("A");
    expect(restoreCache(data, "r1", [oid("c")], next)).toBe(oid("b"));
    expect(readFileSync(join(next, CHECK_CACHE, "tsc.tsbuildinfo"), "utf8")).toBe("B");
    // Another repository's cache is not this one's.
    const other = await fresh();
    expect(restoreCache(data, "r2", [oid("a")], other)).toBeUndefined();
    expect(readdirSync(join(other, CHECK_CACHE))).toEqual([]);
  });

  test("a symlink is never followed, in or out, and a key is a commit id", async () => {
    const data = await fresh();
    const outside = await fresh();
    writeFileSync(join(outside, "secret"), "s3cret");
    const linked = await fresh();
    symlinkSync(outside, join(linked, CHECK_CACHE));
    expect(keepCache(data, "r", oid("a"), linked)).toBe(false);
    const planted = await fresh();
    mkdirSync(join(planted, CHECK_CACHE));
    symlinkSync(join(outside, "secret"), join(planted, CHECK_CACHE, "secret"));
    writeFileSync(join(planted, CHECK_CACHE, "ok"), "fine");
    expect(keepCache(data, "r", oid("a"), planted)).toBe(true);
    expect(readdirSync(join(data, "check-cache", "r", oid("a")))).toEqual(["ok"]);
    expect(keepCache(data, "r", "../../x", planted)).toBe(false);
    // The tree's own `.forge-cache` link is replaced, not written through.
    const next = await fresh();
    symlinkSync(outside, join(next, CHECK_CACHE));
    restoreCache(data, "r", [oid("a")], next);
    expect(readdirSync(outside)).toEqual(["secret"]);
    expect(readdirSync(join(next, CHECK_CACHE))).toEqual(["ok"]);
  });

  test("only the newest few commits are kept", async () => {
    const data = await fresh();
    const dir = await fresh();
    mkdirSync(join(dir, CHECK_CACHE));
    writeFileSync(join(dir, CHECK_CACHE, "t"), "x");
    const keys = "abcdef".split("").map(oid);
    keys.forEach((key, i) => {
      keepCache(data, "r", key, dir);
      utimesSync(join(data, "check-cache", "r", key), 1000 + i, 1000 + i);
    });
    expect(readdirSync(join(data, "check-cache", "r")).sort()).toEqual(keys.slice(-CACHE_KEEP).sort());
  });
});

describe("the cache between the forge's own checks", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let alice: User;
  let repo: Repo;
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-kept-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "kept", visibility: "public" });
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

  const settled = async (commit: string): Promise<Run> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.commitOid === commit && (r.state === "ok" || r.state === "failed"),
      );
      if (run) return run;
      await Bun.sleep(50);
    }
    throw new Error(`no check settled for ${commit}`);
  };

  test("main's green check is what the next check starts from; a pull's writes are not kept", async () => {
    const manifest = JSON.stringify({
      check: {
        run: 'echo "MAIN-SAW $(cat .forge-cache/note 2>/dev/null)"; echo "$FORGE_COMMIT" > .forge-cache/note',
        fast: 'echo "PULL-SAW $(cat .forge-cache/note 2>/dev/null)"; echo pull > .forge-cache/note',
      },
    });
    const first = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "forge.json", content: manifest }],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const a = first.value.commitOid;
    const ranA = await settled(a);
    expect(ranA.state).toBe("ok");
    expect(readRunLog(dataDir, ranA.id).lines.join("\n")).toContain("MAIN-SAW \n");

    const branched = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Feature",
      files: [{ path: "f.txt", content: "f\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pulled = await settled(branched.value.commitOid);
    const pullLog = readRunLog(dataDir, pulled.id).lines.join("\n");
    expect(pullLog).toContain(`PULL-SAW ${a}`);
    expect(pullLog).toContain(`cache from ${a.slice(0, 7)}`);

    const moved = await commitToBranch(app, alice, repo, {
      message: "Main moves",
      files: [{ path: "m.txt", content: "m\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const ranB = await settled(moved.value.commitOid);
    const mainLog = readRunLog(dataDir, ranB.id).lines.join("\n");
    expect(mainLog).toContain(`MAIN-SAW ${a}`);
    expect(mainLog).not.toContain("MAIN-SAW pull");
  });
});

describe("the impact map kept beside the forge", () => {
  const map = '{"test/a.test.ts":["src/a.ts"]}';
  let root: string;
  let data: string;
  let checkout: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "impact-store-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const fresh = (name: string): void => {
    data = join(root, name, "data");
    checkout = join(root, name, "checkout");
    mkdirSync(data, { recursive: true });
    mkdirSync(checkout, { recursive: true });
  };

  test("FORGE_CHECK_IMPACT names a plain file in the checkout, nothing else", () => {
    expect(handedImpact(".forge-impact.json")).toBe(".forge-impact.json");
    expect(handedImpact(IMPACT_FILE)).toBe(IMPACT_FILE);
    for (const bad of [undefined, "", "../x.json", "a/b.json", "/etc/passwd", "..", "-rf"])
      expect(handedImpact(bad)).toBeUndefined();
  });

  test("kept from one checkout, seeded into the next", () => {
    fresh("round");
    expect(seedImpact(data, "repo1", checkout)).toBe(0);
    expect(existsSync(join(checkout, IMPACT_FILE))).toBe(false);
    expect(keepImpact(data, "repo1", checkout)).toBeUndefined();
    writeFileSync(join(checkout, IMPACT_FILE), map);
    expect(keepImpact(data, "repo1", checkout)).toBe("impact map kept: 1 tests");
    const next = join(root, "round", "next");
    mkdirSync(next);
    expect(seedImpact(data, "repo1", next)).toBe(1);
    const back = parseImpact(readFileSync(join(next, IMPACT_FILE), "utf8"));
    expect(back).toEqual({ ok: true, value: new Map([["test/a.test.ts", ["src/a.ts"]]]) });
    // Another repository's checks see nothing of it.
    expect(seedImpact(data, "repo2", join(root, "round"))).toBe(0);
  });

  test("a map the check left that is not one is refused, and the kept one stands", () => {
    fresh("refused");
    writeFileSync(join(checkout, IMPACT_FILE), map);
    keepImpact(data, "r", checkout);
    for (const bad of ["nope", "{}", '{"test/a.test.ts":["../../etc/passwd"]}']) {
      writeFileSync(join(checkout, IMPACT_FILE), bad);
      expect(keepImpact(data, "r", checkout)).toStartWith("impact map not kept");
    }
    const next = join(root, "refused", "next");
    mkdirSync(next);
    expect(seedImpact(data, "r", next)).toBe(1);
  });

  test("a symlink in the checkout is neither read on keep nor written through on seed", () => {
    fresh("link");
    const outside = join(root, "link", "outside.json");
    writeFileSync(outside, map);
    symlinkSync(outside, join(checkout, IMPACT_FILE));
    expect(keepImpact(data, "r", checkout)).toBe("impact map not kept: not a plain file");
    // Keep a real map, then seed a checkout whose file points outside.
    rmSync(join(checkout, IMPACT_FILE));
    writeFileSync(join(checkout, IMPACT_FILE), '{"test/b.test.ts":["src/b.ts"]}');
    keepImpact(data, "r", checkout);
    rmSync(join(checkout, IMPACT_FILE));
    symlinkSync(outside, join(checkout, IMPACT_FILE));
    expect(seedImpact(data, "r", checkout)).toBe(1);
    expect(readFileSync(outside, "utf8")).toBe(map);
    expect(readFileSync(join(checkout, IMPACT_FILE), "utf8")).toContain("test/b.test.ts");
  });
});
