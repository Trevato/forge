import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { checkKey, provenBy, recordProven, type KeyInputs } from "../src/checks/proven.ts";
import { migrations } from "../src/core/schema.ts";

const inputs: KeyInputs = {
  repoId: "r1",
  treeOid: "a".repeat(40),
  command: "bun test",
  install: null,
  timeout: 600,
  egress: ["b.example", "a.example"],
  limits: { memory: 1 },
};

describe("a check's key (#1795)", () => {
  test("equal inputs give equal keys, whatever the egress order", () => {
    expect(checkKey({ ...inputs, egress: ["a.example", "b.example"] })).toBe(
      checkKey(inputs),
    );
  });

  test("each input changes the key; another repository never shares one", () => {
    const base = checkKey(inputs);
    const changed: Partial<KeyInputs>[] = [
      { repoId: "r2" },
      { treeOid: "b".repeat(40) },
      { command: "bun test --bail" },
      { install: "bun install" },
      { timeout: 601 },
      { egress: [] },
      { limits: { memory: 2 } },
      { base: "c".repeat(40) },
      { learned: "test/x.test.ts" },
    ];
    for (const change of changed)
      expect(checkKey({ ...inputs, ...change })).not.toBe(base);
  });

  test("the first prover of a key is kept", () => {
    const db = new Database(":memory:");
    for (const sql of migrations) db.exec(sql);
    const key = checkKey(inputs);
    expect(provenBy(db, key)).toBeUndefined();
    recordProven(db, key, "run-1");
    recordProven(db, key, "run-2");
    expect(provenBy(db, key)).toBe("run-1");
  });
});
