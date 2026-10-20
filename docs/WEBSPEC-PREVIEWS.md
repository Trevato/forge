# Website spec on previews (report-only)

Once a pull's preview is live (after the swap-in, beside its tests), the
forge runs `webspec()` (`src/release/webspec.ts`) over the paths of
forge.json's `app.looks` against the preview's own port, with the smoke
proof's 30 s patience (`src/apps/preview_spec.ts`). What it finds is stored
per deploy run (`preview_finding`) and shown on the pull page under the
checks line (and ends the checks row of the terminal's pull screen): a count and,
folded, one row per finding with its specification.website section. A finding
marked `edge` is one the CDN or edge in front of the app owns; it is counted
apart, never as the app's. The preview is checked over plain http on loopback,
so the https-only findings (HSTS) do not arise.

It is **report-only**: findings never fail a deploy or the check. A
`webspec()` that throws or times out is recorded as one finding and the
preview stays up. The line under the checks line updates on a page load, not
on the live beat.

## Turning the gate on

The gate turns failing after a week of green: when a week of previews has
come back with no findings that are the app's to fix. To turn it on, in
`src/apps/runtime.ts` where `checkPreview` is called, await it before the
run is finished and, when `previewFindings()` holds a finding without
`edge`, finish the run `failed` with `summary: "website spec: <n> findings"`.
