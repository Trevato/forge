/**
 * What the in-process release keeper answered at boot (#11924): on, or off
 * and why. `main.ts` notes it once; the main-ahead alarm and /releases read it
 * when the release tick was never heard from, so a finding nobody can fix in
 * code says the keeper is off instead of asking a builder to look. Plain data
 * in memory: a restart answers again. The why names only an environment
 * variable's state, never its value: it reaches a possibly public issue.
 */

export type KeeperAtBoot = { readonly on: true } | { readonly on: false; readonly why: string };

let atBoot: KeeperAtBoot | undefined;

/** Called once at boot with what `keeperEnv` and `keeperPorts` answered; `undefined` forgets it. */
export function noteKeeperAtBoot(k: KeeperAtBoot | undefined): void {
  atBoot = k === undefined ? undefined : k.on ? { on: true } : { on: false, why: k.why };
}

export function keeperAtBoot(): KeeperAtBoot | undefined {
  return atBoot;
}

/**
 * One line for a tick never heard from: the keeper off and why, or on but not ticked;
 * undefined before boot noted it.
 */
export function neverTickedLine(): string | undefined {
  if (atBoot === undefined) return undefined;
  return atBoot.on ? "the release keeper is on but has not ticked" : `the in-process release keeper is off: ${atBoot.why}`;
}
