/**
 * The composition root. Everything a forge instance is — index, repos,
 * events, socket — lives under one data directory. `createApp` is cheap and
 * side-effect-contained, so tests boot real forges by the dozen.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "./core/schema.ts";
import { EventBus } from "./core/events.ts";
import { openDb } from "./kernel/db.ts";
import { createLog, type Log } from "./kernel/log.ts";

export interface ForgeConfig {
  /** Everything lives here: index db, bare repos, the internal socket. */
  dataDir: string;
  /** @default 3000 */
  port?: number;
}

export interface App {
  readonly config: ForgeConfig;
  readonly db: Database;
  readonly bus: EventBus;
  readonly log: Log;
  readonly reposRoot: string;
  readonly socketPath: string;
  close(): void;
}

export function createApp(config: ForgeConfig): App {
  const reposRoot = join(config.dataDir, "repos");
  mkdirSync(reposRoot, { recursive: true });

  const db = openDb(join(config.dataDir, "forge.db"), migrations);
  const bus = new EventBus(db);

  return {
    config,
    db,
    bus,
    log: createLog("forge"),
    reposRoot,
    socketPath: join(config.dataDir, "forge.sock"),
    close: () => db.close(),
  };
}
