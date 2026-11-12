// Every terminal key that deletes, removes, revokes, stops or detaches asks
// first, as test/danger-buttons.test.ts holds the web to. A call to one of the
// destructive actions below passes when it sits inside an `onChoose` or
// `onSubmit` callback (confirmScreen / promptScreen), or under a `y` key check
// a few lines above it. The scan is plain text, kept narrow so it never fails
// on correct code; anything else is named in `allowed` with its reason.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const screens = join(root, "src", "tui", "screens");

/** The destructive actions from src/actions/ a terminal key must ask before calling. */
const destructive: readonly string[] = [
  "deleteAgent",
  "deleteAppEnvVar",
  "deleteBoard",
  "deleteBranch",
  "deleteLabel",
  "deleteOriginApp",
  "deleteRepo",
  "deleteSshKey",
  "deleteTeam",
  "deleteToken",
  "deleteWebhook",
  "detachFromParent",
  "disableApp",
  "endAccountSession",
  "removeAccount",
  "removeAppDomain",
  "removeFromCrew",
  "removeOwnPasskey",
  "removePromptSource",
  "removeSecret",
  "removeTeamMember",
  "revoke",
  "revokeAccountToken",
  "revokeAppEgress",
  "revokeProposal",
  "severForge",
  "stopEnv",
  "stopMirroring",
  "suspendAccount",
];

/** Today's calls that do not ask in a way the scan sees, one `file — action — reason` per line. */
const allowed: readonly { file: string; action: string; reason: string }[] = [
  { file: "src/tui/screens/prompts.ts", action: "removePromptSource", reason: "in a named `choose` passed as onChoose" },
  { file: "src/tui/screens/deploys.ts", action: "removeAppDomain", reason: "in a named `choose` passed to yesNo as onChoose" },
  { file: "src/tui/screens/deploys.ts", action: "stopEnv", reason: "in `act`, called from `go` after the Stop confirm" },
  { file: "src/tui/screens/boards.ts", action: "deleteBoard", reason: "in `remove`, called only on the y of the delete y/n" },
  { file: "src/tui/screens/about.ts", action: "detachFromParent", reason: "the first call is the dry run; the real one is in onChoose" },
  { file: "src/tui/screens/codes.ts", action: "revoke", reason: "in `go`, passed to confirmScreen and yesNo as onChoose" },
];

/** How many lines above a call a `y` key check still guards it. */
const Y_REACH = 15;

type Call = { file: string; line: number; action: string };

const callPattern = new RegExp(`(?<![\\w.$])(${destructive.join("|")})\\s*\\(`, "g");

/** A destructive action handed over as a value, `onChoose: deleteBoard` or `.then(stopEnv)`: the scan cannot see what calls it. */
const referencePattern = new RegExp(`(?<=[:,(=]\\s*)(${destructive.join("|")})(?=\\s*[),};])`, "g");

/** True when the call at `at` sits inside a block opened as an onChoose/onSubmit callback. */
function insideCallback(text: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "}" || c === ")") depth++;
    else if (c === "{" || c === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      // An opener enclosing the call: is it `onChoose: (…) => {` or `onSubmit(…) {`?
      const before = text.slice(Math.max(0, i - 200), i + 1);
      if (/\b(onChoose|onSubmit)\s*(:\s*(async\s*)?(\([^()]*\)|\w+)\s*=>\s*[({]|\([^()]*\)\s*\{|:\s*(async\s*)?\()$/.test(before))
        return true;
    }
  }
  return false;
}

const yCheck = /(===?\s*["']y["']|["']y["']\s*===?)/;

/** A condition that holds only on `y`: it checks for y and offers no other way in. */
const onlyOnY = (condition: string): boolean => yCheck.test(condition) && !condition.includes("||");

/**
 * True when the call at `at` runs only on a `y` key: `if (… "y") call(…)` on its
 * own line, or inside the block of such an `if` opened within Y_REACH lines above.
 */
function yGuarded(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const sameLine = /\bif\s*\((.*)\)\s*(void\s+|await\s+|return\s+)?[\w.]*$/.exec(text.slice(lineStart, at));
  if (sameLine && onlyOnY(sameLine[1] ?? "")) return true;
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{" && depth-- === 0) {
      const opened = /\bif\s*\(([^{}]*)\)\s*$/.exec(text.slice(Math.max(0, i - 300), i));
      const lines = text.slice(i, at).split("\n").length - 1;
      return opened !== null && onlyOnY(opened[1] ?? "") && lines <= Y_REACH;
    }
  }
  return false;
}

/** Destructive calls in one screen file that neither sit in a callback nor under a y check. */
function unasked(file: string, text: string): Call[] {
  const found: Call[] = [];
  for (const m of text.matchAll(callPattern)) {
    const at = m.index;
    const lineStart = text.lastIndexOf("\n", at) + 1;
    const head = text.slice(lineStart, at);
    if (/^\s*(import\b|export\b|\/\/|\*)/.test(head) || /\bfunction\s+$/.test(head)) continue;
    const line = text.slice(0, at).split("\n").length;
    if (insideCallback(text, at) || yGuarded(text, at)) continue;
    found.push({ file, line, action: m[1] ?? "" });
  }
  for (const m of text.matchAll(referencePattern)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(import\b|export\b|\/\/|\*)/.test(text.slice(lineStart, m.index))) continue;
    // A name in an import list that spans lines: an `import` above with no `;` since.
    const imported = text.lastIndexOf("import ", m.index);
    if (imported >= 0 && !text.slice(imported, m.index).includes(";")) continue;
    found.push({ file, line: text.slice(0, m.index).split("\n").length, action: m[1] ?? "" });
  }
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

describe("terminal asks first", () => {
  test("a bare destructive call on a key branch is found", () => {
    const screen = [
      "onKey(key) {",
      '  if (key.name === "d") {',
      "    void deleteBoard(f.app, f.user, slug);",
      "  }",
      "}",
    ].join("\n");
    expect(unasked("x.ts", screen)).toEqual([{ file: "x.ts", line: 3, action: "deleteBoard" }]);
  });

  test("confirm callbacks, prompt submits and y checks are not", () => {
    const cases = [
      "confirmScreen(ctx, screen, {\n  onChoose: (i) => {\n    if (i !== 1) return;\n    deleteWebhook(f.app, f.user, repo, id);\n  },\n});",
      "confirmScreen(ctx, screen, {\n  onChoose: async (i) => {\n    await deleteBoard(f.app, f.user, slug);\n  },\n});",
      "promptScreen(ctx, screen, {\n  onSubmit: (value) => {\n    if (value === name) void deleteRepo(f.app, f.user, name);\n  },\n});",
      'promptScreen(ctx, screen, {\n  onSubmit(value) {\n    removeSecret(f.app, f.user, "repo", ref, value);\n  },\n});',
      'if (asking && key.name === "y") {\n  asking = false;\n  removeAppDomain(f.app, f.user, repo, host);\n}',
      'if (e.key === "y") void deleteBoard(f.app, f.user, slug);',
      "promptScreen(ctx, screen, {\n  onSubmit: async (value) => {\n    if (value !== name) return;\n    await deleteRepo(f.app, f.user, name);\n  },\n});",
      'import { deleteBoard } from "../../actions/boards.ts";',
      "// deleteBoard(f.app, f.user, slug) is asked first",
      "const undeleteBoard = (x) => restoreBoard(x);",
      "f.deleteBoard(x);",
    ];
    for (const screen of cases) expect(unasked("x.ts", screen)).toEqual([]);
  });

  test("a named function passed as onChoose is not followed, so its call is found and listed", () => {
    const screen = [
      "const choose = (choice) => {",
      "  if (choice !== 0) return;",
      "  removeAppDomain(f.app, f.user, repo, host);",
      "};",
      "ctx.push(yesNo(ctx, screen, { onChoose: choose }));",
    ].join("\n");
    expect(unasked("x.ts", screen)).toEqual([{ file: "x.ts", line: 3, action: "removeAppDomain" }]);
  });

  test("a destructive action passed by reference is found, since nothing shows who calls it", () => {
    const screen = [
      "confirmScreen(ctx, screen, { onChoose: revokeAppEgress });",
      "void plan.then(stopEnv);",
      "const run = deleteBoard;",
    ].join("\n");
    expect(unasked("x.ts", screen)).toEqual([
      { file: "x.ts", line: 1, action: "revokeAppEgress" },
      { file: "x.ts", line: 2, action: "stopEnv" },
      { file: "x.ts", line: 3, action: "deleteBoard" },
    ]);
    const names = ['import {\n  deleteBoard,\n  showBoard,\n} from "../../actions/boards.ts";', '// the action is `deleteBoard`, asked first', 'binding(["x"], "revoke")'];
    for (const text of names) expect(unasked("x.ts", text)).toEqual([]);
  });

  test("a call outside the callback, after it closes, is found", () => {
    const screen = "confirmScreen(ctx, screen, {\n  onChoose: (i) => {\n    note = String(i);\n  },\n});\nstopEnv(f.app, f.user, repo, env);";
    expect(unasked("x.ts", screen)).toEqual([{ file: "x.ts", line: 6, action: "stopEnv" }]);
  });

  test("a call beside a y/n check, not under its y, is found", () => {
    const screen = [
      "if (asking) {",
      '  if (e.key === "y" || e.key === "n") {',
      '    if (e.key === "D") void deleteBoard(f.app, f.user, slug);',
      '    if (e.key === "y") remove(row);',
      "  }",
      "}",
    ].join("\n");
    expect(unasked("x.ts", screen)).toEqual([{ file: "x.ts", line: 3, action: "deleteBoard" }]);
  });

  test("every destructive call in src/tui/screens asks first or is on the list", () => {
    const found = sources(screens).flatMap((path) =>
      unasked(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")),
    );
    // Each listed case covers one call, so a second bare call in the same file still fails.
    const left = [...allowed];
    const listed = (c: Call): boolean => {
      const i = left.findIndex((a) => a.file === c.file && a.action === c.action);
      if (i >= 0) left.splice(i, 1);
      return i >= 0;
    };
    // A gone case only prints: the pull that fixes a listed screen should not have to
    // edit this file too, so pulls touching the list land in any order (#8034).
    const stale = allowed.filter((a) => !found.some((c) => c.file === a.file && c.action === a.action));
    if (stale.length > 0)
      console.log(
        `tui-asks-first: these listed cases are gone; drop them from the list:\n${stale
          .map((a) => `  ${a.file} — ${a.action} — ${a.reason}`)
          .join("\n")}`,
      );
    const bare = found
      .filter((c) => !listed(c))
      .map(
        (c) =>
          `${c.file}:${c.line} ${c.action} runs without asking: ask first: confirmScreen or a y/n, as src/tui/screens/hooks.ts does`,
      );
    expect(bare).toEqual([]);
  });
});
