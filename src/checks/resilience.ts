/**
 * The forge's protections as the Resilience page and the terminal say them:
 * each line of docs/THREATS.md with its standing in the last full gate.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseThreats, standing, type Protection, type Standing } from "../core/threats.ts";
import { readGate } from "./gate_last.ts";

const DOC = join(import.meta.dir, "..", "..", "docs", "THREATS.md");

export type Row = { p: Protection; s: Standing };

function doc(): string {
  try {
    return readFileSync(DOC, "utf8");
  } catch {
    return "";
  }
}

export function readResilience(dataDir: string): Row[] {
  const gate = readGate(dataDir);
  return parseThreats(doc()).map((p) => ({ p, s: standing(p, gate) }));
}
