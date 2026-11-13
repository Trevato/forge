/** A proof as printed lines: the script and the terminal screen say the same thing. */
import type { Proof } from "./backup.ts";

export function proofLines(p: Proof): string[] {
  return [
    `${p.ok ? "PROVEN" : "RED"}: ${p.files} files, ${p.bytes} bytes, ${p.tables} tables, ${p.rows} rows`,
    ...p.problems.map((m) => `  ${m.replace(/[\x00-\x1f]/g, "?")}`),
  ];
}
