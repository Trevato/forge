/**
 * The terminal UI lays itself out for the terminal it is in.
 *
 * Four screens at four sizes, against a real forge: every frame fills its
 * grid and nothing crosses the right edge; a list beside its detail pane
 * stacks below `TWO_PANE_COLS`; a resize mid-session keeps the selected row
 * and the reader's place in a log; the app's pty hears the new size while it
 * has the terminal; and under the floor one line says so.
 *
 * The cell buffer cannot overflow by construction, so the width assertions
 * are made against the *replayed* bytes as well — the virtual terminal that
 * consumes what the renderer emitted must hold the same grid.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { appendRunLog } from "../src/runs/log.ts";
import type { App, Screen } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issuesScreen } from "../src/tui/screens/issues.ts";
import { runScreen } from "../src/tui/screens/run.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { local } from "../src/tui/screens/where.ts";
import type { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { displayWidth } from "../src/tui/term/width.ts";
import {
  MIN_COLS,
  MIN_ROWS,
  TWO_PANE_COLS,
  len,
  fill,
} from "../src/tui/ui/layout.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { row, table } from "../src/tui/ui/widgets.ts";
import { settleApp } from "./helpers/tui.ts";

setLogLevel("error");

const SIZES: readonly [number, number][] = [
  [60, 20],
  [80, 24],
  [120, 40],
  [200, 60],
];

/** A log line that is one row at 120 columns and two at 60. */
const LOG_LINE = (n: number): string =>
  `line ${n}: cloning the repository and installing what it needs takes a moment`;

interface Harness {
  app: App;
  session: Session;
  terminal: HeadlessTerminal;
  lines(): string[];
  press(...keys: string[]): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  push(screen: (session: Session, ctx: App["ctx"]) => Screen): Promise<void>;
  stop(): void;
}

describe("the terminal lays out for the terminal it is in", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let repo: Repo;
  let runId: string;

  const boot = async (cols: number, rows: number): Promise<Harness> => {
    const terminal = headlessTerminal(cols, rows);
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    const settle = (): Promise<void> => settleApp(app);
    return {
      app,
      session,
      terminal,
      lines: () => app.screen.toText().split("\n"),
      async press(...keys) {
        for (const key of keys)
          app.dispatch({
            type: "key",
            key,
            ctrl: false,
            alt: false,
            shift: false,
          });
        await settle();
      },
      async resize(c, r) {
        terminal.resize(c, r);
        await settle();
      },
      async push(screen) {
        app.push(screen(session, app.ctx));
        await settle();
      },
      stop: () => app.stop(),
    };
  };

  const dashboard = async (h: Harness): Promise<void> => undefined;
  const runs = (h: Harness): Promise<void> =>
    h.push((s, ctx) => runsScreen(s, ctx, repo));
  const run = (h: Harness): Promise<void> =>
    h.push((s, ctx) => runScreen(s, ctx, repo, runId));
  const issues = (h: Harness): Promise<void> =>
    h.push((s, ctx) => issuesScreen(s, ctx, local(s, repo), "issue"));
  /** Each screen, and the content that proves it drew its rows. */
  const SCREENS = {
    dashboard: { open: dashboard, shows: "alice/lighthouse", cursor: true },
    runs: { open: runs, shows: "deploy production", cursor: true },
    run: { open: run, shows: LOG_LINE(39).slice(-13), cursor: false },
    issues: { open: issues, shows: "Lamp 30", cursor: true },
  } as const;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-size-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const r = await createRepo(forge, alice, {
      name: "lighthouse",
      visibility: "public",
      description:
        "a beacon with a description long enough to be cut on a narrow row",
    });
    if (!r.ok) throw new Error("repo creation failed");
    repo = r.value;
    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# Lighthouse\n" }],
    });
    for (let i = 1; i <= 30; i++)
      openIssue(forge, alice, repo, {
        title: `Lamp ${i} flickers at dusk and nobody knows why it does that`,
        body: "",
      });
    for (let i = 0; i < 20; i++) {
      const made = createRun(forge.db, {
        repoId: repo.id,
        kind: "deploy",
        env: i % 2 === 0 ? "production" : "pull-3",
        reason: "push to main",
        commitOid: "abcdef0123456789",
      });
      claimRun(forge.db, made.id);
      for (let l = 0; l < 40; l++) appendRunLog(dataDir, made.id, LOG_LINE(l));
      finishRun(forge.db, made.id, {
        state: i % 3 === 0 ? "failed" : "ok",
        summary: `built and started in ${i} seconds`,
        costUsd: 0,
      });
      runId = made.id;
    }
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** The row the cursor is on — the one wearing the caret. */
  const selected = (lines: readonly string[]): string | undefined =>
    lines.find((line) => line.trimStart().startsWith("▸"));

  for (const [name, screen] of Object.entries(SCREENS))
    for (const [cols, rows] of SIZES)
      test(`${name} at ${cols}×${rows} fills the frame and stays inside it`, async () => {
        const h = await boot(cols, rows);
        try {
          await screen.open(h);
          await h.press("j", "j", "j");
          const lines = h.lines();
          expect(lines.length).toBe(rows);
          for (const line of lines)
            expect(displayWidth(line)).toBeLessThanOrEqual(cols);
          // The chrome pins the frame to its edges: the brand on the first
          // row, the help bar on the last; the body drew its rows between.
          expect(lines[0]).toContain("forge");
          expect(lines[rows - 1]?.trim()).not.toBe("");
          expect(h.app.screen.toText()).toContain(screen.shows);
          if (screen.cursor) expect(selected(lines)).toBeDefined();
          // What the renderer emitted produced the grid it drew.
          expect(h.terminal.toText()).toBe(h.app.screen.toText());
        } finally {
          h.stop();
        }
      });

  test("the dashboard's feed sits beside the repositories at two columns and under them below", async () => {
    const h = await boot(TWO_PANE_COLS, 40);
    try {
      const at = (what: string): number =>
        h.lines().findIndex((line) => line.includes(what));
      expect(at("Recent activity")).toBe(at("filter repositories"));
      expect(at("Organizations")).toBeGreaterThan(-1);

      await h.resize(TWO_PANE_COLS - 1, 40);
      // Stacked: the feed is a card under the list, and the three small
      // cards wait for a wider window rather than crowd a column.
      expect(at("Recent activity")).toBeGreaterThan(at("alice/lighthouse"));
      expect(at("Organizations")).toBe(-1);
      // And `tab` reaches exactly what is drawn: the feed, then back.
      const c = theme("dark").c;
      await h.press("tab");
      expect(h.app.screen.styleAt(0, at("Recent activity")).fg).toBe(c.accent);
      await h.press("tab");
      expect(h.app.screen.styleAt(0, at("Recent activity")).fg).not.toBe(
        c.accent,
      );

      // Too short to stack: the repositories have the whole body.
      await h.resize(80, 12);
      expect(at("Recent activity")).toBe(-1);
      expect(at("alice/lighthouse")).toBeGreaterThan(-1);
    } finally {
      h.stop();
    }
  });

  test("a resize mid-session keeps the selected row, clamped into view", async () => {
    const h = await boot(120, 40);
    try {
      await issues(h);
      await h.press("j", "j", "j", "j", "j");
      const before = selected(h.lines());
      expect(before).toContain("#25");
      for (const [cols, rows] of [
        [60, 20],
        [200, 60],
        [80, 24],
      ] as const) {
        await h.resize(cols, rows);
        const now = selected(h.lines());
        expect(now).toBeDefined();
        expect(now).toContain("#25");
        expect(h.lines().length).toBe(rows);
      }
      // The cursor can be past the end of a shorter window: the window
      // follows it rather than losing it.
      await h.press("G");
      await h.resize(60, 14);
      expect(selected(h.lines())).toContain("#1 ");
    } finally {
      h.stop();
    }
  });

  test("the runs list keeps its cursor across a resize too", async () => {
    const h = await boot(200, 60);
    try {
      await runs(h);
      await h.press("j", "j", "j", "j", "j", "j", "j");
      const before = selected(h.lines());
      expect(before).toBeDefined();
      await h.resize(60, 20);
      // Same run: the same state word and summary on the caret row.
      expect(selected(h.lines())?.slice(0, 40)).toBe(before?.slice(0, 40));
    } finally {
      h.stop();
    }
  });

  test("a run's log wraps to the width and keeps the reader's line across a resize", async () => {
    const h = await boot(120, 40);
    try {
      await run(h);
      const text = h.app.screen.toText();
      expect(text).toContain(LOG_LINE(39));
      // Scroll up: following stops, and the top row names a line.
      await h.press("k", "k", "k", "k");
      const top = h.lines()[6] ?? "";
      const at = /^line (\d+):/.exec(top);
      expect(at).not.toBeNull();

      await h.resize(60, 20);
      const narrow = h.app.screen.toText();
      // Every word of a long line is somewhere on screen: the tail that a
      // clipped log would have lost is drawn on the next row.
      expect(narrow).toContain("takes a moment");
      for (const line of narrow.split("\n"))
        expect(displayWidth(line)).toBeLessThanOrEqual(60);
      // The line that was at the top is still at the top, now two rows tall.
      expect(h.lines()[6]).toStartWith(`line ${at![1]}:`);

      // `G` follows the end again, and the last row is the last line's tail.
      await h.press("G");
      const rows = h.lines();
      expect(rows[rows.length - 2]).toContain("takes a moment");
    } finally {
      h.stop();
    }
  });

  test("the app's pty hears the new size while it holds the terminal", async () => {
    const h = await boot(80, 24);
    try {
      let heard: [number, number] | undefined;
      let seen: [number, number] | undefined;
      const handed = h.app.ctx.suspend(async (host) => {
        host.onResize((cols, rows) => {
          heard = [cols, rows];
          seen = [host.cols, host.rows];
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        h.terminal.resize(132, 50);
        return "done";
      });
      expect(await handed).toBe("done");
      // The child was told first, and the host already read the new size.
      expect(heard).toEqual([132, 50]);
      expect(seen).toEqual([132, 50]);
      // Back in the UI, the frame is the new size, not the one we left at.
      h.app.frame();
      expect(h.app.screen.cols).toBe(132);
      expect(h.lines().length).toBe(50);
    } finally {
      h.stop();
    }
  });

  test("under the floor, one line says what would help", async () => {
    const h = await boot(80, 24);
    try {
      for (const [cols, rows] of [
        [MIN_COLS - 1, 24],
        [80, MIN_ROWS - 1],
        [30, 8],
      ] as const) {
        await h.resize(cols, rows);
        const lines = h.lines();
        expect(lines.length).toBe(rows);
        expect(lines.filter((line) => line.trim() !== "").length).toBe(1);
        expect(h.app.screen.toText()).toContain("Resize your terminal");
      }
      // At the floor a real frame is drawn, and the state survived the trip.
      await h.resize(MIN_COLS, MIN_ROWS);
      expect(h.lines()[0]).toContain("forge");
      expect(h.app.screen.toText()).toContain("alice/lighthouse");
    } finally {
      h.stop();
    }
  });
});

describe("rows and tables give way in the right order", () => {
  const c = theme("dark").c;

  test("a row's meta yields, least important piece first, before the title starves", () => {
    const draw = (w: number): string => {
      const s = new Surface(w, 1);
      row(s, { x: 0, y: 0, w, h: 1 }, c, {
        title: "deploy production for the lighthouse repository",
        meta: "abcdef0  $0.42  3d",
      });
      return s.toText();
    };
    const wide = draw(80);
    expect(wide).toContain("abcdef0  $0.42  3d");
    // Narrow: the commit goes, then the cost; the time is the last to leave,
    // and the title keeps its opening words rather than an ellipsis.
    const narrow = draw(36);
    expect(narrow).not.toContain("abcdef0");
    expect(narrow).toContain("3d");
    expect(narrow).toContain("deploy productio");
    // Sixteen columns of title is the floor; below it the time goes too.
    expect(draw(22)).toContain("3d");
    const tiny = draw(20);
    expect(tiny).not.toContain("3d");
    expect(tiny).toContain("deploy productio");
  });

  test("a table drops its ranked columns first, then truncates", () => {
    const draw = (w: number): string => {
      const s = new Surface(w, 4);
      table(s, { x: 0, y: 0, w, h: 4 }, c, {
        columns: [
          { header: "#", width: len(4), numeric: true },
          { header: "Title", width: fill(1) },
          { header: "Added", width: len(7), numeric: true, drop: 2 },
          { header: "Removed", width: len(9), numeric: true, drop: 1 },
        ],
        rows: [["42", "Cell-diff renderer", "812", "204"]],
      });
      return s.toText();
    };
    expect(draw(60)).toContain("Removed");
    const narrow = draw(30);
    expect(narrow).not.toContain("Removed");
    expect(narrow).toContain("Added");
    const tiny = draw(22);
    expect(tiny).not.toContain("Added");
    expect(tiny).toContain("Title");
    expect(tiny).toContain("42");
  });
});
