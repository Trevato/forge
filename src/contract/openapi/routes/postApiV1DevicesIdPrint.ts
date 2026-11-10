import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/devices/{id}/print",
  summary: "Print the PDF in the request body on a device the app was granted (the app's own token); answers 200 with the job",
  auth: true,
  refusals: {
    forbidden: "403: the app holds no grant on this device",
    rate_limited: "429: the app started more than 10 prints in a minute, or has 2 in flight",
    too_large: "422: the PDF is over the size bound",
    not_pdf: "422: the body is not a PDF",
    too_many_pages: "422: the PDF has more pages than the grant allows",
    pages_unknown: "422: the page count could not be read",
    printer_unreachable: "502: the printer did not answer",
    printer_refused: "502: the printer refused the job",
    unauthorized: "no token",
  },
};
