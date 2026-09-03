/**
 * The composition root. Everything a forge instance is — index, repos,
 * events, socket — lives under one data directory. `createApp` is cheap and
 * side-effect-contained, so tests boot real forges by the dozen.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrations } from "./core/schema.ts";
import { EventBus } from "./core/events.ts";
import { enqueueForEvent } from "./core/webhooks.ts";
import { openDb } from "./kernel/db.ts";
import { createLog, type Log } from "./kernel/log.ts";
import { closeReadersUnder } from "./git/read.ts";

export interface ForgeConfig {
  /** Everything lives here: index db, bare repos, the internal socket. */
  dataDir: string;
  /** @default 3000 */
  port?: number;
  /** The hostname clone URLs are built from. @default "localhost" */
  host?: string;
  /**
   * The SSH listener's port, once it is up — `serveForgeSsh` writes the real
   * one back here when it was asked for an ephemeral port. Every surface that
   * shows an `ssh://` clone URL reads it from here, so there is one answer.
   * Undefined means the forge is running without SSH.
   */
  sshPort?: number;
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
  // Resolve to an absolute path up front. The socket path in particular must
  // be absolute: git runs hooks with the working directory set to the bare
  // repo, and the hook relays to this socket — a relative path (the default
  // FORGE_DATA=data) would resolve against the repo dir and never connect.
  const dataDir = resolve(config.dataDir);
  const reposRoot = join(dataDir, "repos");
  mkdirSync(reposRoot, { recursive: true });

  const db = openDb(join(dataDir, "forge.db"), migrations);
  const bus = new EventBus(db);

  // Every event durably enqueues webhook deliveries; the worker (main.ts)
  // sends them. Listener throws are swallowed by the bus, so this can never
  // break the action that produced the event.
  bus.subscribe((event) => enqueueForEvent(db, event));

  return {
    config: { ...config, dataDir },
    db,
    bus,
    log: createLog("forge"),
    reposRoot,
    socketPath: join(dataDir, "forge.sock"),
    close: () => {
      // The pooled `cat-file` readers for this forge's repos are processes,
      // and processes outlive a closed database unless somebody says
      // otherwise. One data dir is one forge, so closing the forge is where
      // that is said.
      closeReadersUnder(reposRoot);
      db.close();
    },
  };
}
