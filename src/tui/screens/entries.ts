/**
 * Palette entries that live beside their screen. A screen module exports an
 * `entry`; this list names them in the order the palette offers them, and
 * `forgeCommands` walks it at one position. Screens are imported here, and
 * this module by `forge.ts`, never the reverse.
 */

import type { Ctx } from "../app/app.ts";
import type { Session } from "../session.ts";
import { entry as cloud } from "./cloud.ts";
import { entry as domains } from "./domains.ts";
import { entry as owner } from "./owner.ts";

export interface PaletteEntry {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  /** Whether this session is offered the entry. */
  offered(session: Session): boolean;
  run(session: Session, ctx: Ctx): void;
}

export const ENTRIES: readonly PaletteEntry[] = [cloud, domains, owner];
