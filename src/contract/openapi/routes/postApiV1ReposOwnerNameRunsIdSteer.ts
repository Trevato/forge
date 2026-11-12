import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/runs/{id}/steer`,
  summary: "Say something to an agent's run (rw scope; a verified person with write access, not an agent); a running agent hears it as its next turn, otherwise it lands as a comment on the issue or pull; answers { outcome: sent | commented }",
  auth: true,
  role: "member",
  body: { text: "string" },
  refusals: {
    empty: "`text` is empty (422)",
    not_agent: "the run is not an agent's (422)",
    unverified: "verify your email first (403)",
    forbidden: "the caller is an agent (403)",
  },
};
