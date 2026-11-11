/**
 * The roll rehearsal (#873): its plain parts. The two short real rolls of
 * two forge processes on one data directory are `rehearsal-real.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORT_RETRIES } from "../src/kernel/port.ts";
import { rehearse } from "../scripts/rehearse-roll.ts";
import {
  count,
  DEFAULTS,
  emptyTally,
  goneLine,
  OUTPUT_TAIL_LINES,
  isRefusal,
  judge,
  missLine,
  parseArgs,
  refusals,
  report,
  Rotation,
  SILENT_PROBES_TO_LEAVE,
} from "../scripts/rehearsal.ts";

describe("arguments", () => {
  test("defaults roll this checkout onto itself, a minute long, at the chart's probe period", () => {
    const a = parseArgs([], "/here");
    expect(a).toEqual({
      from: null,
      old: "/here",
      next: "/here",
      seconds: 60,
      probeMs: 5000,
      lingerS: 10,
      concurrency: 4,
      paths: [...DEFAULTS.paths],
      json: false,
    });
  });

  test("each flag is read once and checked", () => {
    const a = parseArgs(
      ["--from", "/snap", "--old", "/v1", "--new", "/v2", "--seconds", "5", "--paths", "/,/x", "--json"],
      "/here",
    );
    expect([a.from, a.old, a.next, a.seconds, a.paths, a.json]).toEqual([
      "/snap",
      "/v1",
      "/v2",
      5,
      ["/", "/x"],
      true,
    ]);
    expect(() => parseArgs(["--seconds", "1"], "/")).toThrow("--seconds is 2 to 3600");
    expect(() => parseArgs(["--linger", "1.5"], "/")).toThrow("whole number");
    expect(() => parseArgs(["--paths", "http://elsewhere/"], "/")).toThrow("not a plain path");
    expect(() => parseArgs(["--seconds", "3", "--seconds", "4"], "/")).toThrow("given twice");
    expect(() => parseArgs(["--evil"], "/")).toThrow("unknown argument");
    expect(() => parseArgs(["--from"], "/")).toThrow("wants a value");
  });
});

describe("rotation", () => {
  test("a forge joins on a ready probe, leaves on a not-ready one, and is asked in turn", () => {
    const r = new Rotation<string>();
    expect(r.next()).toBeNull();
    r.saw("old", true);
    r.saw("old", true);
    expect([r.next(), r.next()]).toEqual(["old", "old"]);
    r.saw("new", true);
    expect(new Set([r.next(), r.next()])).toEqual(new Set(["old", "new"]));
    r.saw("old", false);
    expect([r.next(), r.next(), r.has("old")]).toEqual(["new", "new", false]);
  });

  test("a silent probe is a busy machine: a member leaves only after three in a row (#2453)", () => {
    const r = new Rotation<string>();
    r.saw("old", "ready");
    for (let i = 1; i < SILENT_PROBES_TO_LEAVE; i++) r.saw("old", "silent");
    r.saw("old", "ready");
    for (let i = 1; i < SILENT_PROBES_TO_LEAVE; i++) r.saw("old", "silent");
    expect(r.has("old")).toBe(true);
    r.saw("old", "silent");
    expect(r.has("old")).toBe(false);
    // Silence never lets anyone in; a not-ready answer sends a member out at once.
    r.saw("new", "silent");
    expect(r.has("new")).toBe(false);
    r.saw("new", "ready");
    r.saw("new", "not-ready");
    expect(r.has("new")).toBe(false);
  });
});

describe("the verdict", () => {
  const rolled = { newInRotationMs: 3000, oldOutOfRotationMs: 1000, oldExitMs: 10_000 };

  test("a 5xx, a refused connection and nobody in rotation are refusals; a 4xx or redirect is not", () => {
    expect([500, 502, 503, "refused", "nobody"].every((o) => isRefusal(o as never))).toBe(true);
    expect([200, 302, 404].some((o) => isRefusal(o))).toBe(false);
  });

  test("a slow answer is not a refusal, but every miss is kept with its moment", () => {
    expect(isRefusal("slow")).toBe(false);
    const t = emptyTally();
    const at = { atMs: 1234, code: "TimeoutError", forges: { old: "draining", new: "serving" } };
    count(t, "old", 200, at);
    count(t, "new", "slow", at);
    count(t, null, "nobody", { ...at, code: null });
    expect(refusals(t)).toBe(1);
    expect(t.misses.map((m) => [m.forge, m.outcome])).toEqual([
      ["new", "slow"],
      [null, "nobody"],
    ]);
    expect(missLine(t.misses[0]!)).toBe(
      "miss       1234 ms new: slow (TimeoutError); old draining, new serving",
    );
    expect(report(judge(t, rolled))).toContain("nobody in rotation: nobody; old draining");
  });

  test("zero refused over a roll that happened is a pass", () => {
    const t = emptyTally();
    count(t, "old", 200);
    count(t, "new", 302);
    const v = judge(t, rolled);
    expect(v.ok).toBe(true);
    expect(report(v)).toContain("zero refused: 2 requests");
  });

  test("one refusal fails it, and the report counts it", () => {
    const t = emptyTally();
    count(t, "old", 200);
    count(t, "old", "refused");
    count(t, "new", 503);
    expect(refusals(t)).toBe(2);
    const v = judge(t, rolled);
    expect(v.ok).toBe(false);
    expect(report(v)).toContain("2 of 3 requests refused");
  });

  test("a rehearsal that rolled nothing has no verdict", () => {
    const t = emptyTally();
    count(t, "old", 200);
    expect(judge(t, { ...rolled, newInRotationMs: null }).problem).toBe(
      "the new forge never became ready",
    );
    expect(judge(t, { ...rolled, oldExitMs: null }).ok).toBe(false);
    expect(judge(emptyTally(), rolled).problem).toBe("no request was sent");
  });
});

describe("a forge that does not come up says which, where and why", () => {
  const base = {
    name: "old" as const,
    pid: 4242,
    port: 39001,
    exitCode: 1,
    signal: null,
    waitedMs: 112,
    portsLost: 0,
    output: "booting\nerror: database is locked\n",
    log: "/tmp/r/old-0.log",
  };

  test("its process, port, exit and wait, then the end of what it wrote", () => {
    expect(goneLine(base)).toBe(
      "the old forge (pid 4242, port 39001) exited with code 1 112 ms after it started; " +
        "it wrote (/tmp/r/old-0.log):\nbooting\nerror: database is locked",
    );
  });

  test("a signal, a forge still not ready, lost ports and silence are each said", () => {
    expect(goneLine({ ...base, exitCode: null, signal: "SIGKILL" })).toContain("was ended by SIGKILL");
    const slow = goneLine({ ...base, exitCode: null, waitedMs: 60_004, portsLost: 1, output: "" });
    expect(slow).toBe(
      "the old forge (pid 4242, port 39001) was still not ready 60004 ms after it started, " +
        "after losing 1 port to other processes; it wrote nothing; see /tmp/r/old-0.log",
    );
  });

  test("only the last lines are quoted", () => {
    const output = Array.from({ length: OUTPUT_TAIL_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const line = goneLine({ ...base, output });
    expect(line).not.toContain("line 4\n");
    expect(line).toContain("line 5\n");
    expect(line.endsWith(`line ${OUTPUT_TAIL_LINES + 4}`)).toBe(true);
  });
});

describe("rehearse: a forge that dies at boot", () => {
  // A checkout whose src/main.ts is only `body`: no real forge is started.
  const rehearseWith = async (body: string): Promise<string> => {
    const checkout = mkdtempSync(join(tmpdir(), "forge-rehearsal-checkout-"));
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "main.ts"), body);
    try {
      await rehearse({ ...parseArgs([], checkout), seconds: 2, probeMs: 100, lingerS: 0, concurrency: 1 });
      return "it came up";
    } catch (error) {
      return (error as Error).message;
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  };

  test("is named with its port, exit code and last words", async () => {
    const message = await rehearseWith('console.error("cannot open FORGE_DATA"); process.exit(3);');
    expect(message).toMatch(/^the old forge \(pid \d+, port \d+\) exited with code 3 \d+ ms after it started; it wrote/);
    expect(message).toContain("cannot open FORGE_DATA");
  }, 30_000);

  test("one that lost its port to another process is started on a fresh one, a bounded number of times", async () => {
    const message = await rehearseWith(
      'console.error(`Failed to start server. Is port ${process.env.PORT} in use?`); process.exit(1);',
    );
    expect(message).toContain(`after losing ${PORT_RETRIES} ports to other processes`);
    expect(message).toMatch(/Is port \d+ in use\?$/);
  }, 30_000);
});
