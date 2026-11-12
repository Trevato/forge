/**
 * The one rollback the release keeper has (#7557): set the Deployment to
 * the known-good image recorded before the cut, by name. Never "the
 * previous revision": that is whatever the controller last held, and on
 * 2026-10-27 it was the broken version. This is the one action the keeper
 * takes without a canary, because the image it sets was already live.
 */

import { isImage, type Deployer } from "./deploy.ts";

export interface KnownGood {
  readonly version: string;
  readonly image: string;
}

export type RolledBack = { readonly ok: true; readonly image: string } | { readonly ok: false; readonly line: string };

export async function rollBackToNamed(deployer: Deployer, good: KnownGood): Promise<RolledBack> {
  if (!isImage(good.image)) return { ok: false, line: `the recorded known-good image of ${good.version} is not an image reference` };
  try {
    await deployer.setImage(good.image);
    return { ok: true, image: good.image };
  } catch (error) {
    return { ok: false, line: `could not set ${good.image}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
