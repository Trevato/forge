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
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { User } from "../src/core/users.ts";
import { blobForRender } from "../src/git/read.ts";
import { listBranches } from "../src/git/branches.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

setLogLevel("error");

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
  ): Harness {
    const terminal = headlessTerminal(cols, rows);
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
    const a = await signUp(forge, {
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

  // ---- arriving ----

  test("a repository opens on its README, with the keys in the file pane", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h);
      // The README is open in a tab, and the explorer is beside it — one
      // screen, not a home page you have to leave.
      expect(h.text()).toContain("# Lighthouse");
      expect(h.text()).toContain("src/");
      expect(h.text()).toContain("1 tab");

      // `j` scrolls the file straight away: no `tab` first, which was the
      // whole complaint about the screen this replaces.
      expect(h.text()).toContain("L01");
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
      expect(after).toContain("# Lighthouse");
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
      expect(h.text()).toContain("# Lighthouse");
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
      expect(h.text()).toContain("# Lighthouse");
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
      expect(h.text()).toContain("# Lighthouse");
    } finally {
      h.stop();
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
      await guest.until("# Lighthouse");
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
      expect(h.text()).toContain("# Lighthouse");
      expect(h.text()).not.toContain("package.json");
      await h.press("tab");
      expect(h.text()).toContain("package.json");
      expect(h.text()).not.toContain("# Lighthouse");
      // The tab bar and the ref stay put through the toggle: they belong to
      // the workspace, not to either pane.
      expect(h.text()).toContain("1 tab");
      expect(h.text()).toContain("main");
      await h.press("tab");
      expect(h.text()).toContain("# Lighthouse");
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
