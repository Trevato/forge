import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/sync`,
  summary: "Sync a mirror with its origin, or let a fork take its parent's updates (a fork needs a writer)",
  auth: true,
  role: "member",
  refusals: {
    not_a_fork: "404: this repository follows nothing",
    conflict: "409: both sides changed these files; the crew was told",
    moved: "409: something moved while this was read; try again",
  },
};
