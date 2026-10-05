import type { App } from "../../src/app.ts";
import { signUp as signUpAction } from "../../src/actions/users.ts";

/**
 * Prove every account still waiting on its email link. For suites about
 * something else (forks, origins, migration) whose people sign up over
 * HTTP and then make things: verification has its own suite
 * (`test/verify-email.test.ts`), and here it would only be in the way.
 */
export function proveAll(app: App): void {
  app.db
    .query(
      "UPDATE email_check SET verified_at = ?1 WHERE verified_at IS NULL",
    )
    .run(new Date().toISOString());
}

/** `signUp`, with the new account's email already proven. */
export async function signUpProven(
  app: App,
  input: Parameters<typeof signUpAction>[1],
): ReturnType<typeof signUpAction> {
  const made = await signUpAction(app, input);
  if (made.ok) proveAll(app);
  return made;
}
