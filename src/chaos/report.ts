/**
 * Results are issues. A broken invariant files one on the forge named by
 * FORGE_URL, with the fault, the seed and the log, and stands it under the
 * P0 Trust umbrella (FORGE_CHAOS_PILLAR_ISSUE: the umbrella waits for it).
 * A quiet night comments one line on FORGE_CHAOS_RECOVERY_ISSUE. Only the
 * result goes out; the faults never touch what FORGE_URL names.
 */

import type { Night } from "./run.ts";

export interface Finding {
  readonly fault: string;
  readonly broken: readonly string[];
}

const REPO = process.env["FORGE_CHAOS_REPO"] ?? "trevato/forge";

/** The issue a night's findings make. Pure, so it is tested. */
export function issueFor(night: Night): { title: string; body: string } {
  const faults = [...new Set(night.findings.map((f) => f.fault))];
  return {
    title: `Chaos broke an invariant: ${faults.join("; ")} (seed ${night.seed})`,
    body: [
      "A nightly chaos run on a side instance found a broken invariant.",
      "",
      `Reproduce: \`bun src/chaos/run.ts --seed ${night.seed}\``,
      "",
      ...night.findings.flatMap((f) => [
        `**${f.fault}**`,
        ...f.broken.map((b) => `- ${b}`),
      ]),
      "",
      "```",
      ...night.log,
      "```",
    ].join("\n"),
  };
}

/** One quiet line for the recovery issue. */
export const quietLine = (night: Night): string =>
  `chaos night, seed ${night.seed}: ${night.faults.length} faults, every invariant held.`;

async function call(path: string, body: unknown): Promise<Response> {
  const url = process.env["FORGE_URL"];
  const token = process.env["FORGE_TOKEN"];
  if (!url || !token) throw new Error("FORGE_URL and FORGE_TOKEN are needed to report");
  return fetch(`${url}/api/v1/repos/${REPO}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** File the result; returns one line saying what was done. */
export async function fileReport(night: Night): Promise<string> {
  if (night.findings.length === 0) {
    const recovery = process.env["FORGE_CHAOS_RECOVERY_ISSUE"];
    if (!recovery) return `${quietLine(night)} (no FORGE_CHAOS_RECOVERY_ISSUE; not posted)`;
    const res = await call(`/issues/${Number(recovery)}/comments`, { body: quietLine(night) });
    return `${quietLine(night)} posted: ${res.status}`;
  }
  const res = await call("/issues", issueFor(night));
  const made = (await res.json().catch(() => ({}))) as { number?: number };
  const pillar = process.env["FORGE_CHAOS_PILLAR_ISSUE"];
  if (made.number !== undefined && pillar)
    await call(`/issues/${Number(pillar)}/dependencies`, { blockedBy: made.number });
  return `filed issue #${made.number ?? "?"}: ${res.status}`;
}
