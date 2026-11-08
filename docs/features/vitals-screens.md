# Screens and sideways scroll in the check's vitals (#9320)

A check's per-look vitals say how many screens tall each look is (`scrollHeight / innerHeight`, one decimal; empty when the look recorded no size) and name any phone look that scrolls sideways (`scrollWidth > innerWidth`).

- Run page: a right-aligned **Screens** column in the vitals table and a muted line under it, `phone /x scrolls sideways`.
- Terminal: the checks line carries the same, `vitals home: LCP …, 2.4 screens; phone: …, 1.1 screens · phone /x scrolls sideways` (`vitalsLine`, `src/checks/progress.ts`).

Report-only: neither can turn a check red. Skipped looks show no screens.

API: `GET /api/v1/repos/:owner/:name/commits/:oid/check` and `GET /api/v1/repos/:owner/:name/pulls/:number/checks` carry `looks: [{look, screens, sideways}]`, from the same file as the run page (a run with no file of its own falls back to the commit's filed looks). `screens` is the one-decimal string (`""` without a size), `sideways` is a boolean; `[]` when there are none or the reader may not read runs.
