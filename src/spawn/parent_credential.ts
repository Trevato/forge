/**
 * What a child forge holds to speak to its parent forge as a proposer: the
 * parent's address (`upstream` in `parent.json`), the parent's repository
 * for this forge's code, and the proposal token with the child name it was
 * minted for (`core/proposal_token.ts`). The token lives beside the heartbeat
 * key in `parent.json`, never in the database, never in an answer.
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { isChildName } from "../core/proposal_token.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { forgeLinkOf, originOf } from "./chain.ts";

export interface ParentCredential {
  /** The parent forge's origin, no trailing slash. */
  readonly url: string;
  /** `owner/name` of the repository on the parent. */
  readonly repo: string;
  readonly child: string;
  readonly token: string;
}

const path = (app: App): string => join(app.config.dataDir, "parent.json");

async function readDoc(app: App): Promise<Record<string, unknown> | undefined> {
  try {
    const doc = await Bun.file(path(app)).json();
    return typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The credential, when this forge follows a parent and was handed one. */
export async function parentCredential(app: App): Promise<ParentCredential | undefined> {
  const doc = await readDoc(app);
  const link = await forgeLinkOf(app);
  if (doc === undefined || link === undefined || link.severedAt !== undefined) return undefined;
  const url = originOf(doc["upstream"]);
  const p = doc["proposal"];
  if (url === "" || typeof p !== "object" || p === null) return undefined;
  const { child, token } = p as Record<string, unknown>;
  if (typeof child !== "string" || !isChildName(child)) return undefined;
  if (typeof token !== "string" || !/^[\x21-\x7e]{8,200}$/.test(token)) return undefined;
  return { url, repo: link.upstream, child, token };
}

/** Keep the token a parent minted for this child. The rest of `parent.json` stays as it is. */
export async function keepParentCredential(
  app: App,
  input: { child: string; token: string },
): Promise<Result<void, "invalid" | "no_parent">> {
  if (!isChildName(input.child) || !/^[\x21-\x7e]{8,200}$/.test(input.token)) return err("invalid");
  const doc = await readDoc(app);
  if (doc === undefined) return err("no_parent");
  await Bun.write(
    `${path(app)}.tmp`,
    JSON.stringify({ ...doc, proposal: { child: input.child, token: input.token } }),
    { mode: 0o600 },
  );
  await rename(`${path(app)}.tmp`, path(app));
  return ok();
}
