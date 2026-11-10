import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/users",
  summary:
    "Sign up: while the forge takes requests (signup `request`) answers 202 { state: 'waiting', username, message } and the account waits for an admin to allow it; otherwise answers 201 with the new account { id, username, displayName, isAdmin, commitEmail }, never the admin; `email` is optional; `invite` is an invite link's token, `turnstile_token` the human check when the forge asks for one; refused from another origin with 403 forbidden",
  auth: false,
  role: "anonymous",
  status: 201,
  body: { username: "string", email: "string", password: "string", invite: "string", note: "string", from: "string", turnstile_token: "string" },
  refusals: {
    rate_limited: "429, too many sign-ups; retry-after says when",
    too_large: "413, the body is over the limit for a stranger's",
    signup_closed: "403, this forge makes no new accounts (or the invite is not one)",
    forbidden: "403, the name is not one this edge allows",
    passkey_required: "422, this forge signs up with a passkey on the web page",
    human_check: "422, the human check failed",
    invalid_username: "422, not a name an account may have",
    invalid_email: "422, not an email address",
    weak_password: "422, the password is too short",
    password_too_long: "422, the password is over the cap",
    username_taken: "422, another account has the name",
    username_reserved: "422, the name is reserved",
    email_taken: "422, another account has the address",
  },
};
