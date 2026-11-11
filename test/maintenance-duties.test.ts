/** /maintenance and the MCP say, per duty, when it last ran, what it found and when it is overdue. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duties, GRACE_MS } from "../src/maintenance/duties.ts";
import { writeLast } from "../src/nightly/stamps.ts";

const DAY = 86_400_000;
const at = (iso: string): number => Date.parse(iso);

test("never run, fresh and overdue, with a fake clock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-duties-"));
  try {
    const now = at("2026-11-10T12:00:00Z");
    const never = duties(dir, now);
    expect(never.map((d) => d.name)).toEqual(["flake-hunt", "outside-gate", "pack-compat", "radar"]);
    expect(never.every((d) => d.lastRun === "never" && !d.overdue)).toBe(true);
    expect(never[0]!.says).toBe("flake-hunt: never run; its slot is 02:17 UTC each night.");

    const slot = at("2026-11-10T05:07:00Z");
    writeLast(dir, "radar", { slot, startedAt: slot + 1000, finishedAt: slot + 5000, says: "read 3 repositories; filed nothing." });
    writeLast(dir, "flake-hunt", { slot: at("2026-11-10T02:17:00Z"), startedAt: at("2026-11-10T02:17:30Z"), finishedAt: at("2026-11-10T04:00:00Z"), says: "filed 2 flakes." });
    const fresh = duties(dir, now);
    expect(fresh[3]!.says).toBe("radar: last ran 2026-11-10 05:07 UTC; nothing found.");
    expect(fresh[0]!.says).toBe("flake-hunt: last ran 2026-11-10 02:17 UTC; filed 2 flakes.");
    expect(fresh[3]!.overdue).toBe(false);

    const later = slot + DAY + GRACE_MS + 1;
    const late = duties(dir, later);
    expect(late[3]!.overdue).toBe(true);
    expect(late[3]!.says).toBe("radar: last ran 2026-11-10 05:07 UTC; nothing found; overdue.");
    expect(duties(dir, slot + DAY + GRACE_MS)[3]!.overdue).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
