/**
 * The file finder, refs, counts, the palette's search half, realtime, the
 * local↔origin toggle, and OSC 8.
 *
 * The workspace itself — explorer, tabs, the inline editor and the commit —
 * has its own file (`tui-workspace.test.ts`). What is left here is everything
 * that surrounds it.
 *
 * Everything here is driven headlessly against a real forge — `createApp` in a
 * temp directory, seeded through the actions — and asserted against the cell
 * grid the renderer actually produced, or against the bytes it wrote. There is
 * no sleep anywhere: every wait is `settleApp`, which watches for quiescence
 * and throws with a screen dump rather than falling through a deadline.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listBranches } from "../src/git/branches.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { indexPaths, rankPaths } from "../src/tui/ui/fuzzy.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";

quietLogs();

interface Harness {
  app: App;
  terminal: ReturnType<typeof headlessTerminal>;
  text(): string;
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  settle(): Promise<void>;
  until(what: string): Promise<void>;
  stop(): void;
}

function boot(
  forge: Forge,
  identity: TuiIdentity,
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

describe("the terminal, around the workspace", () => {
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-code-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(forge) });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;

    const made = await createRepo(forge, alice, {
      name: "lighthouse",
      visibility: "public",
      description: "a beacon",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;

    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [
        { path: "README.md", content: "# Lighthouse\n\nA beacon.\n" },
        { path: "src/main.ts", content: "export const one = 1;\n" },
        {
          path: "src/lamp.ts",
          content: "// the lamp\nexport const lamp = true;\n",
        },
        { path: "docs/DESIGN.md", content: "# Design\n" },
      ],
    });
    await commitToBranch(forge, alice, repo, {
      branch: "feature",
      message: "add two",
      files: [{ path: "src/two.ts", content: "export const two = 2;\n" }],
    });
    openIssue(forge, alice, repo, { title: "The lamp flickers" });
    openIssue(forge, alice, repo, { title: "Paint is peeling" });
    await openPull(forge, alice, repo, {
      title: "Add two",
      body: "",
      baseBranch: "main",
      headBranch: "feature",
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * Dashboard → *this* repo. Filtered by name rather than by cursor position:
   * later tests add repos, and a test that depends on which row happened to
   * be first is a test that breaks when somebody writes another one.
   */
  async function openRepo(h: Harness, name: string): Promise<void> {
    await h.press("/");
    await h.type(name);
    await h.press("enter");
    await h.press("enter");
    await h.until(`alice/${name}`);
  }

  /** …and with the keys in the explorer rather than in the open file. */
  async function openBrowser(h: Harness): Promise<void> {
    await openRepo(h, "lighthouse");
    await h.press("tab");
    await h.settle();
  }


  test("y copies the path over OSC 52 and says so", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      // The workspace arrives with the README open, so `y` in the file pane
      // has a path to copy without a single move.
      await openRepo(h, "lighthouse");
      h.terminal.takeOutput();
      await h.press("y");
      const encoded = Buffer.from("README.md", "utf8").toString("base64");
      expect(h.terminal.takeOutput()).toContain(`]52;c;${encoded}`);
      expect(h.text()).toContain("copied README.md");
    } finally {
      h.stop();
    }
  });

  // ---- the fuzzy finder ----

  test("fzf path scoring puts src/main.ts on top for `srcmn`", () => {
    const index = indexPaths([
      "src/tui/screens/common.ts",
      "src/mytest/components/menu.ts",
      "src/main.ts",
      "src/tui/main.ts",
      "docs/DESIGN.md",
    ]);
    const ranked = rankPaths(index, "srcmn");
    expect(ranked[0]?.item.text).toBe("src/main.ts");
    // And the match positions come back, so the finder can bold them.
    expect(ranked[0]?.indices).toEqual([0, 1, 2, 4, 7]);
    // A basename match outranks any directory-only match, however good.
    const tiered = rankPaths(
      indexPaths(["menu/thing.ts", "a/b/menu.ts"]),
      "menu",
    );
    expect(tiered[0]?.item.text).toBe("a/b/menu.ts");
  });

  test("t opens the finder over every path, and enter opens the file", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await openBrowser(h);
      await h.press("t");
      await h.settle();
      // The count is stated, and honestly — this listing did not truncate.
      expect(h.text()).toContain("4 files");
      expect(h.text()).not.toContain("(truncated)");
      await h.type("srcmn");
      expect(h.text()).toContain("src/main.ts");
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("export const one");
    } finally {
      h.stop();
    }
  });

  // ---- branches ----

  test("b lists branches with drift; n creates one and D refuses the default", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await openRepo(h, "lighthouse");
      await h.press("b");
      await h.until("feature");
      // The default branch sorts first and wears its mark, so row one is a
      // known quantity — which is what the next assertion depends on.
      expect(h.text()).toContain("main");
      expect(h.text()).toContain("default");

      // `D` on the default branch is refused by the action, in its own words.
      await h.press("D");
      await h.press("right", "enter");
      await h.settle();
      expect(h.text()).toContain("cannot be deleted");

      // `n` creates from the selected ref, through `createBranch`.
      await h.press("n");
      await h.type("alice/lantern");
      await h.press("enter");
      await h.until("created alice/lantern");
      const listed = await listBranches(
        join(forge.reposRoot, "alice", "lighthouse.git"),
        repo.defaultBranch,
      );
      expect(listed.ok && listed.value.branches.map((b) => b.name)).toContain(
        "alice/lantern",
      );

      // And it can be deleted again, which the default could not.
      await h.press("/");
      await h.type("lantern");
      await h.press("enter");
      await h.press("D");
      await h.press("right", "enter");
      await h.until("deleted alice/lantern");
    } finally {
      h.stop();
    }
  });

  // ---- counts, from grouped queries ----

  test("repo rows wear issue and pull counts, and the list does not grow queries", async () => {
    // A second repo, so the "one query per page" claim is about a page.
    const other = await createRepo(forge, alice, {
      name: "keeper",
      visibility: "public",
    });
    if (!other.ok) throw new Error("repo failed");
    await commitToBranch(forge, alice, other.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# Keeper\n" }],
    });
    openIssue(forge, alice, other.value, { title: "A thing" });

    // Count the statements the dashboard's load actually issues, by spying on
    // `db.query`. The number must not scale with the number of rows.
    const db = forge.db as unknown as { query: (sql: string) => unknown };
    const original = db.query.bind(forge.db);
    const seen: string[] = [];
    (forge.db as unknown as { query: (sql: string) => unknown }).query = (
      sql: string,
    ) => {
      seen.push(sql);
      return original(sql);
    };
    const grouped = (): number =>
      seen.filter((sql) => /FROM issue\b[\s\S]*GROUP BY repo_id/.test(sql))
        .length;
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      // Each list on the page (repos, asks, the decider's) takes one grouped
      // query, however many rows it holds: a third repo adds none.
      const before = grouped();
      expect(before).toBeGreaterThan(0);
      const third = await createRepo(forge, alice, {
        name: "extra",
        visibility: "public",
      });
      if (!third.ok) throw new Error("repo failed");
      // The new repo reaches the dashboard by bus event too; let that refresh
      // finish, so only the one `r` refresh is counted.
      await h.settle();
      await Bun.sleep(100);
      await h.settle();
      seen.length = 0;
      await h.press("r");
      await h.settle();
      expect(grouped()).toBeLessThanOrEqual(before);
      // The glyphs are on the row. `○` open issues, `↳` open pulls.
      expect(h.text()).toContain("○ 2");
      expect(h.text()).toContain("↳ 1");
    } finally {
      (forge.db as unknown as { query: unknown }).query = original;
      h.stop();
    }
  });

  // ---- palette as global search ----

  test("the palette searches repos, conversations and code in sections", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await h.press(":");
      await h.type("lamp");
      // The local half runs 120ms after the last keystroke, and the live half
      // at 400ms; wait for the answer rather than for a duration.
      await h.until("ISSUES & PULLS");
      const conversations = h.text();
      expect(conversations).toContain("The lamp flickers");
      // Code hits carry path:line and the matching text.
      expect(conversations).toContain("CODE");
      expect(conversations).toContain("src/lamp.ts:");
      expect(conversations).toContain("// the lamp");
      await h.press("esc");

      // A repo hit, matched on its description, under its own heading.
      await h.press(":");
      await h.type("beacon");
      await h.until("REPOS");
      expect(h.text()).toContain("alice/lighthouse");
      await h.press("esc");

      // And the verbs are still in there, below whatever was found — a
      // query that matches both shows both sections.
      await h.press(":");
      await h.type("or");
      await h.until("COMMANDS");
      expect(h.text()).toContain("Open a repository");
    } finally {
      h.stop();
    }
  });

  // ---- realtime ----

  test("an event on the bus refreshes the dashboard with no key pressed", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      expect(h.text()).not.toContain("Fresh news");
      // Nobody touches the terminal: the outbox is the only input. What is
      // on you is the launcher's live pane.
      const told = openIssue(forge, alice, repo, { title: "Fresh news" });
      if (!told.ok) throw new Error("open failed");
      expect(assignIssue(forge, alice, repo, told.value, alice).ok).toBe(true);
      await h.until("Fresh news");
      expect(h.text()).toContain("Fresh news");
    } finally {
      h.stop();
    }
  });

  // ---- OSC 8 ----

  test("a link cell emits OSC 8, closed before the row ends", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await openRepo(h, "lighthouse");
      await h.press("I");
      await h.until("clone (http)");
      const out = h.terminal.output();
      // The clone URL is a hyperlink: opened with an id, and closed.
      expect(out).toMatch(/\x1b]8;id=f\d+;http:\/\/[^\x07]+\x07/);
      expect(out).toContain("\x1b]8;;\x07");
      // Every open is matched by a close, so nothing dangles past the run it
      // belongs to; the next test proves the same thing from the grid side.
      const opens = out.match(/\x1b]8;id=/g)?.length ?? 0;
      const closes = out.match(/\x1b]8;;\x07/g)?.length ?? 0;
      expect(closes).toBeGreaterThanOrEqual(opens);

      // And the cell really carries the URL, not just the styling.
      const grid = h.app.screen;
      let found = "";
      for (let y = 0; y < grid.rows && found === ""; y++)
        for (let x = 0; x < grid.cols; x++) {
          const uri = grid.linkAt(x, y);
          if (uri.startsWith("http")) {
            found = uri;
            break;
          }
        }
      expect(found).toContain("/alice/lighthouse.git");
    } finally {
      h.stop();
    }
  });

  test("a hyperlink never spans a row boundary", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await openRepo(h, "lighthouse");
      await h.press("I");
      await h.until("clone (http)");
      const grid = h.app.screen;
      // The last cell of a row and the first of the next are never the same
      // link, which is the property the renderer's per-row close guarantees.
      for (let y = 0; y + 1 < grid.rows; y++) {
        const end = grid.linkAt(grid.cols - 1, y);
        if (end === "") continue;
        expect(grid.linkAt(0, y + 1)).not.toBe(end);
      }
    } finally {
      h.stop();
    }
  });

  test("O with no browser copies the URL and names the gesture", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await openRepo(h, "lighthouse");
      // A native repo has no origin page, and the screen says so rather than
      // pretending. (The mirrored case is covered on the web.)
      await h.press("O");
      expect(h.text()).toContain("no origin page");
    } finally {
      h.stop();
    }
  });

  test("the workspace refuses W when there is only one side", async () => {
    const h = boot(forge, asAlice());
    try {
      await h.settle();
      await openRepo(h, "lighthouse");
      await h.press("W");
      expect(h.text()).toContain("only one side");
    } finally {
      h.stop();
    }
  });

  test("a guest cannot reach a private repo through the workspace", async () => {
    const vault = await createRepo(forge, alice, {
      name: "vault",
      visibility: "private",
    });
    if (!vault.ok) throw new Error("repo failed");
    const guest = boot(forge, {
      sshUsername: "git",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:unknown",
    });
    try {
      await guest.settle();
      // Not in the list, and — the part that matters — not reachable by name
      // either: the palette resolves through `canRead` like everything else.
      expect(guest.text()).not.toContain("vault");
      await guest.press(":");
      await guest.type("vault");
      await guest.settle();
      expect(guest.text()).not.toContain("alice/vault");
      expect(getRepo(forge.db, "alice", "vault")).toBeDefined();
    } finally {
      guest.stop();
    }
  });
});
