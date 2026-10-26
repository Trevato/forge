/**
 * A real child forge in its own cell, as `test/spawn-cell.test.ts` drives
 * it. Its own process, because a check sets `FORGE_CELLS=off` for the
 * forges its tests boot (`checks/service.ts`) and the cell probe is asked
 * once per process; the test starts this one without it.
 *
 * The parent holds a finished `cell` ledger for `kid`. The first request
 * is answered before the cell is up; then the cell is awaited and `/` and
 * `/healthz` are carried to it. Printed: one JSON line of what was seen.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { cellCounters, cellsAvailable } from "../../src/apps/contain.ts";
import { cellChildren, stopCellChildren } from "../../src/spawn/cell.ts";
import { answerFromCell } from "../../src/spawn/host.ts";

const cells = await cellsAvailable();
if (!cells.ok) {
  console.log(JSON.stringify({ skipped: cells.reason }));
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "real-child-"));
const parent = createApp({ dataDir, url: "https://f.test" });
const ledger = { name: "kid", bodyId: "cell-real", size: "small" } as const;
mkdirSync(join(dataDir, "spawn"), { recursive: true });
writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ ...ledger, done: true, placement: "cell" }));
const ask = (path: string) => answerFromCell(parent, new Request(`https://kid--f.test${path}`, { headers: { host: "kid--f.test" } }));

try {
  const started = performance.now();
  const first = await ask("/");
  const firstMs = Math.round(performance.now() - started);
  const children = cellChildren(parent);
  const child = await children.start(ledger);
  const root = child === undefined ? null : (await ask("/")).status;
  const health = child === undefined ? null : (await ask("/healthz")).status;
  // The watch reads the cell's tree once a second, by its label.
  await Bun.sleep(1_500);
  console.log(
    JSON.stringify({
      first: first.status,
      firstMs,
      failure: children.failure(ledger.bodyId) ?? null,
      limits: child?.limits ?? null,
      root,
      health,
      labelled: cellCounters().some((c) => c.label === "forge:kid"),
    }),
  );
} finally {
  await stopCellChildren(parent);
  parent.close();
  rmSync(dataDir, { recursive: true, force: true });
}
