import type { App } from "../../src/app.ts";
import { createSession } from "../../src/core/sessions.ts";
import { createUser, type CreateUserError, type User } from "../../src/core/users.ts";
import type { Result } from "../../src/kernel/result.ts";

interface AdminInput {
  username: string;
  email: string;
  password?: string;
  displayName?: string;
}

/**
 * The site admin a suite starts from. No sign-up makes one, not even a
 * forge's first (`test/no-signup-admin.test.ts`): the operator's first-admin
 * link or a claim does, and a suite sets its forge up directly, as `seed`.
 * Proven, as the operator's admin is.
 */
export function seedAdmin(app: App, input: AdminInput): Promise<Result<User, CreateUserError>> {
  return createUser(app.db, { ...input, origin: "seed", isAdmin: true, trusted: true });
}

/** `seedAdmin`, signed in: the session cookie its browser carries. */
export async function adminCookie(app: App, input: AdminInput): Promise<string> {
  const made = await seedAdmin(app, input);
  if (!made.ok) throw new Error(`no admin: ${made.error}`);
  return `forge_session=${createSession(app.db, made.value.id).token}`;
}
