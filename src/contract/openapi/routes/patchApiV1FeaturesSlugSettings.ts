import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/features/{slug}/settings",
  summary: "Change an absorbed app's settings, `{ settings: { name: value } }` (a site admin's admin scope token): every value is checked against its declared type first, and one that does not fit changes nothing; the app restarts reading each as FORGE_SETTING_<NAME>; answers the feature",
  auth: true,
  body: { settings: "object" },
  refusals: {
    not_found: "no such app, or one you may not read",
    forbidden: "you are not a site admin (403)",
    not_absorbed: "the app is not absorbed (409)",
    invalid_setting: "a setting is unknown or its value does not fit; the message names it (422)",
  },
};
