/**
 * The access log, read by the forge's owner (`http/access_log.ts`): a forge
 * admin only, never an agent, and everyone else is told `not_found`.
 */

import type { App } from "../app.ts";
import {
  readAccess,
  type AccessLine,
  type AccessQuery,
} from "../http/access_log.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export function listAccess(
  app: App,
  actor: User | undefined,
  query: AccessQuery,
): Result<AccessLine[], "not_found"> {
  if (actor?.isAdmin !== true || actor.kind === "agent") return err("not_found");
  return ok(readAccess(app.config.dataDir, query));
}
