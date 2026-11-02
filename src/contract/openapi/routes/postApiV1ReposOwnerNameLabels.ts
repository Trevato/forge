import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/labels`, summary: "Make a label (admin scope, repository admin); `color` is six hex digits and defaults to 6b7280; answers 201 with { id, name, color }", auth: true, body: { name: "string", color: "string" }, status: 201, refusals: { invalid: "422: the name is empty or the color is not six hex digits", taken: "422: a label of that name exists (any case)" } };
