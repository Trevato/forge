/**
 * An environment's credential into the forge: what lets a page an agent
 * built inside an app read the forge it runs on — `now`, the map, `/events`.
 *
 * One `ro` token per running process, held by the repository's owner, so
 * the app reads exactly what its owner may read and can change nothing. It
 * is minted when the process starts, revoked when that process stops for
 * any reason (replaced by a deploy, asleep, crashed, stopped, torn down),
 * and kept short-lived while it runs: `renewAppToken` slides the expiry on
 * every sweep, so a forge that dies without revoking it leaves a token that
 * stops working by itself within `APP_TOKEN_TTL_MS`.
 *
 * Read-only on purpose. An app's pages are served to whoever its `access`
 * lets in; a token that could act would let any of those visitors act as
 * the owner. Saying something to the crew stays the person's own act, on
 * the forge, under their own session.
 */

import type { Database } from "bun:sqlite";
import { createToken, renewToken, revokeToken } from "../core/tokens.ts";

/** How long an app token outlives the last sweep that saw its process. */
export const APP_TOKEN_TTL_MS = 24 * 60 * 60_000;

export interface AppToken {
  readonly id: string;
  readonly token: string;
}

/** The name a person sees for it among their tokens: which app, which env. */
export const appTokenName = (slug: string, env: string): string =>
  `app:${slug}/${env}`;

const until = (now: number): string =>
  new Date(now + APP_TOKEN_TTL_MS).toISOString();

export function mintAppToken(
  db: Database,
  ownerId: string,
  slug: string,
  env: string,
  now: number = Date.now(),
): AppToken {
  const token = createToken(db, ownerId, appTokenName(slug, env), "ro", {
    expiresAt: until(now),
  });
  // Which app holds it: what the forge trusts when the process asks for a
  // device (`core/device_grants.ts`), because only this function writes it.
  db.query(
    "INSERT INTO app_token (token_id, app_id) SELECT ?1, id FROM app WHERE slug = ?2",
  ).run(token.id, slug);
  return token;
}

export function renewAppToken(
  db: Database,
  tokenId: string,
  now: number = Date.now(),
): void {
  renewToken(db, tokenId, until(now));
}

export function revokeAppToken(db: Database, tokenId: string | undefined): void {
  if (tokenId !== undefined) revokeToken(db, tokenId);
}

/** `FORGE_API_URL`: the forge's JSON API, from its public URL. */
export const forgeApiUrl = (forgeUrl: string): string =>
  `${forgeUrl.replace(/\/+$/, "")}/api/v1`;
