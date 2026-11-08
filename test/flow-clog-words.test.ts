/** The clog's one sentence (#6517). */
import { describe, expect, test } from "bun:test";
import { clogSays } from "../src/flow/clog_words.ts";

const full = { reasons: [], conflictedApproved: 60, hottest: { path: "src/app.ts", pulls: 61 }, strandedUsd: 123.4 };

describe("clogSays", () => {
  test("the full sentence", () => {
    expect(clogSays(full)).toBe("Clogged: 60 approved pulls conflict; 61 open pulls touch src/app.ts. $123 of crew work is waiting to land.");
  });
  test("reasons lead, as given", () => {
    expect(clogSays({ ...full, reasons: ["main is red"] })).toStartWith("Clogged: main is red; 60 approved");
  });
  test("each part is left out when missing or 0", () => {
    expect(clogSays({ ...full, conflictedApproved: 0 })).toBe("Clogged: 61 open pulls touch src/app.ts. $123 of crew work is waiting to land.");
    expect(clogSays({ ...full, hottest: undefined })).toBe("Clogged: 60 approved pulls conflict. $123 of crew work is waiting to land.");
    expect(clogSays({ ...full, hottest: { path: "a", pulls: 0 } })).not.toContain("touch");
    expect(clogSays({ ...full, strandedUsd: 0 })).toBe("Clogged: 60 approved pulls conflict; 61 open pulls touch src/app.ts.");
    expect(clogSays({ reasons: [] })).toBe("");
  });
  test("dollars round to whole dollars and one pull reads singular", () => {
    expect(clogSays({ reasons: [], strandedUsd: 9.5 })).toBe("$10 of crew work is waiting to land.");
    expect(clogSays({ reasons: [], conflictedApproved: 1 })).toBe("Clogged: 1 approved pull conflicts.");
  });
  test("the path is kept as given", () => {
    expect(clogSays({ reasons: [], hottest: { path: "a<b>&.ts", pulls: 2 } })).toContain("touch a<b>&.ts.");
  });
  test("stays under 160 characters", () => {
    const long = { reasons: ["x".repeat(200)], conflictedApproved: 600, hottest: { path: "d/".repeat(80), pulls: 61 }, strandedUsd: 12345 };
    expect(clogSays(long).length).toBeLessThanOrEqual(160);
    expect(clogSays(full).length).toBeLessThan(160);
  });
});
