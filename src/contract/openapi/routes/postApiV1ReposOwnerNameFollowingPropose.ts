import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/following/propose`,
  summary: "Open a pull on the parent with what the fork is ahead by; answers { number, opened, changes, title }",
  auth: true,
  role: "member",
  refusals: {
    not_a_fork: "404: this repository follows nothing",
    nothing_to_propose: "409: nothing here is ahead of the parent",
    refused: "409: the parent refused, with the reason",
  },
};
