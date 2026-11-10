/**
 * Every server-side background timer names its job (#11117): a loop stall is
 * blamed only on work run inside `during` (`src/perf/jobs.ts`), so a timer
 * whose callback is not wrapped reads `unknown` in the stall blame.
 *
 * The scan reads src/ — not the browser files under src/web, src/web/vendor
 * or the terminal UI in src/tui — as syntax, so a timer written inside a
 * template string (the toolbar's browser script, a scaffolded app) is text,
 * not a timer. Every `setInterval(` callback, and every `setTimeout(` callback
 * in the files #11117 names, must do its work inside `during`: be a `during`
 * call (behind `void`, `&&`, `.catch`, `.finally` or `.then(() => during(…))`),
 * or a body of such calls with only guards (`if (stopped) return;`), plain
 * flag writes and `try` around them; else it must be one occurrence on the
 * allow-list below, with its reason.
 *
 * `setTimeout` is read only in the named files: elsewhere in src/ it is a
 * one-shot deadline or a delay (over a hundred of them), not a loop, and
 * wrapping each would put a ring slot per request into the job watch.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript-api";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** Browser and terminal code: no server loop runs there. */
const SKIPPED_DIRS = new Set(["src/tui", "src/web/vendor"]);
const isBrowserFile = (path: string): boolean =>
  path.startsWith("src/web/") && /(^|[-_/])client\.ts$/.test(path);

/** The files #11117 names: their `setTimeout`s are read as well. */
const NAMED = new Set([
  "src/perf/views_store.ts",
  "src/perf/traffic_store.ts",
  "src/perf/reads.ts",
  "src/perf/duty.ts",
  "src/perf/github_traffic.ts",
  "src/apps/contain.ts",
  "src/apps/runtime.ts",
  "src/apps/toolbar.ts",
  "src/apps/presence.ts",
  "src/apps/egress.ts",
  "src/apps/scaffold.ts",
  "src/apps/tty_registry.ts",
  "src/system/live.ts",
  "src/runs/lease.ts",
  "src/snapshot/snapshot.ts",
]);

type Call = "setInterval" | "setTimeout";

interface Allowed {
  readonly file: string;
  readonly call: Call;
  /** How the callback begins, whitespace collapsed: it names one occurrence. */
  readonly starts: string;
  readonly why: string;
}

/**
 * The job ring keeps 256 spans (`jobs.ts`). A timer that exists once per open
 * stream, session or fetch scales with load; after a stall every overdue one
 * fires at once and would evict the span of the job that stalled.
 */
const PER_CONNECTION = "one per open connection: wrapped, a burst of them evicts the real jobs from the 256-span ring";

const ALLOWED: readonly Allowed[] = [
  { file: "src/http/sse.ts", call: "setInterval", starts: "() => write(", why: `SSE heartbeat, ${PER_CONNECTION}` },
  { file: "src/web/pages/talk.ts", call: "setInterval", starts: "tick", why: `a talk stream's poll, ${PER_CONNECTION}` },
  { file: "src/machines/shell.ts", call: "setInterval", starts: "() => { if (idle(session", why: `a shell session's idle check, ${PER_CONNECTION}` },
  { file: "src/apps/tty_registry.ts", call: "setInterval", starts: "() => { if (idleFor(entry", why: `an app terminal's idle check, ${PER_CONNECTION}` },
  { file: "src/git/progress.ts", call: "setInterval", starts: "() => { slices.push(current)", why: `a git fetch's stall check, ${PER_CONNECTION}` },
  { file: "src/git/capped-fetch.ts", call: "setInterval", starts: "() => { void newBytes()", why: `a capped fetch's size check, ${PER_CONNECTION}` },
  { file: "src/apps/toolbar.ts", call: "setTimeout", starts: "resolve", why: "a one-shot deadline on reading one page, not a loop" },
  { file: "src/apps/contain.ts", call: "setTimeout", starts: "() => { timedOut = true;", why: "a one-shot deadline on the sandbox probe, not a loop" },
  { file: "src/apps/contain.ts", call: "setTimeout", starts: "() => { try { process.kill(root", why: "a one-shot kill a second after the tree's, not a loop" },
  { file: "src/apps/runtime.ts", call: "setTimeout", starts: "() => { if (this.stopped) return;", why: "a one-shot restart after backoff; the deploy it asks for is its own job" },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(ROOT, path);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(rel)) sources(path, out);
    } else if (name.endsWith(".ts") && !isBrowserFile(rel)) out.push(rel);
  }
  return out;
}

/** The first argument of each `call(` in `text`: its text, whitespace collapsed, and whether its work runs inside `during`. */
export function callbacks(text: string, call: Call): { callback: string; named: boolean }[] {
  const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const found: { callback: string; named: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === call) {
      const first = node.arguments[0];
      if (first !== undefined)
        found.push({ callback: first.getText(source).replace(/\s+/g, " ").trim(), named: isNamed(first) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** An expression whose work is a `during` call: the call itself, or it behind `void`, `&&`, `.catch`, `.finally` or a `.then(() => during(…))`. */
function isDuring(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isVoidExpression(expr)) return isDuring(expr.expression);
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.EqualsToken)
      return isDuring(expr.right);
    return false;
  }
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) return callee.text === "during";
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (isDuring(callee.expression)) return true;
  return callee.name.text === "then" && expr.arguments.length > 0 && expr.arguments.every(isNamed);
}

/** A statement that does no work of its own: a guard that returns, or a flag set to a plain value. */
function isInert(st: ts.Statement): boolean {
  if (ts.isIfStatement(st))
    return st.elseStatement === undefined &&
      (ts.isReturnStatement(st.thenStatement) && st.thenStatement.expression === undefined ||
        ts.isBlock(st.thenStatement) && st.thenStatement.statements.every((s) => ts.isReturnStatement(s) && s.expression === undefined));
  if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) return false;
  const { operatorToken, right } = st.expression;
  return operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isLiteralExpression(right) || right.kind === ts.SyntaxKind.TrueKeyword || right.kind === ts.SyntaxKind.FalseKeyword || ts.isIdentifier(right));
}

/** Every statement is inert or a `during` (a `try` counts by its block), and at least one is a `during`. */
function blockNamed(statements: readonly ts.Statement[]): boolean {
  let any = false;
  for (const st of statements) {
    if (ts.isExpressionStatement(st) && isDuring(st.expression)) any = true;
    else if (ts.isTryStatement(st) && blockNamed(st.tryBlock.statements)) any = true;
    else if (ts.isIfStatement(st) && st.elseStatement === undefined && blockNamed(ts.isBlock(st.thenStatement) ? st.thenStatement.statements : [st.thenStatement])) any = true;
    else if (!isInert(st)) return false;
  }
  return any;
}

/** True when a timer callback's work all runs inside `during`, not merely mentions it. */
function isNamed(node: ts.Node): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    return ts.isBlock(node.body) ? blockNamed(node.body.statements) : isDuring(node.body);
  return ts.isExpression(node) && isDuring(node);
}

/** Whether the callback of the one `setInterval` in `text` counts as named. */
export const isWrapped = (text: string): boolean => callbacks(text, "setInterval")[0]?.named ?? false;

/** Each timer callback the scan reads, with the file and call it came from. */
function timers(): { file: string; call: Call; callback: string; named: boolean }[] {
  const out: { file: string; call: Call; callback: string; named: boolean }[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (!/\bset(Interval|Timeout)\(/.test(text)) continue;
    const calls: Call[] = NAMED.has(file) ? ["setInterval", "setTimeout"] : ["setInterval"];
    for (const call of calls) for (const { callback, named } of callbacks(text, call)) out.push({ file, call, callback, named });
  }
  return out;
}

const matches = (a: Allowed, t: { file: string; call: Call; callback: string }): boolean =>
  a.file === t.file && a.call === t.call && t.callback.startsWith(a.starts);

describe("background timers run inside during", () => {
  test("the scan reads each timer's first argument", () => {
    const read = callbacks(`setInterval(tick, 10); setInterval(() => {\n  g(1, 2);\n}, 5)`, "setInterval");
    expect(read.map((c) => c.callback)).toEqual(["tick", "() => { g(1, 2); }"]);
  });

  test("only a callback whose work runs inside during counts as named", () => {
    const named = (cb: string) => isWrapped(`setInterval(${cb}, 10)`);
    expect(named(`() => during("a", f)`)).toBe(true);
    expect(named(`() => void during("a", () => f()).catch(() => {})`)).toBe(true);
    expect(named(`() => !stopped && during("a", f)`)).toBe(true);
    expect(named(`() => { if (stopped) return; running = true; void during("a", f).finally(() => (running = false)); }`)).toBe(true);
    expect(named(`() => { try { during("a", f); } catch (e) { log(e); } }`)).toBe(true);
    expect(named(`() => { queue = queue.then(() => during("a", f)); }`)).toBe(true);
    expect(named(`() => { f(); during("a", g); }`)).toBe(false);
    expect(named(`() => { /* during(x) */ f(); }`)).toBe(false);
    expect(named(`() => f(during)`)).toBe(false);
    expect(named(`() => { if (x) f(); else return; during("a", g); }`)).toBe(false);
    expect(named(`() => { if (!stopped) during("a", f); }`)).toBe(true);
    expect(named(`tick`)).toBe(false);
  });

  test("a setInterval inside a template string is page text, not a timer", () => {
    expect(callbacks("const js = `setInterval(refresh, 1000)`; setInterval(tick, 5);", "setInterval").map((c) => c.callback)).toEqual(["tick"]);
  });

  test("every server-side timer callback is wrapped in during or allowed by name", () => {
    const unnamed = timers()
      .filter((t) => !t.named && !ALLOWED.some((a) => matches(a, t)))
      .map((t) => `${t.file}: ${t.call}(${t.callback.slice(0, 60)}`);
    expect(unnamed).toEqual([]);
  });

  test("each allowed entry names exactly one timer, and says why", () => {
    const all = timers();
    for (const a of ALLOWED) {
      expect(a.why.length).toBeGreaterThan(10);
      expect({ ...a, found: all.filter((t) => matches(a, t)).length }).toEqual({ ...a, found: 1 });
    }
  });
});
