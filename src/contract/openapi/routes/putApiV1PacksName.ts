import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/packs/{name}",
  summary: "Curate a pack (a person admin's token, rw scope): the fields sent replace the pack's, a new {name} makes it (201); repos is the ordered list of owner/name, at most 20; every change is kept with who and when; answers the pack",
  auth: true,
  role: "admin",
  body: { title: "string, at most 80", pitch: "string, at most 300", brief: "string, at most 4000", repos: "list of owner/name" },
  refusals: {
    forbidden: "the caller is not a site admin who is a person (403)",
    invalid: "a field is the wrong shape, or a repo is not owner/name (422)",
    not_found: "no such pack (404)",
  },
};
