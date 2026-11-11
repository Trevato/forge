/**
 * Every server-side background timer names its job (#11117): a loop stall is
 * blamed only on work run inside `during` (`src/perf/jobs.ts`), so a timer
 * whose callback is not wrapped reads `unknown` in the stall blame.
 *
 * The scan reads src/ — not the browser files under src/web, src/web/vendor
 * or the terminal UI in src/tui — as syntax, so a timer written inside a
 * template string (the toolbar's browser script, a scaffolded app) is text,
 * not a timer. Every `setInterval(` and `setTimeout(` callback in every file
 * must do its work inside `during`: be a `during` call (behind `void`, `&&`,
 * `.catch`, `.finally` or `.then(() => during(…))`), or a body of such calls
 * with only guards (`if (stopped) return;`), plain flag writes, counter bumps,
 * `set.delete(x)` and `try` around them; else it must be one occurrence on the
 * allow-list below, with its reason (#11167).
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

/** A one-shot whose callback only settles the promise a caller awaits: the work after the await runs in that caller. */
const SLEEP = "a sleep: it only resolves the promise its caller awaits, and the caller's work after the await is the caller's job";
/** A one-shot that rejects, aborts or stops one call in flight: no work of its own. */
const DEADLINE = "a one-shot deadline on one call in flight: it settles, aborts or stops that call and does no work of its own";
/** A one-shot that signals one child process. */
const KILL = "a kill deadline on one child process: it sends a signal, nothing runs on the loop";

const allow = (call: Call, why: string, at: readonly (readonly [string, string])[]): Allowed[] =>
  at.map(([file, starts]) => ({ file, call, starts, why }));

/**
 * Each entry names one timer (an entry listed twice names two alike). The one-shots are
 * many but of three kinds — a sleep, a deadline on one call, a kill on one child — and none
 * does work on the loop: a span around each would only fill the ring with nothing.
 */
const ALLOWED: readonly Allowed[] = [
  ...allow("setInterval", `SSE heartbeat, ${PER_CONNECTION}`, [["src/http/sse.ts", "() => write("]]),
  ...allow("setInterval", `a talk stream's poll, ${PER_CONNECTION}`, [["src/web/pages/talk.ts", "tick"]]),
  ...allow("setInterval", `a shell session's idle check, ${PER_CONNECTION}`, [["src/machines/shell.ts", "() => { if (idle(session"]]),
  ...allow("setInterval", `a git fetch's stall check, ${PER_CONNECTION}`, [["src/git/progress.ts", "() => { slices.push(current)"]]),
  ...allow("setInterval", `a capped fetch's size check, ${PER_CONNECTION}`, [["src/git/capped-fetch.ts", "() => { void newBytes()"]]),
  ...allow("setTimeout", `a device-flow stream's poll, ${PER_CONNECTION}`, [
    ["src/http/flow_stream.ts", "() => void step()"],
    ["src/http/flow_stream.ts", "() => void step()"],
    ["src/http/flow_stream.ts", "() => { emit(\"flow.settled\""],
  ]),
  ...allow("setTimeout", `a shell session's resize debounce, ${PER_CONNECTION}`, [["src/machines/shell.ts", "() => session.size === resize"]]),
  ...allow("setTimeout", `an ssh login's auth deadline, ${PER_CONNECTION}`, [["src/ssh/server.ts", "() => { this.transport.disconnect("]]),
  ...allow("setTimeout", `a media stream's idle deadline, ${PER_CONNECTION}`, [["src/git/read.ts", "() => { finish(); controller.error("]]),
  ...allow("setTimeout", `a git upload's idle deadline, ${PER_CONNECTION}`, [["src/git/smart-http.ts", "stop"]]),
  ...allow("setTimeout", "the loop-lag meter's own tick: it measures how late the loop runs, and a span around it would count that lateness as its own work", [["src/kernel/loop_lag.ts", "() => { // Early"]]),
  ...allow("setTimeout", "the next slice of a sliced flow computation: one span per slice would fill the 256-span ring in one refresh", [["src/system/flow_cache.ts", "fn"]]),
  ...allow("setTimeout", "the release prover's scheduler seam: its caller passes a callback already inside during(\"release-prove\")", [["src/release/prove.ts", "fn"]]),
  ...allow("setTimeout", "track() only holds the round's promise; the round itself runs inside during(\"probes\")", [["src/contract/probes.ts", "() => { void track(during("]]),
  ...allow("setTimeout", "clears a perf capture after its window: five field writes", [["src/perf/capture.ts", "drop"]]),
  ...allow("setTimeout", "clears an image loader's in-flight flag: one comparison and one write", [["src/web/og/raster.ts", "() => loading === mine"]]),
  ...allow("setTimeout", "retries removing one emptied cgroup directory: one rmdir", [["src/apps/cgroup.ts", "() => removeDir(dir"]]),
  ...allow("setTimeout", SLEEP, [
    ["src/kernel/breathe.ts", "done"],
    ["src/maintenance/checks.ts", "done"],
    ["src/chaos/faults.ts", "r"],
    ["src/perf/sample.ts", "r"],
    ["src/cluster/jobs.ts", "r"],
    ["src/release/serving.ts", "r"],
    ["src/apps/holding.ts", "resolve"],
    ["src/checks/service.ts", "resolve"],
    ["src/checks/install.ts", "() => { signal.removeEventListener("],
    ["src/origins/providers/forgejo.ts", "resolve"],
    ["src/origins/providers/github.ts", "resolve"],
    ["src/origins/operator.ts", "resolve"],
    ["src/origins/fork-route.ts", "resolve"],
    ["src/origins/hook.ts", "resolve"],
    ["src/origins/mirror.ts", "resolve"],
    ["src/core/pulls.ts", "resolve"],
    ["src/core/search.ts", "resolve"],
    ["src/spawn/reach.ts", "done"],
    ["src/spawn/live.ts", "done"],
    ["src/crew/network.ts", "done"],
    ["src/crew/dispatch.ts", "resolve"],
    ["src/crew/workdir.ts", "resolve"],
    ["src/cli/commands/sync.ts", "resolve"],
    ["src/cli/commands/talk.ts", "resolve"],
  ]),
  ...allow("setTimeout", DEADLINE, [
    ["src/apps/toolbar.ts", "resolve"],
    ["src/looks/capture.ts", "() => reject("],
    ["src/actions/search.ts", "() => resolve(\"timeout\")"],
    ["src/checks/service.ts", "() => { overran = true; budget.abort(); }"],
    ["src/kernel/mail.ts", "() => finish(false)"],
    ["src/apps/domains.ts", "() => reject("],
    ["src/apps/preview_spec.ts", "() => { stop.abort(); reject("],
    ["src/apps/process.ts", "() => { why ="],
    ["src/data/query.ts", "() => done({ ok: false, error: \"timeout\""],
    ["src/web/code_rows_pool.ts", "() => { waiting.delete(id); resolve(undefined); }"],
    ["src/snapshot/drill.ts", "() => reject("],
    ["src/snapshot/store.ts", "() => reject("],
    ["src/snapshot/lanes.ts", "() => reject("],
    ["src/release/devtools.ts", "() => { if (pending.delete(n))"],
    ["src/release/devtools.ts", "() => { waiting.set(event"],
    ["src/release/prove.ts", "() => resolve(\"hung\")"],
    ["src/crew/dispatch.ts", "() => resolve(\"late\")"],
    ["src/crew/first_look.ts", "() => resolve(undefined)"],
    ["src/crew/plan.ts", "() => resolve(undefined)"],
    ["src/crew/decide.ts", "() => abort.abort()"],
    ["src/crew/runner.ts", "() => { overran = true; controller.abort(); }"],
    ["src/crew/claude.ts", "() => { input.log("],
    ["src/crew/claude.ts", "() => { why = \"timeout\"; stopChild(); }"],
    ["src/display/known.ts", "() => resolve(undefined)"],
  ]),
  ...allow("setTimeout", KILL, [
    ["src/checks/install.ts", "stop"],
    ["src/apps/process.ts", "() => { if (proc.exitCode === null"],
    ["src/release/launch.ts", "() => child.kill(\"SIGKILL\")"],
    ["src/release/checkout.ts", "() => proc.kill(\"SIGKILL\")"],
    ["src/crew/sandbox.ts", "() => proc.kill(\"SIGKILL\")"],
    ["src/crew/workdir.ts", "() => { timedOut = true; proc.kill(\"SIGKILL\"); }"],
    ["src/crew/plan.ts", "() => { try { proc.kill(\"SIGKILL\"); }"],
    ["src/crew/runner.ts", "() => proc.kill(\"SIGKILL\")"],
    ["src/crew/claude.ts", "() => { if (proc.exitCode === null && proc.signalCode === null) { input"],
    ["src/crew/claude.ts", "() => { if (proc.exitCode === null && proc.signalCode === null) signal"],
    ["src/crew/claude.ts", "() => proc.kill(\"SIGKILL\")"],
    ["src/git/env.ts", "() => proc.kill(\"SIGKILL\")"],
    ["src/git/env.ts", "() => { timedOut = true; proc.kill(\"SIGKILL\"); }"],
    ["src/git/progress.ts", "() => { stop(); kill(); }"],
    ["src/git/progress.ts", "kill"],
    ["src/git/local.ts", "() => proc.kill(\"SIGKILL\")"],
  ]),
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
export function callbacks(text: string, call: Call): { callback: string; named: boolean; line: number }[] {
  const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const found: { callback: string; named: boolean; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === call) {
      const first = node.arguments[0];
      if (first !== undefined)
        found.push({
          callback: first.getText(source).replace(/\s+/g, " ").trim(),
          named: isNamed(first),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
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
  if (ts.isExpressionStatement(st) && isBookkeeping(st.expression)) return true;
  if (ts.isIfStatement(st))
    return st.elseStatement === undefined &&
      (ts.isReturnStatement(st.thenStatement) && st.thenStatement.expression === undefined ||
        ts.isBlock(st.thenStatement) && st.thenStatement.statements.every((s) => ts.isReturnStatement(s) && s.expression === undefined));
  if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) return false;
  const { operatorToken, right } = st.expression;
  return operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isLiteralExpression(right) || right.kind === ts.SyntaxKind.TrueKeyword || right.kind === ts.SyntaxKind.FalseKeyword || ts.isIdentifier(right));
}

/** A counter bump (`looks++`) or a timer forgetting itself (`timers.delete(timer)`): no work of its own. */
function isBookkeeping(expr: ts.Expression): boolean {
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr))
    return ts.isIdentifier(expr.operand) && (expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken);
  return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "delete" &&
    ts.isIdentifier(expr.expression.expression) && expr.arguments.length === 1 && ts.isIdentifier(expr.arguments[0]!);
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
interface Timer {
  file: string;
  line: number;
  call: Call;
  callback: string;
  named: boolean;
}
let scanned: Timer[] | undefined;
/** The scan is read once per run: every test below shares it. */
const timers = (): Timer[] => (scanned ??= scan());
function scan(): Timer[] {
  const out: Timer[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (!/\bset(Interval|Timeout)\(/.test(text)) continue;
    for (const call of ["setInterval", "setTimeout"] as const) for (const c of callbacks(text, call)) out.push({ file, call, ...c });
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
    expect(named(`() => { timers.delete(timer); if (!stopped) void during("a", f); }`)).toBe(true);
    expect(named(`() => { looks++; busy = busy.then(() => during("a", f)); }`)).toBe(true);
    expect(named(`() => { timers.delete(f()); during("a", g); }`)).toBe(false);
  });

  test("a setInterval inside a template string is page text, not a timer", () => {
    expect(callbacks("const js = `setInterval(refresh, 1000)`; setInterval(tick, 5);", "setInterval").map((c) => c.callback)).toEqual(["tick"]);
  });

  test("every server-side timer callback is wrapped in during or allowed by name", () => {
    const unnamed = timers()
      .filter((t) => !t.named && !ALLOWED.some((a) => matches(a, t)))
      .map((t) => `${t.file}:${t.line}: ${t.call}(${t.callback.slice(0, 60)}`);
    expect(unnamed).toEqual([]);
  });

  test("the tty idle check, the cell probe deadline and root kill, and the app restart each run inside during (#11167)", () => {
    const all = timers();
    const wrapped = (file: string, name: string) =>
      all.filter((t) => t.file === file && t.named && t.callback.includes(`during("${name}"`)).length;
    expect(wrapped("src/apps/tty_registry.ts", "app-tty-idle")).toBe(1);
    expect(wrapped("src/apps/contain.ts", "cell-probe-deadline")).toBe(1);
    expect(wrapped("src/apps/contain.ts", "cell-kill-root")).toBe(1);
    expect(wrapped("src/apps/runtime.ts", "apps-restart")).toBe(1);
  });

  test("setTimeout is read in every server file, not only the ones #11117 named (#11167)", () => {
    const all = timers();
    const wrapped = (file: string, name: string) =>
      all.filter((t) => t.file === file && t.call === "setTimeout" && t.named && t.callback.includes(`during("${name}"`)).length;
    expect(wrapped("src/core/route_timing.ts", "route-timing-flush")).toBe(1);
    expect(wrapped("src/core/usage_count.ts", "usage-count-flush")).toBe(1);
    expect(wrapped("src/http/access_log.ts", "access-flush")).toBe(1);
    expect(wrapped("src/apps/egress_refused.ts", "egress-refused-flush")).toBe(1);
    expect(wrapped("src/nightly/output.ts", "nightly-output-flush")).toBe(1);
    expect(wrapped("src/web/studio/home_cache.ts", "home-refresh")).toBe(1);
    expect(wrapped("src/web/studio/home_last.ts", "home-last")).toBe(1);
    expect(wrapped("src/spawn/usage.ts", "disk-walk")).toBe(1);
    expect(wrapped("src/snapshot/bucket.ts", "bucket-watch")).toBe(1);
    expect(wrapped("src/crew/routines.ts", "routines")).toBe(1);
    expect(wrapped("src/crew/early.ts", "early-watch")).toBe(1);
    expect(all.filter((t) => t.file === "src/release/prove.ts" && t.callback.includes(`during("release-prove"`)).length).toBe(0);
    expect(readFileSync(join(ROOT, "src/release/prove.ts"), "utf8")).toContain(`schedule(() => void during("release-prove", tick)`);
  });

  test("a failure names the file and line", () => {
    expect(callbacks("\n\nsetInterval(tick, 5);", "setInterval")[0]?.line).toBe(3);
  });

  test("each allowed entry names exactly one timer, and says why", () => {
    const all = timers();
    for (const a of ALLOWED) {
      expect(a.why.length).toBeGreaterThan(10);
      const listed = ALLOWED.filter((b) => b.file === a.file && b.call === a.call && b.starts === a.starts).length;
      expect({ ...a, found: all.filter((t) => matches(a, t)).length }).toEqual({ ...a, found: listed });
    }
  });
});
