/**
 * The terminal home's living pipeline (#8015), the web home's in lines: the
 * pipeline in four words for a site admin, then what is being built and what
 * just shipped, each filtered to what the viewer reads by the same reads the
 * web uses. The tell box is the home's own tell, already there.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../../core/users.ts";
import { readBuilding, readShipped, type MovingRow, type Now } from "../../flow/moving.ts";
import { plain } from "./boards.ts";

const listLine = (label: string, rows: readonly MovingRow[], empty: string): string =>
  `${label}  ${rows.length === 0 ? empty : rows.map((r) => `${plain(r.title)} (${plain(r.repo)})`).join(" · ")}`;

/** `now` is passed only for a site admin: the counts take in every repository, private ones too. */
export function movingLines(db: Database, viewer: User, now: Now | undefined): string[] {
  return [
    ...(now === undefined ? [] : [`Now  check ${now.check} › review ${now.review} › land ${now.land} › ${now.live} live`]),
    listLine("Being built", readBuilding(db, viewer), "nothing right now"),
    listLine("Just shipped", readShipped(db, viewer), "nothing yet"),
  ];
}
