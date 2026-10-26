import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/feed/chips",
  summary: "Switch a chip off (`hidden` true) or on (rw scope): `kind` is `kind` with a kind of post as `value`, or `person` with a username; answers { kinds, people }",
  auth: true,
  body: { kind: "string", value: "string", hidden: "boolean" },
  refusals: {
    invalid_hidden: "hidden is not true or false (422)",
    invalid_chip: "`kind` is neither `kind` nor `person`, or that kind of post has no chip (422)",
    not_found: "no such person, or an organization",
  },
};
