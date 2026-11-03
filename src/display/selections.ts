/**
 * The selections a build can be in, as one viewer sees them: Showcased
 * (the pin's own trailer, `git/builds.ts`) and every display the viewer
 * reads, each holding its `builds` or, without them, today's showcased
 * rule (`items.ts`). Showcased is one selection among the displays'
 * (records/design/1101-forgej-displays/LAYOUT.md, point 2).
 */

import type { App } from "../app.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { selectionKeys } from "./items.ts";
import { listedDisplays } from "./known.ts";

/** One display, as a selection of builds. */
export interface DisplaySelection {
  /** `owner/name` of the display's repository: the selection's id in a URL. */
  readonly id: string;
  readonly repo: Repo;
  readonly title: string;
  /** Its builds, in order, as the viewer may name them. */
  readonly keys: readonly string[];
  /** Whether the file names its builds; without them the showcased rule holds until the first save. */
  readonly chosen: boolean;
  /** Whether the viewer may change it: a person who writes its repository. */
  readonly writes: boolean;
}

/** The id the Showcased selection goes by in a URL. */
export const SHOWCASED = "showcased";

/** Whether `user` may change a display in `repo`: a person who writes it, never an agent. */
export const writesDisplay = (app: App, repo: Repo, user: User | undefined): boolean =>
  user !== undefined && user.kind !== "agent" && canWrite(app.db, repo, user);

/** Every display `viewer` reads whose file parses, as a selection, by title. */
export async function displaySelections(app: App, viewer: User | undefined): Promise<DisplaySelection[]> {
  const listed = await listedDisplays(app, viewer);
  const out: DisplaySelection[] = [];
  for (const d of listed) {
    if (!d.config.ok) continue;
    const config = d.config.value;
    out.push({
      id: `${d.repo.ownerName}/${d.repo.name}`,
      repo: d.repo,
      title: config.title,
      keys: await selectionKeys(app, config, viewer),
      chosen: config.builds !== undefined,
      writes: writesDisplay(app, d.repo, viewer),
    });
  }
  return out.sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : a.id < b.id ? -1 : 1));
}

/** The names of the selections a build is in: Showcased first, then each display. */
export function selectionsHolding(key: string, showcased: boolean, displays: readonly DisplaySelection[]): string[] {
  return [...(showcased ? ["Showcased"] : []), ...displays.filter((d) => d.keys.includes(key)).map((d) => d.title)];
}
