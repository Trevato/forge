import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/devices/{id}/print",
  summary: "Print the PDF (application/pdf) or PWG raster (image/pwg-raster, up to 80 MB, 20 pages) in the request body on a device the app was granted (the app's own token); answers 200 with the job",
  auth: true,
  role: "member",
  refusals: {
    forbidden: "403: the app holds no grant on this device",
    rate_limited: "429: the app started more than 10 prints in a minute, or has 2 in flight",
    too_large: "422: the PDF is over the size bound",
    not_pdf: "422: the body is not a PDF",
    too_many_pages: "422: the PDF has more pages than the grant allows",
    pages_unknown: "422: the page count could not be read",
    not_raster: "422: the body does not begin with the PWG raster sync word RaS2",
    raster_truncated: "422: a PWG raster page header or its lines are cut short",
    raster_unsupported: "422: a PWG raster page has a format the forge cannot read",
    raster_resolution_refused: "422: the printer's pwg-raster-document-resolution-supported does not list the page's resolution",
    raster_type_refused: "422: the printer's pwg-raster-document-type-supported does not list the page's type",
    printer_unreachable: "502: the printer did not answer",
    printer_refused: "502: the printer refused the job",
    unauthorized: "no token",
  },
};
