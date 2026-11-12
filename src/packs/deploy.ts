/**
 * Deploy a pack into a running forge: for each app, make it, then carry the
 * source's whole history into it; then add the crew. The doing is handed in
 * (`Hands`), so this module is the order and the reporting, and a test can
 * watch it with fakes. An app that fails is reported and the rest go on;
 * running it again skips what already exists, so a half-deployed pack is
 * finished by deploying it again. No data, secret or variable is read from the
 * source, and the model credential is left for the person to supply. Each app
 * also follows its source (`follow`), so upstream commits show as drift.
 */

import { isForgeSource, type Pack } from "./pack.ts";

export interface Hands {
  /** Make an app; `exists` when the forge already has one of that name. */
  makeApp(name: string, description: string): Promise<{ ok: true; owner: string } | { ok: false; exists: boolean; why: string; owner?: string }>;
  /** Fork the forge repo `source` (`owner/name`) into the person's account as `name`, with lineage: the fork records its parent. No network but the forge's own. */
  forkFrom(source: string, name: string): Promise<{ ok: true; owner: string } | { ok: false; exists: boolean; why: string; owner?: string }>;
  /** The default branch of an app already in the forge, or undefined when it cannot be read. */
  defaultBranch(owner: string, name: string): Promise<string | undefined>;
  /** Copy every branch and tag of `source` into the app, history whole. */
  carryHistory(source: string, owner: string, name: string, branch: string | undefined): Promise<{ ok: true; branch?: string } | { ok: false; why: string }>;
  /** Make the app follow `source` on `branch`, so Settings shows it and a new upstream commit shows as drift. No branch is a failure: a wrong one is never guessed. */
  follow(owner: string, name: string, source: string, branch: string | undefined): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Absorb the app as a feature, as the deploying admin. Refused when the app declares no feature: a repository cannot promote itself. */
  absorb(owner: string, name: string): Promise<{ ok: true } | { ok: false; why: string }>;
  makeAgent(a: Pack["crew"][number]): Promise<{ ok: true } | { ok: false; exists: boolean; why: string }>;
}

export interface Step {
  readonly what: string;
  readonly state: "done" | "kept" | "failed";
  readonly note?: string;
}

/** Absorbing is a step of its own, so a refusal (no declared feature) is reported and never hides that the app is made. */
async function absorbStep(hands: Hands, owner: string, name: string): Promise<Step> {
  const r = await hands.absorb(owner, name);
  return r.ok ? { what: `absorb ${name}`, state: "done", note: "a feature in the menu" } : { what: `absorb ${name}`, state: "failed", note: r.why };
}

/** A forge-repo source is forked, not copied: the fork's lineage is the follow, so nothing is carried or followed over the network. */
async function forkStep(hands: Hands, app: Pack["apps"][number]): Promise<Step[]> {
  const forked = await hands.forkFrom(app.source, app.name);
  if (!forked.ok) {
    if (!forked.exists) return [{ what: `app ${app.name}`, state: "failed", note: forked.why }];
    return [{ what: `app ${app.name}`, state: "kept", note: "already here" }];
  }
  const steps: Step[] = [{ what: `app ${app.name}`, state: "done", note: `forked from ${app.source}` }];
  if (app.absorb === true) steps.push(await absorbStep(hands, forked.owner, app.name));
  return steps;
}

export async function deployPack(pack: Pack, hands: Hands): Promise<readonly Step[]> {
  const steps: Step[] = [];
  for (const app of pack.apps) {
    if (isForgeSource(app.source)) {
      steps.push(...(await forkStep(hands, app)));
      continue;
    }
    const made = await hands.makeApp(app.name, `${app.description} (from ${app.source})`);
    if (!made.ok) {
      if (!made.exists) {
        steps.push({ what: `app ${app.name}`, state: "failed", note: made.why });
        continue;
      }
      // Kept: its history is not pushed again (that could overwrite work), but a
      // follow that an earlier, partial run never set is finished now.
      const owner = made.owner;
      const branch = owner === undefined ? undefined : (app.branch ?? (await hands.defaultBranch(owner, app.name)));
      if (owner === undefined) {
        steps.push({ what: `app ${app.name}`, state: "kept", note: "already here" });
        continue;
      }
      const followed = await hands.follow(owner, app.name, app.source, branch);
      steps.push(
        followed.ok
          ? { what: `app ${app.name}`, state: "kept", note: "already here" }
          : { what: `app ${app.name}`, state: "failed", note: `already here, not followed: ${followed.why}` },
      );
      if (followed.ok && app.absorb === true) steps.push(await absorbStep(hands, owner, app.name));
      continue;
    }
    const carried = await hands.carryHistory(app.source, made.owner, app.name, app.branch);
    if (!carried.ok) {
      steps.push({ what: `app ${app.name}`, state: "failed", note: `made, history not carried: ${carried.why}` });
      continue;
    }
    const followed = await hands.follow(made.owner, app.name, app.source, app.branch ?? carried.branch);
    steps.push(
      followed.ok
        ? { what: `app ${app.name}`, state: "done", note: `history from ${app.source}, following it` }
        : { what: `app ${app.name}`, state: "failed", note: `history carried, not followed: ${followed.why}` },
    );
    if (followed.ok && app.absorb === true) steps.push(await absorbStep(hands, made.owner, app.name));
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
