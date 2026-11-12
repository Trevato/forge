# Security controls

Each safeguard of `docs/ops/RED-TEAM.md`, and when it was last tested. A site
admin sees it at `/settings/security/controls` (linked from Security) and in
the terminal as the palette command "Security controls". Anyone else gets a 404
on the page and is offered nothing in the terminal. Read-only.

## Where the times come from

`<FORGE_DATA>/security-report.json`, the file the Security page reads, written
whole by the timer outside the forge. Per control, first match wins:

1. An entry in the optional `controls` list: `{ "id": "app-env", "at": "<ISO date>", "ok": true }`.
   Ids: `app-env`, `identity-headers`, `edge-secret`, `crew-sandbox`,
   `injection-marking`, `pod-security`. Unknown ids, duplicates, a bad date or a
   non-boolean `ok` are ignored.
2. For the five controls a test file keeps: the report's own `at`, passing when
   `selfTest.failed` is 0. The timer's self-test runs those tests, so existing
   reports already give a time.
3. Otherwise "No check recorded". Pod security is kept in the cluster's source,
   so only a `controls` entry written by whatever checks the cluster gives it a time.

A line says "Failed" when `ok` is false and "Out of date" when the check is
more than 8 days old; both use one badge. Hover a name for what it holds and
what keeps it.

## Code

`src/checks/controls.ts` (the list and the reading), `src/web/pages/security_controls.ts`,
`src/tui/screens/controls.ts`. Tests: `test/security-controls.test.ts`.
