import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/heartbeat",
  summary:
    "A child forge's signed heartbeat (counts and version, never data); only a child holding the parent's secret may call it, signed in the signature header, and body at most 1 KiB; answers { ok: true }, and every refusal is the same 404 `not_found`",
  auth: false,
  role: "anonymous",
  refusals: { not_found: "the beat is not signed by a child of this forge" },
};
