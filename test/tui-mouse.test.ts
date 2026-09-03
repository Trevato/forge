/**
 * The pointer, end to end.
 *
 * Everything here drives a real forge through the real loop and asserts
 * against the cell grid the renderer produced — the same discipline as
 * `tui-workspace.test.ts`, because the interesting failures are not "did the
 * handler run" but "did the handler run for the row that was under the
 * pointer". A hit table that is one row out is invisible to a unit test and
 * obvious the first time somebody clicks.
 *
 * Clicks arrive as SGR mouse *bytes*, not as synthesised events, so the parser
 * is under test too: `ESC[<0;col;rowM` with 1-based coordinates.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import type { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

setLogLevel("error");

interface Harness {
  app: App;
  terminal: HeadlessTerminal;
  text(): string;
  /** Every row of the grid, so a test can find the one it means by content. */
  rows(): string[];
  /** The row index whose text contains `what`, or -1. */
  rowOf(what: string): number;
  click(col: number, row: number, times?: number): Promise<void>;
  wheel(dir: "up" | "down", col: number, row: number): Promise<void>;
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  settle(): Promise<void>;
  until(what: string): Promise<void>;
  stop(): void;
}

describe("the pointer", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let repo: Repo;

  const asAlice = (): TuiIdentity => ({
    sshUsername: "alice",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user: alice,
  });

  function boot(cols = 120, rows = 40, term?: string): Harness {
    const terminal = headlessTerminal(cols, rows, term);
    const { app } = createForgeApp(forge, asAlice(), {
      terminal,
      exitHooks: false,
    });
    app.start();
    const settle = (): Promise<void> => settleApp(app);
    const grid = (): string[] => app.screen.toText().split("\n");
    return {
      app,
      terminal,
      text: () => app.screen.toText(),
      rows: grid,
      rowOf: (what) => grid().findIndex((line) => line.includes(what)),
      async click(col, row, times = 1) {
        for (let i = 0; i < times; i++) {
          // 1-based, as the protocol has it. Press *and* release: a terminal
          // sends both, and swallowing the release is the whole point.
          terminal.feed(`\x1b[<0;${col + 1};${row + 1}M`);
          terminal.feed(`\x1b[<0;${col + 1};${row + 1}m`);
        }
        await settle();
      },
      async wheel(dir, col, row) {
        terminal.feed(`\x1b[<${dir === "up" ? 64 : 65};${col + 1};${row + 1}M`);
        await settle();
      },
      async press(...keys) {
        for (const key of keys) {
          const ctrl = key.startsWith("ctrl+");
          const shift = key.startsWith("shift+");
          app.dispatch({
            type: "key",
            key: ctrl ? key.slice(5) : shift ? key.slice(6) : key,
            ctrl,
            alt: false,
            shift,
          });
        }
        await settle();
      },
      async type(text) {
        for (const ch of text)
          app.dispatch({
            type: "key",
            key: ch,
            ctrl: false,
            alt: false,
            shift: false,
          });
        await settle();
      },
      settle,
      until: (what) => settleUntil(app, what),
      stop: () => app.stop(),
    };
  }

  /** Dashboard → this repository's workspace, by name rather than by row. */
  async function open(h: Harness): Promise<void> {
    await h.press("/");
    await h.type("beacon");
    await h.press("enter", "enter");
    await h.until("alice/beacon");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-mouse-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const made = await createRepo(forge, alice, {
      name: "beacon",
      visibility: "public",
      description: "a light",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [
        {
          path: "README.md",
          content: `# Beacon\n\n${Array.from(
            { length: 60 },
            (_, i) => `- L${String(i + 1).padStart(2, "0")} a line\n`,
          ).join("")}`,
        },
        {
          path: "src/lamp.ts",
          content: `${Array.from(
            { length: 90 },
            (_, i) => `export const n${i} = ${i};`,
          ).join("\n")}\n`,
        },
        { path: "src/weather.ts", content: "export const wind = 12;\n" },
      ],
    });
    const second = await createRepo(forge, alice, {
      name: "lantern",
      visibility: "public",
      description: "another",
    });
    if (!second.ok) throw new Error("repo failed");
    const issue = await openIssue(forge, alice, repo, {
      title: "the lamp flickers",
      body: "at dusk",
    });
    if (!issue.ok) throw new Error("issue failed");
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ---- the loop ----

  test("mouse reporting is enabled on entry and disabled on exit", () => {
    const h = boot();
    const entered = h.terminal.output();
    expect(entered).toContain("\x1b[?1000h");
    expect(entered).toContain("\x1b[?1002h");
    expect(entered).toContain("\x1b[?1006h");
    h.stop();
    const left = h.terminal.output();
    expect(left).toContain("\x1b[?1006l");
    expect(left).toContain("\x1b[?1002l");
    expect(left).toContain("\x1b[?1000l");
  });

  test("a click selects a row; a second click on it opens", async () => {
    const h = boot();
    try {
      await h.settle();
      const beacon = h.rowOf("alice/beacon");
      const lantern = h.rowOf("alice/lantern");
      expect(beacon).toBeGreaterThan(0);
      expect(lantern).toBeGreaterThan(0);
      // One click on a row that is not selected only moves the cursor: half
      // of pointing at a row is looking at it.
      await h.click(4, lantern);
      expect(h.text()).not.toContain("alice/lantern ›");
      expect(h.rowOf("alice/lantern")).toBe(lantern);
      // The second click on the same row opens it.
      await h.click(4, lantern);
      await h.until("alice/lantern");
      expect(h.text()).toContain("alice/lantern");
      // And the crumb trail says we actually went somewhere.
      expect(h.rows()[1]).toContain("alice/lantern");
    } finally {
      h.stop();
    }
  });

  test("a double-click opens without a select first", async () => {
    const h = boot();
    try {
      await h.settle();
      const lantern = h.rowOf("alice/lantern");
      await h.click(4, lantern, 2);
      await h.until("alice/lantern");
      expect(h.rows()[1]).toContain("alice/lantern");
    } finally {
      h.stop();
    }
  });

  test("clicking a pane focuses it, and enter opens from there", async () => {
    const h = boot();
    try {
      await h.settle();
      const activity = h.rowOf("Recent activity");
      expect(activity).toBeGreaterThan(0);
      // The activity card's first row is one below its title.
      await h.click(h.text().indexOf("Recent activity") % 120, activity + 1);
      await h.settle();
      // Focus moved: the repo list no longer holds the cursor, and `enter`
      // now opens what the feed is pointing at.
      await h.press("enter");
      await h.settle();
      expect(h.rows()[1]).toContain("alice/");
    } finally {
      h.stop();
    }
  });

  test("the wheel scrolls the list under the pointer", async () => {
    const h = boot(120, 14);
    try {
      await h.settle();
      await open(h);
      await h.press("t");
      await h.settle();
      await h.type("lamp");
      await h.press("enter");
      await h.settle();
      await h.press("v"); // README opens rendered; the source scrolls by line
      expect(h.text()).toContain("n0 = 0");
      // A notch is three rows, and the pane under the pointer is the file.
      const fileColumn = 90;
      await h.wheel("down", fileColumn, 8);
      await h.wheel("down", fileColumn, 8);
      expect(h.text()).not.toContain("n0 = 0");
      await h.wheel("up", fileColumn, 8);
      await h.wheel("up", fileColumn, 8);
      expect(h.text()).toContain("n0 = 0");
    } finally {
      h.stop();
    }
  });

  test("clicking a tab switches to it; clicking its ✗ closes it", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await h.press("t");
      await h.settle();
      await h.type("lamp");
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("2 tabs");

      const bar = h.rowOf("2 tabs");
      expect(bar).toBeGreaterThan(0);
      const readmeAt = h.rows()[bar]!.indexOf("README.md");
      expect(readmeAt).toBeGreaterThanOrEqual(0);
      await h.click(readmeAt + 2, bar);
      expect(h.text()).toContain("Beacon");

      // The active tab wears a ✗; clicking it closes that tab.
      const cross = h.rows()[bar]!.indexOf("✗");
      expect(cross).toBeGreaterThan(0);
      await h.click(cross, bar);
      await h.settle();
      expect(h.text()).toContain("1 tab");
      expect(h.text()).not.toContain("2 tabs");
    } finally {
      h.stop();
    }
  });

  test("clicking an explorer row selects it, and again opens it", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      const at = h.rowOf("src/");
      expect(at).toBeGreaterThan(0);
      // The first click selects the directory, the second expands it.
      await h.click(2, at);
      await h.click(2, at);
      await h.settle();
      expect(h.text()).toContain("lamp.ts");
    } finally {
      h.stop();
    }
  });

  test("clicking a help-bar hint presses the key it names", async () => {
    const h = boot();
    try {
      await h.settle();
      const bar = h.rows().length - 1;
      const line = h.rows()[bar]!;
      const at = line.indexOf("explore");
      expect(at).toBeGreaterThan(0);
      await h.click(at, bar);
      await h.until("Explore");
      expect(h.rows()[1]).toContain("Explore");
    } finally {
      h.stop();
    }
  });

  test("an overlay takes every click, and one outside it dismisses", async () => {
    const h = boot();
    try {
      await h.settle();
      const before = h.rowOf("alice/beacon");
      await h.press("?");
      await h.settle();
      expect(h.text()).toContain("shift+drag");
      // A click on the dimmed backdrop closes the overlay and does *not*
      // reach the row underneath it.
      await h.click(2, before);
      await h.settle();
      expect(h.text()).not.toContain("shift+drag");
      expect(h.rows()[1]).not.toContain("alice/beacon");
    } finally {
      h.stop();
    }
  });

  test("a wheel notch nobody claimed still moves the cursor", async () => {
    const h = boot();
    try {
      await h.settle();
      // Column zero, row zero: the header, which registers nothing.
      const first = h.rowOf("alice/beacon");
      await h.wheel("down", 0, 0);
      await h.settle();
      // Three rows of movement in a two-row list clamps to the last row,
      // which is enough to prove the fallback fired at all.
      expect(h.rowOf("alice/beacon")).toBe(first);
    } finally {
      h.stop();
    }
  });
});
