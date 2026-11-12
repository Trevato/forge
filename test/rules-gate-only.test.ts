/** Gate-only reds (#7560): two in a week file one issue; one files none; a red the pull shared is not gate-only. */
import { expect, test } from "bun:test";
import { fileGateOnly, gateOnlyTitle } from "../src/rules/gate_only.ts";
import { rulesWorld } from "./helpers/rules-app.ts";
import { seedCheck, seedGate, seedPull } from "./helpers/rules-seed.ts";

const w = rulesWorld();
const NAME = "sweep > repo-wide scan";
const now = Date.now();

test("a test red once in the gate with its pull green files nothing; twice files one issue, once more", () => {
  const p1 = seedPull(w.app.db, w.repoId, w.ownerId);
  const p2 = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, p1.id, "ok");
  seedCheck(w.app.db, w.repoId, p2.id, "ok");
  seedGate(w.app.db, w.repoId, [p1.number], [{ name: NAME, file: "test/unreached.test.ts" }], now - 1000);
  expect(fileGateOnly(w.app.db, w.app.bus, w.repos, now)).toEqual([]);
  expect(w.titles()).not.toContain(gateOnlyTitle(NAME));

  seedGate(w.app.db, w.repoId, [p2.number], [{ name: NAME, file: "test/unreached.test.ts" }], now - 500);
  const opened = fileGateOnly(w.app.db, w.app.bus, w.repos, now);
  expect(opened).toHaveLength(1);
  expect(w.titles().filter((t) => t === gateOnlyTitle(NAME))).toHaveLength(1);
  const body = w.app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE title = ?1").get(gateOnlyTitle(NAME))!.body;
  expect(body).toContain("pull #");
  expect(body).toContain("Files: test/unreached.test.ts");
  expect(body).toContain("do not quarantine");

  expect(fileGateOnly(w.app.db, w.app.bus, w.repos, now)).toEqual([]);
});

test("a red whose pull was red on its own check is the pull's, not the gate's", () => {
  const a = seedPull(w.app.db, w.repoId, w.ownerId);
  const b = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, a.id, "failed", ["x > y"]);
  seedCheck(w.app.db, w.repoId, b.id, "failed", ["x > y"]);
  seedGate(w.app.db, w.repoId, [a.number], [{ name: "x > shared red", file: "test/x.test.ts" }], now - 300);
  seedGate(w.app.db, w.repoId, [b.number], [{ name: "x > shared red", file: "test/x.test.ts" }], now - 200);
  expect(fileGateOnly(w.app.db, w.app.bus, w.repos, now)).toEqual([]);
});

test("a gate older than the week counts for nothing", () => {
  const a = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, a.id, "ok");
  const old = now - 8 * 86_400_000;
  seedGate(w.app.db, w.repoId, [a.number], [{ name: "old > red", file: "test/o.test.ts" }], old);
  seedGate(w.app.db, w.repoId, [a.number], [{ name: "old > red", file: "test/o.test.ts" }], old + 1000);
  expect(fileGateOnly(w.app.db, w.app.bus, w.repos, now)).toEqual([]);
});

test("a gate that carried several pulls names every one of them, not the first", () => {
  const a = seedPull(w.app.db, w.repoId, w.ownerId);
  const b = seedPull(w.app.db, w.repoId, w.ownerId);
  seedCheck(w.app.db, w.repoId, a.id, "ok");
  seedCheck(w.app.db, w.repoId, b.id, "ok");
  const name = "sweep > multi-pull scan";
  seedGate(w.app.db, w.repoId, [a.number, b.number], [{ name, file: "test/m.test.ts" }], now - 900);
  seedGate(w.app.db, w.repoId, [b.number], [{ name, file: "test/m.test.ts" }], now - 800);
  fileGateOnly(w.app.db, w.app.bus, w.repos, now);
  const body = w.app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE title = ?1").get(gateOnlyTitle(name))!.body;
  expect(body).toContain(`pulls #${a.number}, #${b.number}`);
  expect(body).toContain(`pull #${b.number})`);
});
