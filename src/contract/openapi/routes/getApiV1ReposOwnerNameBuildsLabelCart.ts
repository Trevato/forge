import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/builds/{label}/cart`,
  summary: "A pin's cart: { label, oid, demo, capture, play_url, art_url }; capture.state is none, capturing, done or failed, and play_url is set once the page is captured",
  auth: false,
};
