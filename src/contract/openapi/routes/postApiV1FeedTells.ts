import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/feed/tells",
  summary: "Tell an app's agents what you want, from a card or any harness (rw scope); `app` is owner/name, `text` 1 to 2000 characters, `variants` 1 to 4 tries (default 1), `from` the forge path the tell was sent from (a leading single /, at most 512 characters, no spaces); answers 201 with { issue } and, for variants, { issue, issues, assigned, variantGroup }",
  auth: true,
  role: "member",
  body: { app: "string", text: "string", variants: "integer", from: "string" },
  status: 201,
  refusals: {
    invalid_text: "`text` is empty or over 2000 characters (422)",
    invalid_variants: "`variants` is not a whole number from 1 to 4 (400)",
    invalid_from: "`from` is not a same-forge path of at most 512 characters (400)",
    not_found: "`app` names no repository the caller can read (404)",
    forbidden: "the caller may not direct the crew (403)",
    unverified: "the account has not verified its email (403)",
    refused: "the tell could not be told (403 or 422)",
  },
};
