import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/user",
  summary: "Change your own profile (a session, the password or an admin token); answers the profile",
  auth: true,
  body: { displayName: "string", email: "string", commitEmail: "string" },
  refusals: {
    forbidden: "403: the token is ro or rw; only a session, the password or an admin token may change the profile",
    invalid_commit_email: "`commitEmail` is neither `noreply` nor `account` (422)",
    invalid_email: "`email` is not an address an account may have (422)",
    email_taken: "another account has this `email` (422)",
    display_name_reserved: "`displayName` is a name only the forge, the crew or its owner may wear (422)",
    display_name_mixed_script: "`displayName` mixes alphabets (422)",
  },
};
