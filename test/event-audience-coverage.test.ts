/**
 * Every event kind the source emits is classified in `event_audience.ts`.
 *
 * An unclassified kind is for admins only, so a kind that should reach readers
 * and was never listed would vanish quietly. This scan reads every
 * `bus.append({ kind: … })` in `src/` and names the kinds nobody classified.
 * A kind it cannot read literally fails the scan — it is never skipped.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifiedAudience, eventAudience } from "../src/core/event_audience.ts";

/**
 * Kinds built from a name the scan cannot read in place, spelled out by hand.
 * Keyed by file and the expression as written; a new one fails the scan until
 * it is added here with every kind it can take.
 */
const COMPUTED: Record<string, readonly string[]> = {
  "src/actions/runs.ts kind": ["run.queued", "run.started", "run.finished"],
  "src/maintain/keeper/record.ts kind": ["forge_down", "forge_up", "keeper_lull", "keeper_rebase", "keeper_release", "keeper_said"],
};

/** The values of `${issue.kind}`: a thread is an issue or a pull. */
const THREAD_KINDS = ["issue", "pull"];

/** Index of the bracket closing the one at `open`, skipping strings and templates. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === "\\") i++;
        else if (c === "`" && text[i] === "$" && text[i + 1] === "{") {
          i = closing(text, i + 1);
        }
      }
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else if (pairs[c] !== undefined) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new Error("unbalanced brackets");
}

/** `text` cut at top-level occurrences of `sep` (outside brackets and strings). */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`" || c === "{" || c === "(" || c === "[") {
      i = c === '"' || c === "'" || c === "`" ? closingQuote(text, i) : closing(text, i);
    } else if (c === sep) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

function closingQuote(text: string, open: number): number {
  const q = text[open]!;
  let i = open + 1;
  for (; i < text.length && text[i] !== q; i++) {
    if (text[i] === "\\") i++;
    else if (q === "`" && text[i] === "$" && text[i + 1] === "{") {
      i = closing(text, i + 1);
    }
  }
  return i;
}

/** Every kind `expr` can be, or undefined when it is not readable literally. */
function resolve(expr: string, where: string): string[] | undefined {
  const e = expr.trim();
  if (COMPUTED[`${where} ${e}`] !== undefined) return [...COMPUTED[`${where} ${e}`]!];
  const plain = /^"([^"\\]*)"$/.exec(e) ?? /^'([^'\\]*)'$/.exec(e);
  if (plain) return [plain[1]!];
  if (e.startsWith("`") && closingQuote(e, 0) === e.length - 1) {
    let out = [""];
    const body = e.slice(1, -1);
    for (let i = 0; i < body.length; ) {
      let options: string[];
      let next: number;
      if (body[i] === "$" && body[i + 1] === "{") {
        next = closing(body, i + 1) + 1;
        const inner = body.slice(i + 2, next - 1).trim();
        const got = inner === "issue.kind" ? THREAD_KINDS : resolve(inner, where);
        if (got === undefined) return undefined;
        options = got;
      } else {
        const stop = body.indexOf("${", i);
        next = stop === -1 ? body.length : stop;
        options = [body.slice(i, next)];
      }
      out = out.flatMap((a) => options.map((b) => a + b));
      i = next;
    }
    return out;
  }
  const ternary = splitTop(e, "?");
  if (ternary.length === 2 && !e.startsWith("(")) {
    const branches = splitTop(ternary[1]!, ":");
    if (branches.length === 2) {
      const a = resolve(branches[0]!, where);
      const b = resolve(branches[1]!, where);
      return a && b ? [...a, ...b] : undefined;
    }
  }
  if (e.startsWith("(") && closing(e, 0) === e.length - 1) {
    return resolve(e.slice(1, -1), where);
  }
  return undefined;
}

/** What the source emits: each kind, and each place whose kind cannot be read. */
export function emittedKinds(files: Record<string, string>): {
  kinds: Map<string, string>;
  unreadable: string[];
} {
  const kinds = new Map<string, string>();
  const unreadable: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    for (const call of text.matchAll(/\.append\(\s*\{/g)) {
      const open = call.index! + call[0].length - 1;
      const body = text.slice(open + 1, closing(text, open));
      const line = text.slice(0, open).split("\n").length;
      for (const prop of splitTop(body, ",")) {
        const m = /^\s*kind\s*(?::([\s\S]*))?$/.exec(prop);
        if (!m) continue;
        const expr = m[1] ?? "kind";
        const got = resolve(expr, path);
        if (got === undefined) unreadable.push(`${path}:${line} kind: ${expr.trim()}`);
        else for (const k of got) if (!kinds.has(k)) kinds.set(k, `${path}:${line}`);
      }
    }
  }
  return { kinds, unreadable };
}

/** Anchored at the repository, not the working directory the runner happens to have. */
const ROOT = join(import.meta.dir, "..");

async function sources(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const path of new Glob("src/**/*.ts").scan(ROOT)) {
    out[path] = readFileSync(join(ROOT, path), "utf8");
  }
  return out;
}

describe("event audience coverage", () => {
  test("every kind the source emits is classified", async () => {
    const { kinds, unreadable } = emittedKinds(await sources());
    expect(kinds.size).toBeGreaterThan(50);
    const missing = [...kinds]
      .filter(([kind]) => classifiedAudience(kind) === undefined)
      .map(([kind, at]) => `${kind} (${at})`);
    expect(missing).toEqual([]);
    expect(unreadable).toEqual([]);
    // A scan of every source file is CPU work: a loaded check machine gets
    // room, since only the code under test may decide the verdict.
  }, 60_000);

  test("an unclassified kind is for admins, never readers", () => {
    expect(classifiedAudience("brand.new_kind")).toBeUndefined();
    expect(eventAudience("brand.new_kind")).toBe("admins");
  });

  test("a clog's events carry its cause and are classified for admins, never guests or agents", () => {
    for (const kind of ["clog.started", "clog.cleared"]) {
      expect(classifiedAudience(kind)).toBe("admins");
      expect(eventAudience(kind)).toBe("admins");
    }
  });

  test("the scan names a kind it cannot read literally", () => {
    const { unreadable } = emittedKinds({
      "src/x.ts": "app.bus.append({ kind: pick(a), payload: {} });",
    });
    expect(unreadable).toEqual(["src/x.ts:1 kind: pick(a)"]);
  });

  test("the scan reads ternaries and thread templates", () => {
    const { kinds, unreadable } = emittedKinds({
      "src/x.ts":
        'bus.append({ kind: ok ? "a.b" : "c.d" });\nbus.append({\n kind: `${issue.kind}.${s ? "x" : "y"}`,\n});',
    });
    expect([...kinds.keys()].sort()).toEqual(
      ["a.b", "c.d", "issue.x", "issue.y", "pull.x", "pull.y"].sort(),
    );
    expect(unreadable).toEqual([]);
  });
});
