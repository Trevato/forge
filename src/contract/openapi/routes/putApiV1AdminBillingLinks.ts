import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/billing/links",
  summary: "Replace the payment links a buyer pays at, one per size (a person admin's token, admin scope); with any set the home page offers paid forges; answers { links }",
  auth: true,
  role: "admin",
  body: { links: "object of small, medium and large, each an https URL or empty; a size left out has none" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    invalid_billing_links: "a link is not an https URL, or a size is unknown (422)",
  },
};
