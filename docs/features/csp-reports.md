# Content-Security-Policy reports

Every page the forge renders carries `report-uri /csp-report` and `report-to csp` in its policy, with a `Reporting-Endpoints: csp="/csp-report"` header. The bare floor policy that `securityFloor` puts on non-document answers does not name it: the floor also covers an app's proxied responses, and a relative address there would resolve to the app's host, where no report could be counted. When a browser blocks something it posts a report there, so a broken or hostile page is seen, not guessed.

`POST /csp-report` (`src/http/csp_report.ts`) takes `application/csp-report`, `application/reports+json` or `application/json`, at most 8 KB, in either the `report-uri` or the Reporting API shape. Anything else gets a 4xx and nothing is stored. It keeps only the directive, the blocked host (no path, no query string) and the page's path, as one count per UTC hour in `csp_violation` (its `day` column holds `YYYY-MM-DDTHH`), so a window's count holds only reports from the window's whole hours, never a report older than it. That is at most 500 rows a UTC day (the rest fold into one row) and 30 days kept. Anonymous callers are limited to 30 a minute each and 600 a minute per forge. It answers 204.

`/settings/security` shows one line, "Blocked by the page policy, 7 days", listing counts by directive. When nothing was blocked, the line is not shown. The terminal's Security controls screen (admin only) lists the same weekly counts, one row per directive below the controls, and none when nothing was blocked.

# Script errors

The page-view beacon also reports uncaught script errors (`error` and `unhandledrejection`) to `POST /_script-error` (`src/http/script_errors.ts`), so a page that throws is seen, not guessed (#11447).

- **Reported:** the page's path, the same-origin script's path (no query string, never another origin's) and line, and the message's first line cut to 120 characters. Up to 5 per page view. Under Do-Not-Track or the `forge_measure=off` cookie the beacon registers no listener and the server drops the report too.
- **Refused:** anything over 2 KB (counted by bytes read), another shape, a cross-origin `Origin`, an unknown page. Nothing is stored for those.
- **Kept:** one count per page, place, message and UTC hour, with bounded rows a day, for 30 days.
- **Shown:** `/settings/security` ("Script errors on pages, 7 days"), the terminal's Security controls screen (one row per error, below the policy rows), and the MCP `system` tool's `csp` kind. All admin only.
- **Not for spawned apps:** their copy of the beacon posts to the app's own `/_script-error`, which the forge proxy does not carry, so errors on a spawned app's pages are not counted. Only the forge's own pages are.
