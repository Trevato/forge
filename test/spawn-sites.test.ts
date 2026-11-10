// Every place the forge starts a process, each with the reason its arguments
// are never a person's text standing where a command or a flag goes (#10934).
//
// The list below is the review: a new `Bun.spawn`, `Bun.spawnSync`, `Bun.$`,
// `spawn`/`$` imported from "bun", or `child_process` under src/ fails this test
// by file name until someone adds it here with a reason. A listed file that no
// longer starts a process fails too, so the list stays true. Test files under
// src/ (`*.test.ts`) are test code and are not scanned.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITES: Record<string, string> = {
  "src/apps/contain.ts":
    "probes whether bwrap works: a fixed argv of namespace flags and /bin/true, nothing from a request",
  "src/apps/process.ts":
    "runs an app's `run`/`check` command from its forge.json, which a repository writer pushed; the command is the app's own, run as argv inside its cell (or /bin/sh -c on a host with no cell), never text from a request",
  "src/apps/tty.ts":
    "runs the app's own `tty` command from forge.json, a writer's text, in the app's cell; the person at the terminal reaches only the pty's stdin, never argv",
  "src/chaos/faults.ts":
    "chaos harness: runs bun on its own worker.ts with a database path and repo id the harness made",
  "src/chaos/invariants.ts":
    "chaos harness: `git cat-file -e <oid>^{commit}` with an oid read from the forge's own pulls table",
  "src/checks/install.ts":
    "a fixed argv, `bun install --frozen-lockfile --ignore-scripts`, in the check's checkout",
  "src/cli/commands/open.ts":
    "the CLI hands a forge URL it built to open/xdg-open as one argv element, never through a shell",
  "src/cli/config.ts":
    "the macOS `security` keychain tool with arguments the CLI fixes; the secret travels on stdin, not argv",
  "src/cli/folder-repo.ts":
    "`git -C <dir> remote get-url origin` on the operator's own working folder, a fixed argv",
  "src/cli/notify.ts":
    "osascript/notify-send with title and body as separate argv elements after the script or `--`, so a repo name stays data",
  "src/crew/claude.ts":
    "the agent binary from configuration with flags the runner fixes; the prompt (a person's issue text) is one argv element after its flag and the binary never hands it to a shell; `--version` probe is fixed",
  "src/crew/plan.ts":
    "the planner binary with a fixed flag list; the issue text a person wrote is only the final prompt element, with tools disabled",
  "src/crew/runner.ts":
    "`lsof -t +D <dir>` on the workdir path the forge derived from validated agent, repo and number",
  "src/crew/sandbox.ts":
    "probes bwrap with a fixed argv ending in /bin/true",
  "src/crew/workdir.ts":
    "runBounded is called only with the fixed `bun install --frozen-lockfile --ignore-scripts` argv",
  "src/git/combined.ts":
    "git plumbing with oids checked by isSafeOid before they reach argv",
  "src/git/env.ts":
    "the one git runner: argv to the git binary, no shell; callers pass refs and paths validated at their boundary and after `--` where git accepts it",
  "src/git/local.ts":
    "git argv built by the forge's own operations on refs and oids it validated, no shell",
  "src/git/pull-pipe.ts":
    "`mkfifo -m 600 <path>` on a path the forge made in its own temp directory",
  "src/git/read.ts":
    "`git cat-file` with a mode the code fixes and a rev:path spec checked by assertBatchSafe",
  "src/git/smart-http.ts":
    "serviceCommand: git upload-pack/receive-pack chosen from a closed GitService union, on a repo dir resolved from validated owner and name",
  "src/git/smart-ssh.ts":
    "serviceCommand on a repo dir resolved from the validated ssh request; the service is a closed union",
  "src/kernel/data_home.ts":
    "git on the forge's own data directory with arguments the code fixes",
  "src/looks/capture.ts":
    "headless Chromium from configuration with fixed flags and a URL the forge built for its own preview",
  "src/machines/rc.ts":
    "`git clone --quiet -- <bare> <partial>` between two paths the forge derived",
  "src/release/boot.ts":
    "bun (process.execPath) on the release tree's entry file",
  "src/release/checkout.ts":
    "bun (process.execPath) on the checkout's entry with a fixed `--preflight`",
  "src/release/devtools.ts":
    "headless Chromium from configuration with a fixed flag list and a profile directory it just made",
  "src/release/launch.ts":
    "bun (process.execPath) on src/main.ts in the release tree",
  "src/release/swap.ts":
    "bun (process.execPath) on the release entry file",
  "src/snapshot/boot.ts":
    "bun (process.execPath) on src/main.ts in the snapshot tree",
  "src/spawn/cell.ts":
    "a child forge launched from a launch spec the parent built, wrapped by its cell",
  "src/tui/screens/external.ts":
    "the operator's $EDITOR resolved with Bun.which, refused when it holds whitespace, and a file path the TUI made, as argv",
  "src/tui/term/terminal.ts":
    "open/xdg-open with a URL that must match ^https?:// as one argv element, never a shell",
};

const PATTERNS: readonly RegExp[] = [
  /(?<!typeof\s+)\bBun\.spawn(?:Sync)?\b/,
  /\bBun\.\$/,
  /["'](?:node:)?child_process["']/,
  /\bimport\s*\{[^}]*\b(?:spawn|spawnSync)\b[^}]*\}\s*from\s*["']bun["']/,
  /\bimport\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/,
];

/** Whether `text` starts a process, outside comments. */
function startsProcess(text: string): boolean {
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const line = raw.replace(/\s\/\/.*$/, "");
    if (PATTERNS.some((p) => p.test(line))) return true;
  }
  return false;
}

/** The files under `files` that start a process. */
function sitesIn(files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([, text]) => startsProcess(text)).map(([path]) => path).sort();
}

/** What is wrong between the sites found and the sites listed, one line each. */
function audit(found: readonly string[], listed: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const path of found)
    if (!(path in listed)) problems.push(`${path} starts a process and is not on the list in test/spawn-sites.test.ts`);
  for (const path of Object.keys(listed))
    if (!found.includes(path)) problems.push(`${path} is on the list but no longer starts a process`);
  return problems;
}

function srcFiles(): Map<string, string> {
  const root = join(import.meta.dir, "..");
  const files = new Map<string, string>();
  for (const path of new Bun.Glob("src/**/*.{ts,tsx,js,mjs,cjs}").scanSync({ cwd: root })) {
    if (/\.test\.[cm]?[jt]sx?$/.test(path)) continue;
    files.set(path, readFileSync(join(root, path), "utf8"));
  }
  return files;
}

describe("spawn sites", () => {
  test("every file under src/ that starts a process is listed, and every listed file still does", () => {
    expect(audit(sitesIn(srcFiles()), SITES)).toEqual([]);
  });

  test("every listed site says why its arguments are fixed or validated", () => {
    for (const [path, why] of Object.entries(SITES)) {
      expect(path.startsWith("src/"), path).toBe(true);
      expect(why.length, path).toBeGreaterThan(30);
    }
  });

  test("an unlisted site fails and is named by file", () => {
    const files = new Map([
      ["src/a.ts", "const p = Bun.spawn(['ls']);"],
      ["src/b.ts", "import { spawn } from 'node:child_process';"],
      ["src/c.ts", "await Bun.$`ls`;"],
      ["src/d.ts", 'import { $ } from "bun";'],
      ["src/e.ts", "Bun.spawnSync(['ls']);"],
    ]);
    expect(audit(sitesIn(files), {})).toEqual([
      "src/a.ts starts a process and is not on the list in test/spawn-sites.test.ts",
      "src/b.ts starts a process and is not on the list in test/spawn-sites.test.ts",
      "src/c.ts starts a process and is not on the list in test/spawn-sites.test.ts",
      "src/d.ts starts a process and is not on the list in test/spawn-sites.test.ts",
      "src/e.ts starts a process and is not on the list in test/spawn-sites.test.ts",
    ]);
  });

  test("a listed site that no longer exists fails", () => {
    expect(audit([], { "src/gone.ts": "used to run git" })).toEqual([
      "src/gone.ts is on the list but no longer starts a process",
    ]);
  });

  test("comments, type references and regex dollars are not sites", () => {
    expect(startsProcess("// Bun.spawn would fail here")).toBe(false);
    expect(startsProcess(" * hand to `Bun.spawn` as stdout")).toBe(false);
    expect(startsProcess("let p: ReturnType<typeof Bun.spawn>;")).toBe(false);
    expect(startsProcess("const r = new RegExp(`^${k}$`);")).toBe(false);
    expect(startsProcess("x(); // Bun.spawn later")).toBe(false);
  });
});
