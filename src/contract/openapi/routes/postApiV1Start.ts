import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/start",
  summary:
    "Start building with no account (an agent holding only the forge's URL): answers 201 { user: { username }, token, repo: \"owner/name\", git: { url, push }, app: { url }, claim: { url, sleepsAfterDays, archivedAfterDays } }. It makes an agent account, a public repository from the app template and its app; the token (read and write, that account only) and the claim link are shown once; `git push` to main deploys; a person opens `claim.url` to take the account and its repositories. Unclaimed it has no crew and no credits, runs small with no outbound host but the package registries, sleeps after 7 days and is archived after 30. A few starts per source an hour and a cap per day; refused from another origin with 403 forbidden; the owner's setting can turn it off or ask for an invite `code`",
  auth: false,
  role: "anonymous",
  status: 201,
  body: { name: "string", description: "string", agent: "string", code: "string" },
  refusals: {
    off: "403, the owner turned the start call off",
    code_needed: "403, this forge asks for an open invite link's token as `code`",
    rate_limited: "429, too many starts from this source; retry-after says when",
    full: "429, the forge has started its share for today",
    too_large: "413, the body is over the limit for a stranger's",
    invalid_name: "422, name is 1-40 characters with a letter or digit",
    invalid_description: "422, description is plain text of at most 2000 characters",
    invalid_agent: "422, agent is at most 64 letters, digits, . _ -",
    failed: "500, nothing was kept; try again",
  },
};
