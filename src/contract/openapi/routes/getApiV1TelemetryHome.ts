import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/telemetry/home",
  summary:
    "Read the figures the home is scored against: landed in 24 h; live {sha, version}, the commit this process runs (null when unstamped); main {sha}, the head of the forge's own repository's default branch, and behind {commits, pulls}, what main holds that live does not (0 and 0 when they match; both null until the forge has read its own main); builders and why idle, spend against the ceiling, what waits on the caller; the owner or an agent holding telemetry:read, with a ro token; every agent read is logged",
  auth: true,
  role: "member",
  reply: { landed: "integer", live: "object", main: "object", behind: "object", builders: "object", spend: "object", waiting: "object" },
};
