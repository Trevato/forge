/**
 * Deploy a pack into a running forge: for each app, make it, then carry the
 * source's whole history into it; then add the crew. The doing is handed in
 * (`Hands`), so this module is the order and the reporting, and a test can
 * watch it with fakes. An app that fails is reported and the rest go on;
 * running it again skips what already exists, so a half-deployed pack is
 * finished by deploying it again. No data, secret or variable is read from the
 * source, and the model credential is left for the person to supply.
 */

import type { Pack } from "./pack.ts";

export interface Hands {
  /** Make an app; `exists` when the forge already has one of that name. */
  makeApp(name: string, description: string): Promise<{ ok: true; owner: string } | { ok: false; exists: boolean; why: string }>;
  /** Copy every branch and tag of `source` into the app, history whole. */
  carryHistory(source: string, owner: string, name: string, branch: string | undefined): Promise<{ ok: true } | { ok: false; why: string }>;
  makeAgent(a: Pack["crew"][number]): Promise<{ ok: true } | { ok: false; exists: boolean; why: string }>;
}

export interface Step {
  readonly what: string;
  readonly state: "done" | "kept" | "failed";
  readonly note?: string;
}

export async function deployPack(pack: Pack, hands: Hands): Promise<readonly Step[]> {
  const steps: Step[] = [];
  for (const app of pack.apps) {
    const made = await hands.makeApp(app.name, `${app.description} (from ${app.source})`);
    if (!made.ok) {
      steps.push(
        made.exists
          ? { what: `app ${app.name}`, state: "kept", note: "already here" }
          : { what: `app ${app.name}`, state: "failed", note: made.why },
      );
      continue;
    }
    const carried = await hands.carryHistory(app.source, made.owner, app.name, app.branch);
    steps.push(
      carried.ok
        ? { what: `app ${app.name}`, state: "done", note: `history from ${app.source}` }
        : { what: `app ${app.name}`, state: "failed", note: `made, history not carried: ${carried.why}` },
    );
  }
  for (const member of pack.crew) {
    const made = await hands.makeAgent(member);
    steps.push(
      made.ok
        ? { what: `crew ${member.username}`, state: "done", note: member.roles.join(", ") }
        : made.exists
          ? { what: `crew ${member.username}`, state: "kept", note: "already here" }
          : { what: `crew ${member.username}`, state: "failed", note: made.why },
    );
  }
  return steps;
}
