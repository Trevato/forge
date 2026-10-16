/**
 * The protections in docs/THREATS.md, as plain data: each `Test:` line (after a
 * bullet or a paragraph) and each table row naming a call, with the test file
 * cited, or none.
 */

export interface Protection {
  readonly adversary: string;
  readonly text: string;
  /** The cited `test/*.test.ts`, or undefined for "none yet". */
  readonly test: string | undefined;
}

const CITED = /^`(test\/[A-Za-z0-9_.-]+\.test\.ts)`$/;

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
    } else if (/^\s*Test: /.test(line)) {
      if (bullet === undefined && para.length > 0) bullet = para;
      para = [];
      close(line.replace(/^\s*Test: /, "").trim());
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
