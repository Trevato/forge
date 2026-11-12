/**
 * The placement policy (#509): owned metal first, a preview spills to cloud
 * at the slider's threshold, production only when owned is full, an app's
 * preference honoured unless it asks for full metal, and with no cloud body
 * every answer is owned — with the reason saying a burst queues.
 */
import { describe, expect, test } from "bun:test";
import { NO_CLOUD_BODY, parseNodeLabel, placeFor, type PlacementInput } from "../src/core/placement_policy.ts";
import { bodyTarget } from "../src/spawn/placement.ts";

const at = (over: Partial<PlacementInput>): PlacementInput => ({
  ownedUsed: 5,
  ownedCapacity: 10,
  spillAtOwnedUse: 0.85,
  alwaysOn: false,
  preference: null,
  cloudBody: true,
  ...over,
});

describe("placeFor", () => {
  test("below the threshold a preview stays owned", () => {
    const d = placeFor(at({ ownedUsed: 8 }));
    expect(d.where).toBe("owned");
    expect(d.reason).toBe("Owned metal is at 80%, below the 85% threshold.");
  });

  test("at or above the threshold a preview spills first; production stays owned", () => {
    const preview = placeFor(at({ ownedUsed: 9 }));
    expect(preview.where).toBe("cloud");
    expect(preview.reason).toContain("A preview spills first");
    expect(placeFor(at({ ownedUsed: 9, alwaysOn: true })).where).toBe("owned");
  });

  test("full owned spills production too", () => {
    expect(placeFor(at({ ownedUsed: 10, alwaysOn: true })).where).toBe("cloud");
    expect(placeFor(at({ ownedUsed: 0, ownedCapacity: 0, alwaysOn: true })).where).toBe("cloud");
  });

  test("at 100% (slider 0) nothing spills until owned is full", () => {
    expect(placeFor(at({ ownedUsed: 9, spillAtOwnedUse: 1 })).where).toBe("owned");
    expect(placeFor(at({ ownedUsed: 10, spillAtOwnedUse: 1 })).where).toBe("cloud");
  });

  test("a preference is honoured unless metal is asked for and owned is full", () => {
    expect(placeFor(at({ ownedUsed: 0, preference: "cloud" })).where).toBe("cloud");
    expect(placeFor(at({ ownedUsed: 9, preference: "metal" })).where).toBe("owned");
    expect(placeFor(at({ ownedUsed: 10, preference: "metal" })).where).toBe("cloud");
  });

  test("an unbounded owned capacity is never full", () => {
    const d = placeFor(at({ ownedUsed: 1_000, ownedCapacity: Infinity }));
    expect(d.where).toBe("owned");
    expect(d.reason).toBe("Owned metal has room, below the 85% threshold.");
  });

  test("with no cloud body every decision is owned, and says a burst queues", () => {
    for (const over of [{ ownedUsed: 9 }, { ownedUsed: 10 }, { preference: "cloud" as const }, { ownedCapacity: 0 }]) {
      const d = placeFor(at({ ...over, cloudBody: false }));
      expect(d.where).toBe("owned");
      expect(d.reason).toContain(NO_CLOUD_BODY);
    }
    expect(placeFor(at({ ownedUsed: 10, cloudBody: false })).reason).toBe(
      "Owned metal is full and there is no cloud body: bursts queue.",
    );
  });
});

describe("the owned-node label", () => {
  test("parses key=value node labels and refuses anything else", () => {
    for (const ok of ["plat.sh/site=vxrail", "site=home", "zone=", " a=b "]) expect(parseNodeLabel(ok)).toBe(ok.trim());
    for (const no of ["vxrail", "=x", "a b=c", "Plat.SH/site=x", "a=b c", "a=-x", 3, null, `a=${"x".repeat(64)}`])
      expect(parseNodeLabel(no)).toBeUndefined();
  });

  test("is passed to the body for owned, and not for cloud", () => {
    expect(bodyTarget("owned", "site=home")).toEqual({ where: "owned", nodeLabel: "site=home" });
    expect(bodyTarget("cloud", "site=home")).toEqual({ where: "cloud" });
  });
});
