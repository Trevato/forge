/**
 * An agent reads each tool's `doc`, so the `doc` names every argument the
 * tool's inputSchema takes, in backticks (#9110). Tools owed a fix are listed
 * in OWED; the set only shrinks (empty since #9109 landed).
 */
import { expect, test } from "bun:test";
import { TOOLS } from "../src/http/mcp/tools.ts";

const OWED: Record<string, string[]> = {};

const inBackticks = (doc: string, arg: string): boolean =>
  [...doc.matchAll(/`([^`]*)`/g)].some((m) =>
    new RegExp(`(^|[^A-Za-z0-9_])${arg}($|[^A-Za-z0-9_])`).test(m[1]!),
  );

const missing = (): string[] =>
  TOOLS.flatMap((t) =>
    Object.keys((t.inputSchema as { properties?: object }).properties ?? {})
      .filter((arg) => !inBackticks(t.doc ?? t.description, arg))
      .map((arg) => `${t.name}.${arg}`),
  );

test("every tool's doc names each argument its inputSchema takes", () => {
  const owed = new Set(Object.entries(OWED).flatMap(([n, a]) => a.map((x) => `${n}.${x}`)));
  const breaches = missing().filter((m) => !owed.has(m));
  expect(breaches.map((m) => `doc of ${m.split(".")[0]} omits argument ${m.split(".")[1]}`)).toEqual([]);
});

test("an owed tool that no longer breaches leaves the owed set", () => {
  const now = new Set(missing());
  const settled = Object.entries(OWED).flatMap(([n, a]) => a.map((x) => `${n}.${x}`)).filter((m) => !now.has(m));
  expect(settled).toEqual([]);
});

// The tools #9110 brought into the house form; other tools' docs are not held to `?` yet.
const FORMED = new Set(["edit","limb","asks_act","say","agent","claim_link","audit","asks","read_file","spawn","apps","tell","converge","plan","feed","probe"]);

test("a doc's `{ a, b? }` form marks exactly the optional arguments with ?", () => {
  const wrong: string[] = [];
  for (const t of TOOLS.filter((t) => FORMED.has(t.name))) {
    const form = /^`\{([^}]*)\}`/.exec(t.doc ?? t.description);
    if (!form) continue;
    const schema = t.inputSchema as { properties?: object; required?: string[] };
    const required = new Set(schema.required ?? []);
    for (const part of form[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const optional = part.endsWith("?");
      const name = optional ? part.slice(0, -1) : part;
      if (name in (schema.properties ?? {}) && optional === required.has(name))
        wrong.push(`${t.name}.${name} is ${required.has(name) ? "required" : "optional"} but the doc writes \`${part}\``);
    }
  }
  expect(wrong).toEqual([]);
});
