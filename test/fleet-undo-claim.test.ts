/**
 * An undo is claimed once (#6762): `claimUndo` takes a recorded operation,
 * `releaseUndo` gives it back when the undo came to nothing, and a finished
 * undo stays finished.
 */
import { expect, test } from "bun:test";
import {
  claimUndo,
  getOperation,
  recordOperation,
  releaseUndo,
  settleUndo,
} from "../src/core/fleet_ops.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

function recorded() {
  const db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u','u@x','x')");
  const op = recordOperation(db, {
    actorId: "u1",
    query: "is:repo",
    kind: "repo",
    verb: "set",
    value: "x",
    reversible: true,
    undoOf: null,
    rows: [],
  });
  return { db, op };
}

test("the first claim wins and a second is refused", () => {
  const { db, op } = recorded();
  expect(claimUndo(db, op.id)).toBe(true);
  expect(claimUndo(db, op.id)).toBe(false);
});

test("a released claim can be taken again", () => {
  const { db, op } = recorded();
  expect(claimUndo(db, op.id)).toBe(true);
  releaseUndo(db, op.id);
  expect(getOperation(db, op.id)!.undoneBy).toBeNull();
  expect(claimUndo(db, op.id)).toBe(true);
});

test("a finished undo is not released or claimed again", () => {
  const { db, op } = recorded();
  const undo = recordOperation(db, {
    actorId: "u1",
    query: "is:repo",
    kind: "repo",
    verb: "set",
    value: "y",
    reversible: false,
    undoOf: op.id,
    rows: [],
  });
  expect(claimUndo(db, op.id)).toBe(true);
  settleUndo(db, op.id, undo.id);
  releaseUndo(db, op.id);
  expect(getOperation(db, op.id)!.undoneBy).toBe(undo.id);
  expect(claimUndo(db, op.id)).toBe(false);
});

test("an unknown operation cannot be claimed", () => {
  const { db } = recorded();
  expect(claimUndo(db, "nope")).toBe(false);
});
