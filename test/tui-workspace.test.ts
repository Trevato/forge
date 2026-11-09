/**
 * The workspace: a repository opened the way an editor opens one.
 *
 * Everything here is driven headlessly against a real forge — `createApp` in a
 * temp directory, seeded through the actions — and asserted against the cell
 * grid the renderer actually produced, or against what git holds afterwards.
 * There is no sleep anywhere: every wait is `settleApp`, which watches for
 * quiescence and throws with a screen dump rather than falling through a
 * deadline.
 *
 * The tests that matter most are the ones about *not* losing work: a tab keeps
 * its buffer across a tab switch, across a trip to the issue list, and across
 * a commit the action refused. Those are the promises the old
 * screen-per-file arrangement could not make.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { audienceFor } from "../src/core/audience.ts";
import { getMirrorTarget, recordMirrorPush, setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { User } from "../src/core/users.ts";
import { blobForRender } from "../src/git/read.ts";
import { listBranches } from "../src/git/branches.ts";
import { quietLogs } from "./helpers/globals.ts";
import { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import {
  headlessTerminal,
  type HeadlessTerminal,
} from "../src/tui/term/terminal.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

/**
 * The colour the first `export` keyword is drawn in. A theme switch has to
 * change it: the spans in an open tab were built against the old palette, and
 * "the code kept yesterday's colours" is exactly the bug that hides in a
 * screenshot.
 */
function keywordColour(app: App): number {
  const screen = app.screen;
  for (let y = 0; y < screen.rows; y++)
    for (let x = 0; x < screen.cols - 5; x++)
      if (screen.textAt(x, y) === "e" && rowText(app, y).includes("export"))
        return screen.fg[screen.idx(x, y)] ?? -1;
  return -1;
}

function rowText(app: App, y: number): string {
  return app.screen.toText().split("\n")[y] ?? "";
}

const README = ["# Lighthouse", "", ...longBody()].join("\n");

function longBody(): string[] {
  // Long enough that the pane cannot show all of it, so `j` demonstrably
  // scrolls rather than appearing to.
  return Array.from(
    { length: 60 },
    (_, i) => `L${String(i + 1).padStart(2, "0")} a line`,
  );
}

interface Harness {
  app: App;
  terminal: HeadlessTerminal;
  text(): string;
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  settle(): Promise<void>;
  until(what: string): Promise<void>;
  stop(): void;
}

describe("the terminal workspace", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let repo: Repo;
  let dir: string;

  const asAlice = (): TuiIdentity => ({
    sshUsername: "alice",
    remoteAddress: "127.0.0.1",
    fingerprint: "SHA256:test",
    user: alice,
  });

  function boot(
    identity: TuiIdentity = asAlice(),
    cols = 120,
    rows = 40,
    term?: string,
  ): Harness {
    const terminal = headlessTerminal(cols, rows, term);
    const { app } = createForgeApp(forge, identity, {
      terminal,
      exitHooks: false,
    });
    app.start();
    const settle = (): Promise<void> => settleApp(app);
    const send = (key: string): void => {
      const ctrl = key.startsWith("ctrl+");
      const shift = key.startsWith("shift+");
      app.dispatch({
        type: "key",
        key: ctrl ? key.slice(5) : shift ? key.slice(6) : key,
        ctrl,
        alt: false,
        shift,
      });
    };
    return {
      app,
      terminal,
      text: () => app.screen.toText(),
      async press(...keys) {
        for (const key of keys) send(key);
        await settle();
      },
      async type(text) {
        for (const ch of text) send(ch);
        await settle();
      },
      settle,
      until: (what) => settleUntil(app, what),
      stop: () => app.stop(),
    };
  }

  /** Dashboard → this repository's workspace, by name rather than by row. */
  async function open(h: Harness, name = "lighthouse"): Promise<void> {
    await h.press("/");
    await h.type(name);
    await h.press("enter");
    await h.press("enter");
    await h.until(`alice/${name}`);
  }

  /** The finder is the deterministic way to a file: no row order to guess. */
  async function openFile(h: Harness, query: string): Promise<void> {
    await h.press("t");
    await h.settle();
    await h.type(query);
    await h.press("enter");
    await h.settle();
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-workspace-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;

    const made = await createRepo(forge, alice, {
      name: "lighthouse",
      visibility: "public",
      description: "a beacon",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    dir = join(forge.reposRoot, "alice", "lighthouse.git");

    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [
        { path: "README.md", content: `${README}\n` },
        {
          path: "docs/logo.png",
          content: new Uint8Array(
            await Bun.file(join(import.meta.dir, "fixtures", "quads.png")).arrayBuffer(),
          ),
        },
        { path: "package.json", content: '{ "name": "lighthouse" }\n' },
        {
          path: "src/lamp.ts",
          content: "// the lamp\nexport const lamp = true;\n",
        },
        { path: "src/weather.ts", content: "export const wind = 12;\n" },
      ],
    });
    await commitToBranch(forge, alice, repo, {
      branch: "feature",
      message: "add two",
      files: [{ path: "src/two.ts", content: "export const two = 2;\n" }],
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a mirror that stopped says why in the status line, and U stops mirroring", async () => {
    forge.db.run("PRAGMA foreign_keys = OFF");
    setMirrorTarget(forge.db, {
      repoId: repo.id,
      originId: "origin-none",
      fullName: "octo/lighthouse",
      cloneUrl: "https://example.test/octo/lighthouse.git",
      tips: {},
    });
    recordMirrorPush(forge.db, repo.id, {}, "octo/lighthouse refused the mirror push: moved");
    const h = boot();
    try {
      await h.settle();
      await open(h);
      expect(h.text()).toContain("Mirrored to octo/lighthouse, stopped:");
      // U asks first (test/tui-workspace-unmirror.test.ts); choose Stop mirroring.
      await h.press("U", "right", "enter");
      expect(getMirrorTarget(forge.db, repo.id)).toBeUndefined();
      expect(h.text()).not.toContain("Mirrored to octo/lighthouse");
    } finally {
      h.stop();
      forge.db.run("PRAGMA foreign_keys = ON");
    }
  });

  // ---- arriving ----

  test("a repository opens on its README, with the keys in the file pane", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      // The README is open in a tab, and the explorer is beside it — one
      // screen, not a home page you have to leave. Prose opens *rendered*:
      // the heading is a heading, not a line starting with a hash.
      expect(h.text()).toContain("Lighthouse");
      expect(h.text()).not.toContain("# Lighthouse");
      expect(h.text()).toContain("src/");
      expect(h.text()).toContain("1 tab");

      // `v` shows the bytes behind it, and that view scrolls by line.
      await h.press("v");
      expect(h.text()).toContain("# Lighthouse");
      expect(h.text()).toContain("L01");
      // `j` scrolls the file straight away: no `tab` first, which was the
      // whole complaint about the screen this replaces.
      await h.press("j", "j");
      expect(h.text()).not.toContain("# Lighthouse");
      expect(h.text()).toContain("L01");
      await h.press("G");
      expect(h.text()).toContain("L60");
      await h.press("g");
      expect(h.text()).toContain("# Lighthouse");
    } finally {
      h.stop();
    }
  });

  test("a .csv opens as an aligned table with a pinned header, and s flips to the source", async () => {
    const made = await createRepo(forge, alice, {
      name: "ledger",
      visibility: "public",
      description: "numbers",
    });
    if (!made.ok) throw new Error("repo failed");
    const rows = Array.from({ length: 80 }, (_, i) => `${i + 1},item ${i + 1}`);
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        { path: "data.csv", content: ["id,name", ...rows, ""].join("\n") },
        { path: "qty.tsv", content: "name, full\tqty\nwidget\t4\n" },
        { path: "bad.csv", content: 'a,b\n1,"oops\n' },
      ],
    });
    const h = boot();
    try {
      await h.settle();
      await open(h, "ledger");
      await openFile(h, "data.csv");
      expect(h.text()).toContain("id │ name");
      expect(h.text()).toContain("1  │ item 1");
      expect(h.text()).toContain("80 rows");
      await h.press("G");
      expect(h.text()).toContain("id │ name");
      expect(h.text()).toContain("80 │ item 80");
      await h.press("s");
      expect(h.text()).toContain("id,name");
      expect(h.text()).not.toContain("│ item");
      await h.press("s");
      expect(h.text()).toContain("id │ name");

      await openFile(h, "qty.tsv");
      expect(h.text()).toContain("name, full │ qty");
      expect(h.text()).toContain("widget");
      expect(h.text()).toContain("1 row");

      await openFile(h, "bad.csv");
      expect(h.text()).toContain("a,b");
      expect(h.text()).toContain("not a table: line 2");
    } finally {
      h.stop();
    }
  });

  test("a .patch opens as the diff a pull shows, v flips to the source, a non-diff stays text", async () => {
    const made = await createRepo(forge, alice, {
      name: "patches",
      visibility: "public",
      description: "diffs",
    });
    if (!made.ok) throw new Error("repo failed");
    const patch = [
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old line",
      "+new line",
      "",
    ].join("\n");
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        { path: "fix.patch", content: patch },
        { path: "notes.diff", content: "just some notes\n" },
      ],
    });
    const h = boot();
    try {
      await h.settle();
      await open(h, "patches");
      await openFile(h, "fix.patch");
      expect(h.text()).toContain("one.txt");
      expect(h.text()).toContain("new line");
      expect(h.text()).not.toContain("diff --git");
      await h.press("v");
      expect(h.text()).toContain("diff --git a/one.txt b/one.txt");
      await openFile(h, "notes.diff");
      expect(h.text()).toContain("just some notes");
    } finally {
      h.stop();
    }
  });

  test("a .srt opens as a Start/Text table sharing the web parser, and s flips to the source", async () => {
    const made = await createRepo(forge, alice, {
      name: "captions",
      visibility: "public",
      description: "subtitles",
    });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        {
          path: "talk.srt",
          content:
            "1\n00:00:01,500 --> 00:00:03,000\nHello <i>there</i>\n\n2\n00:00:0x --> nope\nBroken\n",
        },
      ],
    });
    const h = boot();
    try {
      await h.settle();
      await open(h, "captions");
      await openFile(h, "talk.srt");
      expect(h.text()).toContain("Start");
      expect(h.text()).toContain("00:00:01.500 │ Hello there");
      expect(h.text()).toContain("1 cue");
      expect(h.text()).toContain("1 unreadable, check their arrow lines");
      await h.press("s");
      expect(h.text()).toContain("00:00:01,500 --> 00:00:03,000");
    } finally {
      h.stop();
    }
  });

  test("a .ics opens as a table of its events sharing the web parser, and s flips to the source", async () => {
    const made = await createRepo(forge, alice, {
      name: "calendars",
      visibility: "public",
      description: "events",
    });
    if (!made.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        {
          path: "team.ics",
          content:
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260301T090000Z\r\nSUMMARY:Planning\r\nLOCATION:Room 1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        },
      ],
    });
    const h = boot();
    try {
      await h.settle();
      await open(h, "calendars");
      await openFile(h, "team.ics");
      expect(h.text()).toContain("Summary");
      expect(h.text()).toContain("2026-03-01 09:00 UTC");
      expect(h.text()).toContain("Planning");
      expect(h.text()).toContain("1 event");
      await h.press("s");
      expect(h.text()).toContain("SUMMARY:Planning");
    } finally {
      h.stop();
    }
  });

  test("tables: search, edit, the caps in the status line, a ; file, and s on a broken one", async () => {
    const made = await createRepo(forge, alice, {
      name: "sheets",
      visibility: "public",
      description: "more numbers",
    });
    if (!made.ok) throw new Error("repo failed");
    const rows = Array.from({ length: 80 }, (_, i) => `${i + 1},item ${i + 1}`);
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        { path: "data.csv", content: ["id,name", ...rows, ""].join("\n") },
        { path: "semi.csv", content: "city;pop\nOslo;700\n" },
        {
          path: "wide.csv",
          content: `${Array.from({ length: 70 }, (_, i) => `c${i}`).join(",")}\n1\n`,
        },
        {
          path: "long.csv",
          content: `n\n${Array.from({ length: 1100 }, (_, i) => i).join("\n")}\n`,
        },
        { path: "bad.csv", content: 'a,b\n1,"oops\n' },
      ],
    });
    const h = boot();
    try {
      await h.settle();
      await open(h, "sheets");

      await openFile(h, "semi.csv");
      expect(h.text()).toContain("city │ pop");
      expect(h.text()).toContain("Oslo");

      await openFile(h, "wide.csv");
      expect(h.text()).toContain("6 more columns");

      await openFile(h, "long.csv");
      expect(h.text()).toContain("1100 rows, first 1000 shown");

      await openFile(h, "data.csv");
      expect(h.text()).not.toContain("item 70");
      await h.press("/");
      await h.type("item 70");
      await h.press("enter");
      expect(h.text()).toContain("70 │ item 70");

      await h.press("e");
      await h.press("esc");
      expect(h.text()).toContain("70,item 70");
      expect(h.text()).not.toContain("│ item");
      await h.press("s");
      expect(h.text()).toContain("id │ name");

      await openFile(h, "bad.csv");
      await h.press("s");
      expect(h.text()).toContain("not a table: line 2");
    } finally {
      h.stop();
    }
  });

  test("moving in the explorer changes nothing in the file pane", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await h.press("tab");
      const before = h.text();
      await h.press("j", "j", "k");
      const after = h.text();
      // Same tab, same file, same scroll position: the cursor is a cursor,
      // not a read.
      expect(after).toContain("Lighthouse");
      expect(after).toContain("1 tab");
      expect(after.includes("L01")).toBe(before.includes("L01"));
    } finally {
      h.stop();
    }
  });

  // ---- tabs ----

  test("enter opens a tab, and a second enter activates it rather than duplicating", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      expect(h.text()).toContain("the lamp");
      expect(h.text()).toContain("2 tabs");
      expect(h.text()).toContain("src/lamp.ts");

      // Back into the explorer, where the finder left the cursor, and open
      // the very same file again.
      await h.press("tab");
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("2 tabs");
    } finally {
      h.stop();
    }
  });

  test("] [ and the digits move between tabs", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      await openFile(h, "weather");
      expect(h.text()).toContain("3 tabs");
      expect(h.text()).toContain("export const wind");

      await h.press("[");
      expect(h.text()).toContain("the lamp");
      await h.press("]");
      expect(h.text()).toContain("export const wind");
      await h.press("1");
      expect(h.text()).toContain("Lighthouse");
      await h.press("2");
      expect(h.text()).toContain("the lamp");
    } finally {
      h.stop();
    }
  });

  test("x on a modified tab asks first, and keeping it keeps the edit", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      await h.press("e", "end");
      await h.type(" // edited");
      await h.press("esc");
      expect(h.text()).toContain("1 modified");

      await h.press("x");
      await h.settle();
      expect(h.text()).toContain("uncommitted changes");
      // Keeping is the default, and it really keeps.
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("2 tabs");
      expect(h.text()).toContain("1 modified");
      expect(h.text()).toContain("// edited");
    } finally {
      h.stop();
    }
  });

  test("an edit survives a tab switch and a trip to the issue list", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      await h.press("e", "end");
      await h.type(" // kept");
      await h.press("esc");

      // Another tab, and back.
      await h.press("1");
      expect(h.text()).toContain("Lighthouse");
      await h.press("2");
      expect(h.text()).toContain("// kept");

      // A whole other screen, and back. The workspace stays on the stack, so
      // its buffers are exactly where they were.
      await h.press("i");
      await h.until("Issues");
      await h.press("esc");
      await h.settle();
      expect(h.text()).toContain("// kept");
      expect(h.text()).toContain("1 modified");
    } finally {
      h.stop();
    }
  });

  // ---- the commit ----

  test("two edits and a deletion go in one commit, on a branch, with a pull", async () => {
    const other = await createRepo(forge, alice, {
      name: "harbour",
      visibility: "public",
    });
    if (!other.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice, other.value, {
      message: "seed",
      files: [
        { path: "README.md", content: "# Harbour\n" },
        { path: "src/lamp.ts", content: "export const lamp = true;\n" },
        { path: "src/old.ts", content: "export const old = 1;\n" },
      ],
    });
    const harbour = join(forge.reposRoot, "alice", "harbour.git");
    const before = await commitCount(harbour, "main");

    const h = boot();
    try {
      await h.settle();
      await open(h, "harbour");

      // One: the README, already open.
      await h.press("e", "end");
      await h.type("\nA safe place.");
      await h.press("esc");

      // Two: a second file, edited in its own tab.
      await openFile(h, "srclamp");
      await h.press("e", "end");
      await h.type(" // brighter");
      await h.press("esc");

      // Three: a deletion, which is a change like any other.
      await openFile(h, "old");
      await h.press("x"); // it is not open for editing, only for deleting
      await h.press("tab");
      await h.press("D");
      await h.settle();
      expect(h.text()).toContain("Mark src/old.ts for deletion");
      await h.press("right", "enter");
      await h.until("marked for deletion");

      await h.press("c");
      await h.settle();
      // Everything going in is on the dialog, ticked, with what is happening
      // to it — nobody is asked to trust a count.
      expect(h.text()).toContain("Files · 3 of 3");
      expect(h.text()).toContain("[x] ~ README.md");
      expect(h.text()).toContain("[x] ~ src/lamp.ts");
      expect(h.text()).toContain("[x] - src/old.ts");
      expect(h.text()).toContain("alice/edit-README-md");

      // subject → body → files → target → branch → pull
      await h.press("tab", "tab", "tab", "tab", "tab");
      await h.press(" ");
      expect(h.text()).toContain("[x] open a pull request");
      await h.press("ctrl+s");
      await h.until("pull #");

      // One commit, not three: `editFiles` is one call.
      expect(await commitCount(harbour, "alice/edit-README-md")).toBe(
        before + 1,
      );
      const readme = await blobForRender(
        harbour,
        "alice/edit-README-md",
        "README.md",
        1 << 20,
      );
      expect(readme.kind).toBe("text");
      if (readme.kind === "text")
        expect(text(readme.body)).toContain("A safe place.");
      const lamp = await blobForRender(
        harbour,
        "alice/edit-README-md",
        "src/lamp.ts",
        1 << 20,
      );
      if (lamp.kind === "text")
        expect(text(lamp.body)).toContain("// brighter");
      const gone = await blobForRender(
        harbour,
        "alice/edit-README-md",
        "src/old.ts",
        1 << 20,
      );
      expect(gone.kind).toBe("missing");
      // …and the default branch did not move.
      const still = await blobForRender(harbour, "main", "src/old.ts", 1 << 20);
      expect(still.kind).toBe("text");

      const fresh = getRepo(forge.db, "alice", "harbour")!;
      const pulls = listPulls(forge.db, fresh.id, { state: "open" });
      expect(pulls).toHaveLength(1);
      expect(pulls[0]?.headBranch).toBe("alice/edit-README-md");

      // The workspace followed the commit: the ref pill is the new branch and
      // nothing is modified any more.
      await h.settle();
      expect(h.text()).toContain("alice/edit-README-md");
      expect(h.text()).not.toContain("1 modified");
    } finally {
      h.stop();
    }
  });

  test("a refused commit keeps every buffer", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      await h.press("e", "end");
      await h.type(" // survives");
      await h.press("esc");
      await h.press("c");
      await h.settle();

      // A branch name git will not take. The action refuses, the dialog says
      // why in its own words, and the buffer is untouched.
      await h.press("tab", "tab", "tab", "tab");
      for (let i = 0; i < 40; i++) await h.press("backspace");
      await h.type("not a branch name");
      await h.press("ctrl+s");
      await h.settle();
      expect(h.text()).toContain("the branch could not be created");
      await h.press("esc");
      await h.settle();
      expect(h.text()).toContain("// survives");
      expect(h.text()).toContain("1 modified");

      const listed = await listBranches(dir, repo.defaultBranch);
      expect(
        listed.ok && listed.value.branches.map((b) => b.name),
      ).not.toContain("not a branch name");
    } finally {
      h.stop();
    }
  });

  // ---- refs ----

  test("b lists branches and tags, switches the ref, and reloads the tabs", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      await h.press("b");
      await h.until("feature");
      expect(h.text()).toContain("main");
      expect(h.text()).toContain("default");

      await h.press("/");
      await h.type("feature");
      await h.press("enter");
      await h.press("enter");
      await h.until("feature");
      // The ref pill moved, and the tab was re-read at the new ref — the file
      // exists there too, so it is still on screen.
      expect(h.text()).toContain("feature");
      expect(h.text()).toContain("the lamp");
      // …and the branch's own file is in the explorer now.
      await h.press("t");
      await h.settle();
      await h.type("two");
      expect(h.text()).toContain("src/two.ts");
      await h.press("esc");
    } finally {
      h.stop();
    }
  });

  test("B creates a branch from the current ref and moves the workspace onto it", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await h.press("B");
      await h.settle();
      expect(h.text()).toContain("New branch");
      await h.type("alice/lantern");
      await h.press("enter");
      await h.until("created alice/lantern");

      const listed = await listBranches(dir, repo.defaultBranch);
      expect(listed.ok && listed.value.branches.map((b) => b.name)).toContain(
        "alice/lantern",
      );
      await h.settle();
      expect(h.text()).toContain("alice/lantern");
    } finally {
      h.stop();
    }
  });

  // ---- about ----

  test("I shows the about card, with the clone URL", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await h.press("I");
      await h.settle();
      expect(h.text()).toContain("a beacon");
      expect(h.text()).toContain("public");
      expect(h.text()).toContain("clone (http)");
      expect(h.text()).toContain("/alice/lighthouse.git");

      await h.press("y");
      expect(h.text()).toContain("copied the clone URL");
      await h.press("esc");
      await h.settle();
      expect(h.text()).toContain("Lighthouse");
    } finally {
      h.stop();
    }
  });

  test("the about card says who can see the repository, as the API does", async () => {
    const guest = boot({
      sshUsername: "git",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:unknown",
    });
    const member = boot();
    try {
      for (const [h, viewer] of [
        [member, alice],
        [guest, undefined],
      ] as const) {
        await h.settle();
        await open(h);
        await h.press("I");
        await h.settle();
        expect(h.text()).toContain(audienceFor(forge.db, repo, viewer).sentence);
      }
    } finally {
      member.stop();
      guest.stop();
    }
  });

  // ---- read-only ----

  test("a reader who cannot write is told so rather than shown an editor", async () => {
    const guest = boot({
      sshUsername: "git",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:unknown",
    });
    try {
      await guest.settle();
      await open(guest);
      await guest.until("Lighthouse");
      // Reading is fine; writing is not offered, and pressing the key says so
      // instead of opening a buffer nothing could ever commit.
      await guest.press("e");
      expect(guest.text()).toContain("cannot write");
      await guest.press("c");
      expect(guest.text()).toContain("cannot write");
      await guest.press("tab");
      await guest.press("D");
      expect(guest.text()).toContain("cannot write");
    } finally {
      guest.stop();
    }
  });

  // ---- narrow ----

  test("at 80 columns there is one pane, and tab toggles the explorer onto it", async () => {
    const h = boot(asAlice(), 80, 24);
    try {
      await h.settle();
      await open(h);
      // The file fills the width; the explorer is not beside it.
      expect(h.text()).toContain("Lighthouse");
      expect(h.text()).not.toContain("package.json");
      await h.press("tab");
      expect(h.text()).toContain("package.json");
      expect(h.text()).not.toContain("Lighthouse\n");
      // The tab bar and the ref stay put through the toggle: they belong to
      // the workspace, not to either pane.
      expect(h.text()).toContain("1 tab");
      expect(h.text()).toContain("main");
      await h.press("tab");
      expect(h.text()).toContain("Lighthouse");
    } finally {
      h.stop();
    }
  });


  // ---- pictures ----

  test("an image tab draws pixels on a terminal that can show them", async () => {
    // Ghostty speaks the kitty protocol, and `TERM` is the only thing an SSH
    // session gets to tell us about the far side.
    const h = boot(asAlice(), 120, 40, "xterm-ghostty");
    try {
      await h.settle();
      await open(h);
      h.terminal.takeOutput();
      await openFile(h, "logo");
      const out = h.terminal.takeOutput();
      // The placement goes out *after* the frame, as an APC, and it carries
      // the transmit-and-display key.
      expect(out).toContain("\x1b_G");
      expect(out).toContain("a=T");
      expect(h.text()).toContain("docs/logo.png");
      // The status line names what the file is, since the cells are blank.
      expect(h.text()).toContain("PNG");

      // Switching away takes the picture with it: a kitty placement is
      // anchored to a cell and would otherwise sit on top of the next file.
      h.terminal.takeOutput();
      await h.press("1");
      const after = h.terminal.takeOutput();
      expect(after).toContain("\x1b_G");
      expect(after).toContain("a=d");
    } finally {
      h.stop();
    }
  });

  test("the same image is a card of facts where pixels are impossible", async () => {
    const h = boot(asAlice(), 120, 40, "xterm-256color");
    try {
      await h.settle();
      await open(h);
      h.terminal.takeOutput();
      await openFile(h, "logo");
      // No escape soup: a placeholder that says what the file is and what
      // would show it.
      expect(h.terminal.takeOutput()).not.toContain("\x1b_G");
      expect(h.text()).toContain("PNG");
      expect(h.text()).toContain("Ghostty, kitty or WezTerm");
    } finally {
      h.stop();
    }
  });

  test("v on an image shows what the file is instead", async () => {
    const h = boot(asAlice(), 120, 40, "xterm-ghostty");
    try {
      await h.settle();
      await open(h);
      await openFile(h, "logo");
      await h.press("v");
      expect(h.text()).toContain("dimensions");
      expect(h.text()).toContain("format");
      // And nothing is placed while the facts are up.
      h.terminal.takeOutput();
      await h.press("j");
      expect(h.terminal.takeOutput()).not.toContain("a=T");
    } finally {
      h.stop();
    }
  });

  // ---- the theme ----

  test("switching theme re-tokenises the open tabs", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      const before = keywordColour(h.app);
      // The same path the picker takes. (`t` itself belongs to the finder
      // while a workspace is open — the picker is reachable from the
      // screens that do not claim the letter.)
      h.app.ctx.setTheme("light");
      await h.settle();
      const after = keywordColour(h.app);
      expect(after).not.toBe(-1);
      expect(after).not.toBe(before);
    } finally {
      h.stop();
    }
  });

  // ---- coming back ----

  test("re-entering a repository restores its tabs and its cursor", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await openFile(h, "srclamp");
      await h.press("e", "end");
      await h.type(" // kept");
      await h.press("esc");
      expect(h.text()).toContain("2 tabs");

      // All the way out to the dashboard, then back in by name. The
      // dashboard keeps its filter, so clear it before typing another.
      await h.press("q");
      await h.settle();
      expect(h.text()).not.toContain("2 tabs");
      await h.press("/", "esc");
      await open(h);
      // Same tabs, same active one, same uncommitted edit.
      expect(h.text()).toContain("2 tabs");
      expect(h.text()).toContain("// kept");
      expect(h.text()).toContain("1 modified");
    } finally {
      h.stop();
    }
  });

  // ---- the help ----

  test("the help overlay names every binding the workspace answers", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      await h.press("?");
      const help = h.text();
      for (const label of [
        "focus explorer",
        "edit",
        "search in file",
        "discard changes",
        "next / previous tab",
        "close tab / others",
        "commit",
        "switch ref / new branch",
        "find file",
        "copy path",
        "issues / pulls / commits",
        "about this repository",
        "pin",
        "fork",
        "settings",
        "refresh",
      ])
        expect(help).toContain(label);
      await h.press("esc");

      // The explorer answers a different set, and says so.
      await h.press("tab", "?");
      const explorer = h.text();
      expect(explorer).toContain("open / expand");
      expect(explorer).toContain("collapse");
      expect(explorer).toContain("filter this level");
      expect(explorer).toContain("new file / delete");
    } finally {
      h.stop();
    }
  });
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** How many commits a ref has. The git binary answers, as it always does. */
async function commitCount(dir: string, ref: string): Promise<number> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-list", "--count", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Number(out.trim());
}
