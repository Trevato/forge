import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/origin-hook`,
  summary:
    "The origin of a mirror saying a pull moved: a webhook body signed `x-forge-signature-256: sha256=<hmac>` with the secret this forge derived for the mirror; it only names a pull, which is then read again from the origin. Answers 200 { ok }, and 404 for any refusal",
  auth: false,
};
