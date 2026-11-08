import { REPO, SHOT_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds/{label}/shots`,
  summary: "Upload a screenshot to a pin (rw scope, a person who writes): multipart/form-data with the picture as `shot` (PNG, JPEG or WebP by its first bytes, at most 2 MB) and an optional `caption` (one line, at most 140 characters); answers 201 with the list",
  auth: true,
  status: 201,
  refusals: { ...SHOT_REFUSALS, invalid_shot: "422: not a PNG, JPEG or WebP picture", too_large: "413: over 2 MB", too_many: "409: the pin holds 12 screenshots", invalid_caption: "422: more than one line or 140 characters" },
};
