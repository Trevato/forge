/** The client list's line about a sent forge is built from the first-login card's own words (#11433). */
import { describe, expect, test } from "bun:test";
import { getUserByName } from "../src/core/users.ts";
import { claimedForge } from "./helpers/claimed-forge.ts";
import { STEP_TITLES, firstScreenLine, nextStepsFor } from "../src/core/next-steps.ts";
import { forgeRow } from "../src/web/pages/forges.ts";
import { forgeLines } from "../src/tui/screens/forges.ts";
import type { ClientRow } from "../src/spawn/clients.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const row = (over: Partial<ClientRow>) =>
  ({
    name: "maria", url: "https://maria.test", for: "Maria", apps: ["bakery"], sentAt: null, made: true,
    claimed: false, lastActivityAt: null, running: null, reach: null, link: null, attention: null,
    stage: null, spendTodayUsd: null, ceilingUsd: null, size: "small", use: { kind: "shared" },
    disk: { own: false, path: "/d" }, lastHeartbeatAt: null,
    nextStep: { key: "claim", words: "claim", lastTellAt: null },
    ...over,
  }) as unknown as ClientRow;

describe("first-screen line", () => {
  test("its step titles are exactly the ones nextStepsFor gives the first-login card", async () => {
    const forge = await claimedForge("forge-first-screen-");
    try {
      const admin = getUserByName(forge.child.db, "maria")!;
      const steps = await nextStepsFor(forge.child, admin);
      expect(steps).toBeDefined();
      const titles = steps!.map((s) => s.title);
      expect(titles).toEqual(Object.values(STEP_TITLES));
      const line = firstScreenLine(["bakery"]);
      for (const t of titles) expect(line).toContain(t);
      expect(line.endsWith(`three next steps: ${titles.join("; ")}.`)).toBe(true);
    } finally {
      await forge.stop();
    }
  }, 60_000);

  test("the row's text carries the first-login line, escaped, and nothing else is said for it", () => {
    const out = forgeRow(row({ apps: ["<b>x</b>", "menu"] }), Date.now()).text;
    const line = firstScreenLine(["<b>x</b>", "menu"]);
    expect(line).toBe(
      "They will see <b>x</b>, menu, their crew working, and three next steps: Make your everyday account; Open your apps; Tell the crew something.",
    );
    expect(out).toContain(line.replace("<b>x</b>", "&lt;b&gt;x&lt;/b&gt;"));
    expect(out).not.toContain("<b>x</b>");
  });

  test("with no apps chosen it says so plainly", () => {
    expect(firstScreenLine([])).toContain("the apps you pick");
    expect(forgeRow(row({ apps: [] }), Date.now()).text).toContain("the apps you pick");
  });

  test("a claimed row omits it, on the page and in the terminal", () => {
    const claimed = row({ claimed: true });
    expect(forgeRow(claimed, Date.now()).text).not.toContain("data-first-screen");
    expect(forgeLines([claimed]).map((l) => l[1]).join("\n")).not.toContain("three next steps");
  });

  test("the terminal says the same line for an unclaimed forge", () => {
    expect(forgeLines([row({})]).map((l) => l[1].trim())).toContain(firstScreenLine(["bakery"]));
  });
});
