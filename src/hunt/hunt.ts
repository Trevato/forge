/** One hunt: every detector set against one target, timed (Hunt time KPI). */

import { contract } from "./contract.ts";
import { frontDoor } from "./door.ts";
import type { Finding } from "./finding.ts";
import { linkLanding } from "./links.ts";
import { probe, type Fetcher, type Probe } from "./probe.ts";

export interface HuntReport {
  target: string;
  ms: number;
  findings: Finding[];
}

/** The lanes this module covers; UI (headless), flows and speed need a browser and are not here. */
export const LANES: Record<string, (p: Probe, base: string) => Promise<Finding[]>> = {
  door: (p) => frontDoor(p),
  links: linkLanding,
  contract: (p) => contract(p),
};

export async function huntTarget(base: string, fetcher?: Fetcher): Promise<HuntReport> {
  const started = Date.now();
  const p = probe(base, fetcher);
  const findings: Finding[] = [];
  for (const lane of Object.values(LANES)) findings.push(...(await lane(p, base)));
  const seen = new Set<string>();
  return {
    target: base,
    ms: Date.now() - started,
    findings: findings.filter((f) => !seen.has(f.key) && seen.add(f.key)),
  };
}
