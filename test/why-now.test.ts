import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { whyNowRefusal } from "../scripts/gate.ts";
import { featuresAdded, whyNowProblems } from "../src/kernel/why_now.ts";

const add = (path: string) => ({ status: "A", path });

test("a new action, page or route is a feature; edits, tests and other files are not", () => {
  expect(featuresAdded([add("src/actions/x.ts"), add("src/web/pages/y.ts"), add("src/http/api/z.ts")])).toHaveLength(3);
  expect(featuresAdded([add("src/http/mcp/tools/x.ts"), add("src/tui/app/screen.ts"), add("src/http/api/v1/y.ts")])).toHaveLength(3);
  expect(featuresAdded([{ status: "M", path: "src/actions/x.ts" }, add("test/x.test.ts"), add("src/core/x.ts")])).toEqual([]);
});

test("a feature with no answer to the direction is refused, naming the rule and the file", () => {
  const [p] = whyNowProblems([add("src/actions/x.ts")], ["Add x\n\nIt does x."]);
  expect(p).toContain("say why it goes ahead of the pipeline");
  expect(p).toContain("src/actions/x.ts");
});

test("a Why now line or a Pipeline line answers it; a thin reason does not", () => {
  const changes = [add("src/actions/x.ts")];
  expect(whyNowProblems(changes, ["Add x\n\nWhy now: the owner asked for it in #1234 this week"])).toEqual([]);
  expect(whyNowProblems(changes, ["Add x\n\nPipeline: #6534"])).toEqual([]);
  expect(whyNowProblems(changes, ["Add x\n\nWhy now: soon"])).toHaveLength(1);
});

test("a pull that adds no feature is never asked", () => {
  expect(whyNowProblems([add("test/a.test.ts")], ["Fix a"])).toEqual([]);
});

const root = mkdtempSync(join(tmpdir(), "why-now-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** A repo with a base commit, then one commit adding src/actions/x.ts with this message. */
function pull(name: string, message: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src/actions"), { recursive: true });
  git(dir, "init", "-q", "-b", "work");
  writeFileSync(join(dir, "README"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src/actions/x.ts"), "export {};\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return { dir, base };
}

const withBase = async (base: string, f: () => Promise<string[]>) => {
  const old = process.env.FORGE_CHECK_BASE;
  process.env.FORGE_CHECK_BASE = base;
  try {
    return await f();
  } finally {
    if (old === undefined) delete process.env.FORGE_CHECK_BASE;
    else process.env.FORGE_CHECK_BASE = old;
  }
};

test("whyNowRefusal reads a real repo: a feature with no Why now line is refused", async () => {
  const { dir, base } = pull("bare", "Add x");
  const out = await withBase(base, () => whyNowRefusal(dir));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("say why it goes ahead of the pipeline");
  expect(out[0]).toContain("src/actions/x.ts");
});

test("whyNowRefusal passes when any commit on the branch carries the line", async () => {
  const { dir, base } = pull("answered", "Add x\n\nWhy now: the owner asked for it this week");
  expect(await withBase(base, () => whyNowRefusal(dir))).toEqual([]);
});

test("whyNowRefusal asks nothing of a branch that adds no feature", async () => {
  const { dir, base } = pull("quiet", "Add x");
  git(dir, "rm", "-q", "src/actions/x.ts");
  git(dir, "commit", "-qm", "drop x");
  expect(await withBase(base, () => whyNowRefusal(dir))).toEqual([]);
});
