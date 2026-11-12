import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryItRefusal } from "../scripts/gate.ts";
import { surfaceChanged, tryItProblems } from "../src/kernel/try_it.ts";

const ch = (status: string, path: string) => ({ status, path });

test("pages, routes, tools, actions and screens are surfaces; core, tests and deletions are not", () => {
  expect(
    surfaceChanged([ch("M", "src/web/pages/a.ts"), ch("A", "src/http/api/b.ts"), ch("M", "src/actions/c.ts"), ch("M", "src/tui/d.ts")]),
  ).toHaveLength(4);
  expect(surfaceChanged([ch("M", "src/core/x.ts"), ch("A", "test/x.test.ts"), ch("D", "src/web/pages/a.ts")])).toEqual([]);
});

test("an edited surface with no Try line is refused, naming the rule and the file", () => {
  const [p] = tryItProblems([ch("M", "src/web/pages/a.ts")], ["Fix a"]);
  expect(p).toContain("say how to try it on the preview");
  expect(p).toContain("src/web/pages/a.ts");
});

test("a Try line answers it; a thin one does not", () => {
  const changes = [ch("M", "src/http/api/b.ts")];
  expect(tryItProblems(changes, ["Fix b\n\nTry: GET /api/v1/b on the preview and see the count"])).toEqual([]);
  expect(tryItProblems(changes, ["Fix b\n\nTry: it"])).toHaveLength(1);
});

test("a hollow Try line is no line, and the feed, view and cli dirs are surfaces", () => {
  const changes = [ch("M", "src/feed/a.ts")];
  expect(tryItProblems(changes, ["Fix\n\nTry: n/a, internal change only"])).toHaveLength(1);
  expect(tryItProblems(changes, ["Fix\n\nTry: did not run it on the preview"])).toHaveLength(1);
  expect(tryItProblems(changes, ["Fix\n\nTry: open / on the preview and see the new row"])).toEqual([]);
  expect(surfaceChanged([ch("M", "src/view/a.ts"), ch("A", "src/cli/b.ts")])).toHaveLength(2);
});

test("a legitimate Try line is never mistaken for a hollow one", () => {
  const changes = [ch("M", "src/feed/a.ts")];
  for (const line of [
    "Try: todo list: open /todos on the preview",
    "Try: todo list page, open /todos",
    "Try: nothing-found state: open /x on the preview",
    "Try: see diff view at /review on the preview",
    "Try: none-selected state: open /x and press j",
  ])
    expect(tryItProblems(changes, [`Fix\n\n${line}`])).toEqual([]);
});

test("each Try line is judged alone: a real one wins over a hollow one, and other lines are not read", () => {
  const changes = [ch("M", "src/feed/a.ts")];
  expect(tryItProblems(changes, ["Fix\n\nTry: open /x on the preview and see the row\nTry: n/a"])).toEqual([]);
  expect(tryItProblems(changes, ["Fix\n\nTry: open /x on the preview and see the row\nI did nothing else here."])).toEqual([]);
  expect(tryItProblems(changes, ["Fix\n\nnothing to try here, honestly\nTry: n/a"])).toHaveLength(1);
});

test("every surface dir is a surface", () => {
  for (const d of ["actions", "web", "http", "tui", "feed", "view", "cli", "boards", "search", "display", "story", "devices"])
    expect(surfaceChanged([ch("M", `src/${d}/x.ts`)])).toEqual([`src/${d}/x.ts`]);
  expect(surfaceChanged([ch("M", "src/kernel/x.ts")])).toEqual([]);
});

test("a pull that changes no surface is never asked", () => {
  expect(tryItProblems([ch("M", "src/core/x.ts")], ["Fix x"])).toEqual([]);
});

const root = mkdtempSync(join(tmpdir(), "try-it-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

function pull(name: string, message: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src/web"), { recursive: true });
  git(dir, "init", "-q", "-b", "work");
  writeFileSync(join(dir, "README"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src/web/x.ts"), "export {};\n");
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

test("tryItRefusal reads a real repo: refused bare, passed with a Try line", async () => {
  const bare = pull("bare", "Add x");
  const out = await withBase(bare.base, () => tryItRefusal(bare.dir));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("say how to try it on the preview");
  const ok = pull("ok", "Add x\n\nTry: open /x on the preview and read the heading");
  expect(await withBase(ok.base, () => tryItRefusal(ok.dir))).toEqual([]);
});
