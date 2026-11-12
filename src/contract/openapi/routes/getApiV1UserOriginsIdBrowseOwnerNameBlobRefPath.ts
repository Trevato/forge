import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/blob/{ref}/{path}`,
  summary: "Read one file of a repository the origin holds, live (`path` may span several segments, e.g. src/a/b.ts: send the slashes as they are) (the connecting user only); answers { type, ref, path, size, encoding (utf-8 or base64), content }; a file over the limit answers 413 { type: \"file\", tooLarge: true, size }",
  auth: true,
  role: "member",
  refusals: { ...BROWSE_CODE_REFUSALS, too_large: "413: that is too large to read here" },
};
