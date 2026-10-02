/**
 * The secrets one run may hold. An issue or an agent's brief declares them
 * in front-matter at the top of its text:
 *
 *     ---
 *     secrets: CLOUDFLARE_API_TOKEN@api.cloudflare.com, TF_BUCKET_KEY
 *     ---
 *
 * `NAME@host` also names the host the secret is for; the run's sandbox may
 * reach exactly those hosts, for that run only. Whatever is not declared is
 * not resolved, whatever is malformed or would shadow the run's own
 * environment is refused by name, and the values are held for redaction from
 * the moment they are opened until the grant is dropped.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import { recordGrant, releaseGrant } from "../core/run_secret.ts";
import { isSecretName, resolveScoped } from "../core/secret_store.ts";
import { holdValues, releaseValues } from "../kernel/log.ts";

export interface Declaration {
  readonly names: readonly string[];
  /** Hosts the declared secrets are for. */
  readonly hosts: readonly string[];
  /** The host each name is for, where it said. */
  readonly hostOf: Readonly<Record<string, string>>;
  /** Entries that were not accepted, with why — said in the run's log. */
  readonly refused: readonly string[];
}

/** Names a secret may never take: the run's own environment. */
const RESERVED =
  /^(FORGE_|GIT_|CLAUDE_|ANTHROPIC_|LD_|DYLD_|BUN_|NODE_)|^(PATH|HOME|USER|SHELL|PWD|TMPDIR|IFS)$/;

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAX_DECLARED = 16;

export function parseDeclaration(...texts: readonly string[]): Declaration {
  const names: string[] = [];
  const hosts = new Set<string>();
  const hostOf: Record<string, string> = {};
  const refused: string[] = [];
  for (const text of texts) {
    const m = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (m === null) continue;
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^secrets\s*:\s*(.*)$/i.exec(line.trim());
      if (kv === null) continue;
      for (const entry of kv[1]!.split(",")) {
        const item = entry.trim();
        if (item === "") continue;
        const [name = "", host] = item.split("@") as [string, string?];
        if (!isSecretName(name) || RESERVED.test(name)) {
          refused.push(`${name.slice(0, 40)}: not a usable name`);
          continue;
        }
        if (host !== undefined && !HOST.test(host.toLowerCase())) {
          refused.push(`${name}: not a host name`);
          continue;
        }
        if (names.includes(name)) continue;
        if (names.length >= MAX_DECLARED) {
          refused.push(`${name}: more than ${MAX_DECLARED} declared`);
          continue;
        }
        names.push(name);
        if (host !== undefined) {
          hosts.add(host.toLowerCase());
          hostOf[name] = host.toLowerCase();
        }
      }
    }
  }
  return { names, hosts: [...hosts], hostOf, refused };
}

export interface Grant {
  /** Env to merge beside `FORGE_TOKEN`. */
  readonly env: Record<string, string>;
  /** Names held, for the log. */
  readonly names: readonly string[];
  /** Declared but set at no scope. */
  readonly missing: readonly string[];
  /** Extra egress hosts for this run only. */
  readonly hosts: readonly string[];
  /** Drop the grant: values forgotten, record closed. Safe to call twice. */
  readonly release: () => void;
}

export function grantSecrets(
  db: Database,
  dataDir: string,
  bus: EventBus,
  declared: Declaration,
  run: { id: string; repoId: string; ownerId: string; actorId: string },
): Grant {
  const found =
    declared.names.length === 0
      ? {}
      : resolveScoped(db, dataDir, bus, declared.names, {
          repo: run.repoId,
          org: run.ownerId,
          actor: run.actorId,
          run: run.id,
        });
  const names = Object.keys(found);
  const env = Object.fromEntries(names.map((n) => [n, found[n]!.value]));
  // Held before anything can log: a value is redacted from the first line.
  if (names.length > 0) {
    holdValues(`run:${run.id}`, Object.values(env));
    recordGrant(
      db,
      run.id,
      names.map((name) => ({ name, scope: found[name]!.scope })),
    );
  }
  return {
    env,
    names,
    missing: declared.names.filter((n) => !(n in found)),
    // Only a secret that was actually granted widens the egress.
    hosts: [...new Set(names.flatMap((n) => declared.hostOf[n] ?? []))],
    release: () => {
      releaseValues(`run:${run.id}`);
      releaseGrant(db, run.id);
    },
  };
}
