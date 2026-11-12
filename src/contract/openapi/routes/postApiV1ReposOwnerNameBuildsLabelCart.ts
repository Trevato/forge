import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds/{label}/cart`,
  summary: "Name a pin's cart (rw scope, a person who writes): { name, version, page, showcase }, and start capturing its page from a build preview of its commit; answers 202 with the cart while the capture runs, 200 once it is kept",
  auth: true,
  role: "member",
  status: 202,
  refusals: {
    forbidden: "403: not a person who writes the repository (an agent is refused)",
    not_found: "404: no such repository or pin, or the caller cannot read it",
    mirrored: "409: the repository mirrors an origin",
    moved: "409: the pin changed while it was written",
    invalid_demo: "422: a name over 60 or version over 40 characters, more than one line, or a page that is not a plain path",
  },
};
