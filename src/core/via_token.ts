/**
 * Via tokens: the credential the forge's own agent is handed to talk to one
 * person (#7640). An ordinary `rw` token of that person — never admin, so it
 * holds no more than they do and less than their session — expiring within
 * the turn, plus one row naming the conversation it speaks for
 * (`conversation:<id>`). `http/mcp.ts` fences what such a caller reads and
 * holds a write the person did not ask for (`core/fence.ts`).
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { heard, VIA_FORM } from "./fence.ts";
import { createToken } from "./tokens.ts";

/** A turn is short: a via token lives an hour at most. */
export const VIA_TOKEN_MAX_MS = 3_600_000;

/**
 * Mint a turn's token for this person, and mark the words that started the
 * turn as the person's newest: until fenced text is read, writes go ahead.
 */
export function mintViaToken(
  db: Database,
  userId: string,
  via: string,
  words: string,
  expiresAt: string,
  now: number = Date.now(),
): Result<{ id: string; token: string }, "invalid_via" | "invalid_expiry"> {
  if (!VIA_FORM.test(via)) return err("invalid_via");
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(until) || until <= now || until - now > VIA_TOKEN_MAX_MS)
    return err("invalid_expiry");
  const minted = createToken(db, userId, `via:${via}`, "rw", { expiresAt });
  db.query("INSERT INTO via_token (token_id, via) VALUES (?1, ?2)").run(minted.id, via);
  heard(db, via, words);
  return ok(minted);
}
