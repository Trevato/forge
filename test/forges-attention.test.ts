/**
 * #5941: /forges and the MCP `forges` open on what needs the owner: no word
 * in 24 h, an app not running, unclaimed after 3 days, then the rest by last
 * activity. One order, made in spawn/clients.ts.
 */

import { expect, test } from "bun:test";
import { ATTENTION_WORDS, orderRows, type ClientRow } from "../src/spawn/clients.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const row = (name: string, o: Partial<ClientRow> = {}): Omit<ClientRow, "attention"> => ({
  name,
  url: `https://${name}.test`,
  for: null,
  apps: [],
  sentAt: ago(1),
  made: true,
  claimed: true,
  lastActivityAt: ago(1),
  running: null,
  reach: null,
  size: "small",
  use: { kind: "shared" },
  lastHeartbeatAt: null,
  nextStep: { key: "unreported", words: "has not reported yet", lastTellAt: null },
  spendTodayUsd: null,
  ceilingUsd: null,
  ...o,
});

test("four children in the wrong order come back by need, each with its reason", () => {
  const rows = [
    row("fine", { lastActivityAt: ago(2) }),
    row("old-unclaimed", { claimed: false, sentAt: ago(24 * 4), lastActivityAt: ago(3) }),
    row("down", {
      lastActivityAt: ago(4),
      running: { total: 2, running: 1, notRunning: [{ slug: "shop", why: "crashed" }] },
    }),
    row("quiet", { lastActivityAt: ago(30) }),
  ];
  const out = orderRows(rows, NOW);
  expect(out.map((r) => [r.name, r.attention])).toEqual([
    ["quiet", "silent"],
    ["down", "down"],
    ["old-unclaimed", "unclaimed"],
    ["fine", null],
  ]);
  expect(ATTENTION_WORDS.silent).toBe("Not reporting");
});

test("a child that did not answer is silent; a new unclaimed one and one still being made are not flagged", () => {
  const out = orderRows(
    [
      row("new", { claimed: false, sentAt: ago(24 * 2) }),
      row("making", { made: false, claimed: null }),
      row("lost", { claimed: null, lastActivityAt: null }),
    ],
    NOW,
  );
  expect(out.map((r) => [r.name, r.attention])).toEqual([
    ["lost", "silent"],
    ["making", null],
    ["new", null],
  ]);
});

test("the rest are ordered by last activity, newest first", () => {
  const out = orderRows([row("a", { lastActivityAt: ago(5) }), row("b", { lastActivityAt: ago(1) })], NOW);
  expect(out.map((r) => r.name)).toEqual(["b", "a"]);
});
