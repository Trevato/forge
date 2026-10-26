import { describe, expect, test } from "bun:test";
import { conflictRoom } from "../src/crew/conflict_room.ts";

describe("conflictRoom: the sweep starts no more pushes than the check lane has slots for (#4459)", () => {
  test("an idle lane takes one run per slot", () => {
    expect(conflictRoom(4, 0, 0)).toBe(4);
  });

  test("checks queued or running and runs in flight each take a slot", () => {
    expect(conflictRoom(4, 1, 0)).toBe(3);
    expect(conflictRoom(4, 1, 2)).toBe(1);
    expect(conflictRoom(4, 2, 2)).toBe(0);
  });

  test("a full lane still lets one run through when none is in flight", () => {
    expect(conflictRoom(1, 14, 0)).toBe(1);
    expect(conflictRoom(4, 14, 1)).toBe(0);
  });
});
