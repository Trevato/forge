# Screens and sideways scroll in the check's vitals (#9320)

A check's per-look vitals say how many screens tall each look is (`scrollHeight / innerHeight`, one decimal; empty when the look recorded no size) and name any phone look that scrolls sideways (`scrollWidth > innerWidth`).

- Run page: a right-aligned **Screens** column in the vitals table and a muted line under it, `phone /x scrolls sideways`.
- Terminal: the checks line carries the same, `vitals home: LCP …, 2.4 screens; phone: …, 1.1 screens · phone /x scrolls sideways` (`vitalsLine`, `src/checks/progress.ts`).

Report-only: neither can turn a check red. Skipped looks show no screens.
