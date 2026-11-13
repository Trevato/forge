/**
 * The protections in docs/THREATS.md, as plain data: each `Enforced by:` line
 * (after a bullet or a paragraph) and each table row naming a call, with the
 * enforcer cited, or none.
 */

export interface Protection {
  readonly adversary: string;
  readonly text: string;
  /**
   * The cited enforcer, a `test/*.test.ts` or a `scripts/*.ts` gate, or
   * undefined for "none yet". A gate never appears in a gate's per-file
   * results, so its standing reads "untested".
   */
  readonly test: string | undefined;
}

/** The line that closes each protection. */
export const ENFORCED_BY = /^\s*Enforced by: /;

/** One cited enforcer: a test file or a gate under scripts/, in backticks. */
export const CITED = /^`((?:test\/[A-Za-z0-9_.-]+\.test\.ts)|(?:scripts\/[A-Za-z0-9_./-]+\.ts))`$/;

/** A gap: nothing enforces the row yet, optionally with the open issue owning it. */
export const NONE_YET = /^none yet(?: \(#\d+\))?$/;

export function parseThreats(md: string): Protection[] {
  const out: Protection[] = [];
  let adversary = "";
  let bullet: string[] | undefined;
  let para: string[] = [];
  const close = (cited: string): void => {
    if (bullet === undefined) return;
    out.push({
      adversary,
      text: bullet.join(" ").replace(/\s+/g, " ").trim(),
      test: CITED.exec(cited)?.[1],
    });
    bullet = undefined;
  };
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      bullet = undefined;
      para = [];
      adversary = line.slice(3).trim();
    } else if (line.startsWith("- ")) {
      bullet = [line.slice(2)];
    } else if (ENFORCED_BY.test(line)) {
      if (bullet === undefined && para.length > 0) bullet = para;
      para = [];
      close(line.replace(ENFORCED_BY, "").trim());
    } else if (/^\s+\S/.test(line) && bullet !== undefined) {
      bullet.push(line.trim());
    } else if (line.startsWith("| ") && line.includes("→")) {
      const cells = line.split("|").map((c) => c.trim());
      bullet = [cells[1] ?? ""];
      close(cells.at(-2) ?? "");
    } else if (line.trim() === "") {
      bullet = undefined;
      para = [];
    } else if (bullet === undefined && !line.startsWith("|")) {
      para.push(line.trim());
    }
  }
  return out;
}

/** What `enforcement` finds in the doc. */
export interface Enforcement {
  /** One sentence per row that breaks the rule, naming the row. */
  readonly problems: string[];
  /** How many rows say `none yet`. */
  readonly noneYet: number;
  /** Every enforcer path cited, in order, repeats kept. */
  readonly cited: string[];
}

/**
 * Hold docs/THREATS.md to its rule: every bullet (outside a `(later)` section,
 * whose bullets are preconditions, not protections) ends in one `Enforced by:`
 * line, every call row names its enforcer in its last cell, each enforcer is
 * a path `exists` says is there or `none yet`.
 */
export function enforcement(md: string, exists: (path: string) => boolean): Enforcement {
  const problems: string[] = [];
  const cited: string[] = [];
  let noneYet = 0;
  let later = false;
  let open: string | undefined;
  const unclosed = (): void => {
    if (open !== undefined) problems.push(`"${open}" has no Enforced by: line`);
    open = undefined;
  };
  const judge = (row: string, value: string): void => {
    if (NONE_YET.test(value)) {
      noneYet++;
      return;
    }
    const path = CITED.exec(value)?.[1];
    if (path === undefined) problems.push(`"${row}" names neither a test, a scripts/ gate nor "none yet": ${value}`);
    else if (!exists(path)) problems.push(`"${row}" names ${path}, which does not exist`);
    else cited.push(path);
  };
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      unclosed();
      later = /\(later\)\s*$/.test(line);
    } else if (later) {
      continue;
    } else if (line.startsWith("- ")) {
      unclosed();
      open = line.slice(2, 62);
    } else if (ENFORCED_BY.test(line)) {
      judge(open ?? "the paragraph above", line.replace(ENFORCED_BY, "").trim());
      open = undefined;
    } else if (/^\s*Test: /.test(line)) {
      problems.push(`"${open ?? line.trim()}" uses the old Test: line; say Enforced by:`);
      open = undefined;
    } else if (line.startsWith("| ") && line.includes("→")) {
      const cells = line.split("|").map((c) => c.trim());
      judge(cells[1] ?? line, cells.at(-2) ?? "");
    } else if (!/^\s+\S/.test(line)) {
      unclosed();
    }
  }
  unclosed();
  return { problems, noneYet, cited };
}

export type Standing = "green" | "red" | "untested" | "no test yet";

/** One protection against the last gate: a cited file that did not run is untested. */
export function standing(
  p: Protection,
  gate: Readonly<Record<string, "pass" | "fail">>,
): Standing {
  if (p.test === undefined) return "no test yet";
  const result = gate[p.test];
  return result === "pass" ? "green" : result === "fail" ? "red" : "untested";
}
