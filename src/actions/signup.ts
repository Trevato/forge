/**
 * The signup setting (`settings/signup.ts`), for a forge admin who is a
 * person. Everyone else, an agent included, is told `not_found`.
 */

import type { App } from "../app.ts";
import {
  getSignup,
  parseSignup,
  setSignup,
  signupChanges,
  type SignupChange,
  type SignupMode,
} from "../settings/signup.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type SignupError = "not_found" | "invalid_signup";

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

export function readSignup(
  app: App,
  actor: User | undefined,
): Result<{ signup: SignupMode; changes: SignupChange[] }, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok({ signup: getSignup(app.db), changes: signupChanges(app.db) }) : who;
}

export function changeSignup(
  app: App,
  actor: User | undefined,
  raw: unknown,
): Result<SignupMode, SignupError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const mode = parseSignup(raw);
  if (!mode.ok) return mode;
  setSignup(app.db, mode.value, who.value.id);
  return ok(mode.value);
}
