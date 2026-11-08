/**
 * Review rule: `else` follows its closing brace on the same line.
 *
 * Reviewers asked for this again and again (#7612 and others): a `}` alone
 * on a line with `else` on the next is mis-formatted. This test says it for
 * them. Browser scripts that live inside template strings are not checked:
 * `src/web/client.ts` and `src/apps/toolbar.ts` keep one branch per line on
 * purpose, and the text there is not TypeScript.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SKIPPED = new Set(["src/web/client.ts", "src/apps/toolbar.ts"]);

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") && !SKIPPED.has(path) ? [path] : [];
  });
}

/** `file:line` of every `else` that starts a line right after a lone `}`. */
export function danglingElses(path: string, text: string): string[] {
  const lines = text.split("\n");
  const found: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*else\b/.test(lines[i]!) && /^\s*\}\s*$/.test(lines[i - 1]!)) found.push(`${path}:${i + 1}`);
  }
  return found;
}

test("the rule finds a dangling else", () => {
  expect(danglingElses("x.ts", "if (a) {\n  b();\n}\nelse c();\n")).toEqual(["x.ts:4"]);
  expect(danglingElses("x.ts", "if (a) {\n  b();\n} else c();\n")).toEqual([]);
});

test("review rule: write `} else`, not `}` and `else` on separate lines", () => {
  const bad = ["src", "scripts"].flatMap((dir) =>
    sources(dir).flatMap((path) => danglingElses(path, readFileSync(join(root, path), "utf8"))),
  );
  expect(bad, "rule: `else` goes on the same line as the closing `}`; found at these lines").toEqual([]);
});
