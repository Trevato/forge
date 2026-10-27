/**
 * Is this release so: once per version, after a boot that changed it, the
 * forge waits for its own public URL to answer `/healthz` as that version,
 * then runs the smoke checks (`release/smoke.ts`) against it. The verdict is
 * one small file under the data directory (`release/proof.json`), so a
 * restart of the same version never runs it again and vitals reads it
 * without the network. A failure is a `release` card, paged once by the
 * cause pager, until a later version passes. It gives up after ten minutes.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { smoke, type Failure } from "./smoke.ts";
import { UNSTAMPED } from "../kernel/version.ts";
import { ownProbeHeaders } from "../kernel/probe.ts";

/** How long the public URL has to answer as the new version. */
export const GIVE_UP_MS = 10 * 60_000;
const POLL_MS = 2_000;

export interface Proof {
  readonly version: string;
  readonly at: string;
  readonly ok: boolean;
  /** The first failing check, or the give-up, when `ok` is false. */
  readonly failure?: string;
}

const proofFile = (dataDir: string): string => join(dataDir, "release", "proof.json");

/** The last verdict kept, or undefined when none is or the file is not one. */
export function lastProof(dataDir: string): Proof | undefined {
  try {
    const p = JSON.parse(readFileSync(proofFile(dataDir), "utf8")) as Proof;
    if (typeof p.version !== "string" || typeof p.at !== "string" || typeof p.ok !== "boolean") return undefined;
    return p;
  } catch {
    return undefined;
  }
}

function keep(dataDir: string, proof: Proof): Proof {
  mkdirSync(join(dataDir, "release"), { recursive: true });
  const tmp = `${proofFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(proof));
  renameSync(tmp, proofFile(dataDir));
  return proof;
}

/** The card an unproven release is, or undefined while the last verdict is a pass. */
export function proofNeed(dataDir: string): { sentence: string; since: string } | undefined {
  const p = lastProof(dataDir);
  if (p === undefined || p.ok) return undefined;
  return { sentence: `Release ${p.version} is unproven: ${p.failure ?? "a smoke check failed"}.`, since: p.at };
}

/** A failing check as one line: where, as whom, and why. */
export function checkLine(f: Failure): string {
  return `${f.url}${f.agent === "-" ? "" : ` as ${f.agent}`} ${f.why} (status ${f.status})`;
}

export interface ProveOptions {
  readonly dataDir: string;
  readonly version: string;
  /** The forge's public URL. */
  readonly url: string;
  /** Signs `/board` in; without it a redirect to sign-in passes. */
  readonly token?: string | undefined;
  /** An app's URL on this forge: its `/` must never be the forge's page (#6726). */
  readonly appHost?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly giveUpMs?: number;
}

/**
 * Proves `version` unless it was proven (or failed) before. Returns what was
 * kept, or undefined when nothing ran. Never throws.
 */
export async function proveRelease(o: ProveOptions): Promise<Proof | undefined> {
  if (o.version === UNSTAMPED || lastProof(o.dataDir)?.version === o.version) return undefined;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? Bun.sleep;
  const doFetch = o.fetch ?? fetch;
  const finish = (failure?: string): Proof =>
    keep(o.dataDir, {
      version: o.version,
      at: new Date(now()).toISOString(),
      ok: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
    });
  try {
    const health = new URL("/healthz", o.url).href;
    const deadline = now() + (o.giveUpMs ?? GIVE_UP_MS);
    for (;;) {
      try {
        const res = await doFetch(health, { redirect: "manual", headers: ownProbeHeaders(o.dataDir), signal: AbortSignal.timeout(5_000) });
        await res.body?.cancel();
        if (res.headers.get("x-forge-version") === o.version) break;
      } catch {
        // not up yet at its public address
      }
      if (now() + POLL_MS > deadline) return finish(`the public URL never answered as ${o.version}`);
      await sleep(POLL_MS);
    }
    const failures = await smoke(o.url, o.token ?? "", { fetch: doFetch, anonymousBoard: true, ...(o.appHost ? { appHost: o.appHost } : {}) });
    return finish(failures[0] === undefined ? undefined : checkLine(failures[0]));
  } catch (error) {
    return finish(`the smoke checks could not run: ${String(error)}`);
  }
}
