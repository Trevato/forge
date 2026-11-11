/**
 * The crew clone's pre-push hook (#6938): a fake builder run that commits a
 * migration and pushes ends with the pin committed and on the remote.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPinHook } from "../src/crew/pin_hook.ts";

const root = mkdtempSync(join(tmpdir(), "pin-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
const ok = (cwd: string, ...args: string[]) => {
  const r = git(cwd, ...args);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};

// Stands in for the repository's own script: a pin for each unpinned migration.
const FAKE_PIN_SCRIPT = `
import { existsSync, readdirSync, writeFileSync } from "node:fs";
for (const f of readdirSync("src/core/migrations")) {
  const pin = "src/core/migration-pins/" + f.replace(/\\.ts$/, ".pin");
  if (!existsSync(pin)) writeFileSync(pin, "id\\n");
}
`;

/** A remote with one pinned migration on main, and a builder's clone of it with the hook. */
function clone(name: string, withScript = true, withTryRule = false) {
  const seed = join(root, `${name}-seed`);
  const bare = join(root, `${name}.git`);
  const dir = join(root, name);
  mkdirSync(seed);
  ok(seed, "init", "-q", "-b", "main");
  put(seed, "src/core/migrations/0001-a.ts", "a");
  put(seed, "src/core/migration-pins/0001-a.pin", "id\n");
  if (withScript) put(seed, "scripts/pin-migrations.ts", FAKE_PIN_SCRIPT);
  if (withTryRule) put(seed, "src/kernel/try_it.ts", "// the gate's rule");
  put(seed, "README.md", "r");
  ok(seed, "add", "-A");
  ok(seed, "commit", "-qm", "base");
  ok(root, "clone", "-q", "--bare", seed, bare);
  ok(root, "clone", "-q", bare, dir);
  ok(dir, "checkout", "-qb", "work");
  installPinHook(dir);
  return { dir, bare };
}

test("a builder push that adds a migration commits its pin, and the next push carries both", () => {
  const { dir, bare } = clone("adds");
  put(dir, "src/core/migrations/0002-b.ts", "b");
  ok(dir, "add", "-A");
  ok(dir, "commit", "-qm", "add a migration");
  const first = git(dir, "push", "-q", "origin", "work");
  expect(first.exitCode).not.toBe(0);
  expect(first.stderr.toString()).toContain("run git push again");
  expect(existsSync(join(dir, "src/core/migration-pins/0002-b.pin"))).toBe(true);
  expect(ok(dir, "status", "--porcelain")).toBe("");
  expect(ok(dir, "show", "--name-only", "--format=", "HEAD")).toBe("src/core/migration-pins/0002-b.pin");
  ok(dir, "push", "-q", "origin", "work");
  expect(ok(bare, "show", "work:src/core/migration-pins/0002-b.pin")).toBe("id");
  expect(ok(bare, "show", "work:src/core/migrations/0002-b.ts")).toBe("b");
});

test("a push that touches no migration goes through untouched", () => {
  const { dir, bare } = clone("plain");
  put(dir, "README.md", "changed");
  ok(dir, "commit", "-qam", "words");
  const head = ok(dir, "rev-parse", "HEAD");
  ok(dir, "push", "-q", "origin", "work");
  expect(ok(bare, "rev-parse", "work")).toBe(head);
});

test("a push whose migration already has its pin goes through with no extra commit", () => {
  const { dir, bare } = clone("pinned");
  put(dir, "src/core/migrations/0002-b.ts", "b");
  put(dir, "src/core/migration-pins/0002-b.pin", "id\n");
  ok(dir, "add", "-A");
  ok(dir, "commit", "-qm", "add with pin");
  const head = ok(dir, "rev-parse", "HEAD");
  ok(dir, "push", "-q", "origin", "work");
  expect(ok(bare, "rev-parse", "work")).toBe(head);
});

test("a repository without the pin script is not touched", () => {
  const { dir, bare } = clone("noscript", false);
  put(dir, "src/core/migrations/0002-b.ts", "b");
  ok(dir, "add", "-A");
  ok(dir, "commit", "-qm", "add a migration");
  const head = ok(dir, "rev-parse", "HEAD");
  ok(dir, "push", "-q", "origin", "work");
  expect(ok(bare, "rev-parse", "work")).toBe(head);
  expect(readFileSync(join(dir, ".git/hooks/pre-push"), "utf8")).toContain("pin-migrations");
});

test("a push that changes a page with no Try: line is refused with the line to add; with one it goes through", () => {
  const { dir, bare } = clone("try", true, true);
  put(dir, "src/web/pages/x.ts", "export const x = 1;");
  ok(dir, "add", "-A");
  ok(dir, "commit", "-qm", "a page");
  const refused = git(dir, "push", "-q", "origin", "work");
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain("Try: ");
  expect(git(bare, "rev-parse", "--verify", "-q", "work").exitCode).not.toBe(0);
  ok(dir, "commit", "-q", "--allow-empty", "-m", "words", "-m", "Try: open /x and see the page");
  ok(dir, "push", "-q", "origin", "work");
  expect(ok(bare, "rev-parse", "work")).toBe(ok(dir, "rev-parse", "HEAD"));
});

test("the Try: rule asks nothing of a push that changes no reachable file, or of a repository without it", () => {
  const plain = clone("try-plain", true, true);
  put(plain.dir, "src/core/y.ts", "export const y = 1;");
  ok(plain.dir, "add", "-A");
  ok(plain.dir, "commit", "-qm", "core only");
  ok(plain.dir, "push", "-q", "origin", "work");
  const other = clone("try-none");
  put(other.dir, "src/web/pages/x.ts", "export const x = 1;");
  ok(other.dir, "add", "-A");
  ok(other.dir, "commit", "-qm", "a page");
  ok(other.dir, "push", "-q", "origin", "work");
});
