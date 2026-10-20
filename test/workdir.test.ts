import { describe, expect, test } from "bun:test";
import { removeClone } from "../src/crew/workdir.ts";

describe("removing a clone", () => {
  test("a removal that fails twice is tried again, and the loop turns between tries", async () => {
    let calls = 0;
    let turned = false;
    // Runs on the loop's next turn: only if a retry waits without blocking.
    const turn = new Promise<void>((resolve) =>
      setImmediate(() => {
        turned = true;
        resolve();
      }),
    );
    let turnedBeforeSecondTry = false;
    await removeClone("/x", 5, 5, async () => {
      if (++calls === 2) turnedBeforeSecondTry = turned;
      if (calls < 3) throw new Error("ENOTEMPTY");
    });
    await turn;
    expect(calls).toBe(3);
    expect(turnedBeforeSecondTry).toBe(true);
  });

  test("a clone that will not go rejects with the last error after the tries", async () => {
    let calls = 0;
    const gone = removeClone("/x", 3, 1, async () => {
      calls++;
      throw new Error("ENOTEMPTY");
    });
    await expect(gone).rejects.toThrow("ENOTEMPTY");
    expect(calls).toBe(3);
  });
});
