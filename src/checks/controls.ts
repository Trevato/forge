/**
 * Each safeguard of docs/ops/RED-TEAM.md and when it was last tested: one
 * `Standing` per control, read from `<dataDir>/security-report.json` (the file
 * the Security page reads). A control the report names in its optional
 * `controls` list (`[{ id, at, ok }]`) uses that; a control a test file keeps
 * otherwise takes the report's own `at` and `selfTest.failed === 0`, since the
 * timer's self-test runs those tests. Pod security is kept in the cluster's
 * source, no test here can see it: it has a time only when `controls` says so.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSecurityReport } from "../web/pages/security.ts";

const DAY_MS = 86_400_000;
export const STALE_DAYS = 8;
const REPORT_MAX_BYTES = 64 * 1024;

export interface Control {
  readonly id: string;
  readonly name: string;
  /** What the door does, in a sentence. */
  readonly holds: string;
  /** The test that fails if it reopens, or where it is kept when no test here can. */
  readonly keptBy: string;
  /** True when the timer's self-test covers it. */
  readonly tested: boolean;
}

/** The controls of docs/ops/RED-TEAM.md, in its order. */
export const CONTROLS: readonly Control[] = [
  { id: "app-env", name: "App environment allowlist", holds: "An app starts from a short allowlist, never the forge's environment.", keptBy: "test/redteam-doors.test.ts", tested: true },
  { id: "identity-headers", name: "Identity header strip", holds: "The proxy deletes visitor-sent identity headers and writes signed ones.", keptBy: "test/apps-identity.test.ts", tested: true },
  { id: "edge-secret", name: "Edge secret", holds: "Only a request carrying the edge secret can claim a person; apps never see it.", keptBy: "test/edge-auth.test.ts", tested: true },
  { id: "crew-sandbox", name: "Crew sandbox", holds: "A crew run stays in its worktree and its network allowlist.", keptBy: "test/crew-sandbox.test.ts", tested: true },
  { id: "injection-marking", name: "Injection marking", holds: "Text from people who cannot write here is marked untrusted in briefs.", keptBy: "test/redteam-doors.test.ts", tested: true },
  { id: "pod-security", name: "Pod security", holds: "Pod security labels on the cluster's namespaces; kept in the cluster's own source.", keptBy: "the cluster's GitOps source", tested: false },
];

export interface ControlCheck {
  readonly at: string;
  readonly ok: boolean;
}

export interface Standing {
  readonly control: Control;
  readonly check: ControlCheck | null;
  /** Failed, or older than STALE_DAYS: the one thing worth a badge. */
  readonly attention: boolean;
}

/** `controls` of `<dataDir>/security-report.json`, by id; anything malformed is left out. */
export function readControlChecks(dataDir: string): ReadonlyMap<string, ControlCheck> {
  const out = new Map<string, ControlCheck>();
  const path = join(dataDir, "security-report.json");
  try {
    if (!existsSync(path) || statSync(path).size > REPORT_MAX_BYTES) return out;
    const r = JSON.parse(readFileSync(path, "utf8")) as { controls?: unknown } | null;
    if (!Array.isArray(r?.controls)) return out;
    const known = new Set(CONTROLS.map((c) => c.id));
    for (const c of r.controls as unknown[]) {
      const e = c as { id?: unknown; at?: unknown; ok?: unknown } | null;
      if (typeof e?.id !== "string" || !known.has(e.id) || out.has(e.id)) continue;
      if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at)) || typeof e.ok !== "boolean") continue;
      out.set(e.id, { at: e.at, ok: e.ok });
    }
  } catch {
    // Unreadable evidence is no evidence.
  }
  return out;
}

export function controlStandings(dataDir: string, nowMs: number): Standing[] {
  const named = readControlChecks(dataDir);
  const report = readSecurityReport(dataDir);
  return CONTROLS.map((control) => {
    const check: ControlCheck | null =
      named.get(control.id) ?? (control.tested && report ? { at: report.at, ok: report.selfTest.failed === 0 } : null);
    const attention = check !== null && (!check.ok || nowMs - Date.parse(check.at) > STALE_DAYS * DAY_MS);
    return { control, check, attention };
  });
}
