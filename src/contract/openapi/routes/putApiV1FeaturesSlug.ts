import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/features/{slug}",
  summary: "Absorb an app that declares a feature (a site admin's admin scope token): it joins the forge's nav and its settings are kept by the forge; absorbing again changes nothing; answers the feature",
  auth: true,
  role: "admin",
  refusals: {
    not_found: "no such app, or one you may not read",
    forbidden: "you are not a site admin (403)",
    not_a_feature: "the app's forge.json declares no feature, or declares it wrongly (422)",
  },
};
