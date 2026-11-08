/**
 * Where a display item opens, as far as main reads it: a pin's screenshots
 * on its own repository. Jay Moran's launch.ts (`origin/incoming/jay-main`)
 * also signs grants for captured pages on the display origin and names the
 * covers and downloads; those wait for the Arcade host and for `pin_demos.ts`.
 */

import type { Repo } from "../core/repos.ts";
import type { BuildPin } from "../git/builds.ts";

/** A pin's screenshots, on its repository. */
export const repoShotsUrl = (repo: Pick<Repo, "ownerName" | "name">, pin: Pick<BuildPin, "label">): string =>
  `/${repo.ownerName}/${repo.name}/builds/${encodeURIComponent(pin.label)}/shots`;
