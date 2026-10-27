/**
 * The terminal's file finder (`src/tui/screens/finder.ts`): every file in a
 * revision from one `RepoSource.paths` read, narrowed in memory by the query.
 *
 * The screen is mounted over a plain root in a headless App, fed a real
 * `RepoSource` from `sourceFor` with `paths` counted.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { App, type Ctx, type Screen } from "../src/tui/app/app.ts";
import { finderScreen } from "../src/tui/screens/finder.ts";
import type { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { err } from "../src/kernel/result.ts";
import { sourceFor, type RepoSource } from "../src/view/source.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal's file finder", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-finder-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    const b = await createUser(forge.db, {
      username: "bob",
      email: "bob@forge.test",
      password: "a-long-passphrase",
      origin: "seed",
      trusted: true,
    });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;

    for (const [name, visibility] of [
      ["pharos", "public"],
      ["vault", "private"],
    ] as const) {
      const made = await createRepo(forge, alice, { name, visibility });
      if (!made.ok) throw new Error("repo failed");
      await commitToBranch(forge, alice, made.value, {
        message: "seed",
        files: [
          { path: "README.md", content: "# hi\n" },
          { path: "src/main.ts", content: "export const one = 1;\n" },
          { path: "src/deep/nested/lamp.ts", content: "export const l = 1;\n" },
          { path: "docs/DESIGN.md", content: "# Design\n" },
          { path: "main/notes.md", content: "notes\n" },
        ],
      });
      await commitToBranch(forge, alice, made.value, {
        branch: "feature",
        message: "add two",
        files: [{ path: "src/two.ts", content: "export const two = 2;\n" }],
      });
    }
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function open(
    actor: User | undefined,
    name: string,
    ref: string,
    override?: RepoSource,
  ) {
    const made = sourceFor(forge, actor, { owner: "alice", name });
    const calls: string[] = [];
    const picked: string[] = [];
    let src: RepoSource | undefined = override;
    if (made.ok && override === undefined) {
      const real = made.value;
      src = { ...real, paths: (r: string) => (calls.push(r), real.paths(r)) };
    }
    const terminal = headlessTerminal(100, 30);
    let ctx!: Ctx;
    let root!: Screen;
    const app = new App({
      terminal,
      theme: "dark",
      root: (c) => {
        ctx = c;
        root = {
          title: "Root",
          keys: [],
          render() {},
          key: () => false,
        };
        return root;
      },
    });
    app.start();
    return {
      made,
      calls,
      picked,
      app,
      text: () => app.screen.toText(),
      async show(r = ref) {
        ctx.push(
          finderScreen({} as Session, ctx, root, src!, r, (p) =>
            picked.push(p),
          ),
        );
        await settleApp(app);
      },
      async press(...keys: string[]) {
        for (const key of keys)
          app.dispatch({
            type: "key",
            key,
            ctrl: false,
            alt: false,
            shift: false,
          });
        await settleApp(app);
      },
    };
  }

  test("lists every nested file; a query narrows the list", async () => {
    const h = open(alice, "pharos", "main");
    try {
      await h.show();
      expect(h.text()).toContain("5 files");
      for (const p of [
        "README.md",
        "src/main.ts",
        "src/deep/nested/lamp.ts",
        "docs/DESIGN.md",
        "main/notes.md",
      ])
        expect(h.text()).toContain(p);

      await h.press(..."lamp");
      expect(h.text()).toContain("src/deep/nested/lamp.ts");
      expect(h.text()).not.toContain("README.md");
      expect(h.text()).not.toContain("docs/DESIGN.md");
    } finally {
      h.app.stop();
    }
  });

  test("a query matching several files ranks the basename hit first, and enter opens the top row", async () => {
    const h = open(alice, "pharos", "main");
    try {
      await h.show();
      await h.press(..."main");
      const text = h.text();
      // Listing order is alphabetical, so `main/notes.md` (a directory-only
      // hit) would come first if nothing ranked.
      expect(text).toContain("main/notes.md");
      expect(text.indexOf("src/main.ts")).toBeGreaterThan(-1);
      expect(text.indexOf("src/main.ts")).toBeLessThan(
        text.indexOf("main/notes.md"),
      );
      await h.press("enter");
      expect(h.picked).toEqual(["src/main.ts"]);
    } finally {
      h.app.stop();
    }
  });

  test("another ref lists that ref's files", async () => {
    const h = open(alice, "pharos", "feature");
    try {
      await h.show("feature");
      expect(h.text()).toContain("6 files");
      expect(h.text()).toContain("src/two.ts");
      expect(h.calls).toEqual(["feature"]);
    } finally {
      h.app.stop();
    }
    const main = open(alice, "pharos", "main");
    try {
      await main.show();
      expect(main.text()).not.toContain("src/two.ts");
    } finally {
      main.app.stop();
    }
  });

  test("typing, deleting and moving never read paths again", async () => {
    const h = open(alice, "pharos", "main");
    try {
      await h.show();
      expect(h.calls).toEqual(["main"]);
      await h.press(..."src", "down", "backspace", "m", "a", "i", "n");
      expect(h.calls).toEqual(["main"]);
    } finally {
      h.app.stop();
    }
  });

  test("the gate is the source's: a stranger and a guest get no source to list, the owner does", async () => {
    expect(open(bob, "vault", "main").made.ok).toBe(false);
    expect(open(undefined, "vault", "main").made.ok).toBe(false);
    const h = open(alice, "vault", "main");
    try {
      expect(h.made.ok).toBe(true);
      await h.show();
      expect(h.text()).toContain("5 files");
    } finally {
      h.app.stop();
    }
  });

  test("a listing that fails says so and lists nothing", async () => {
    const real = sourceFor(forge, alice, { owner: "alice", name: "pharos" });
    if (!real.ok) throw new Error("source failed");
    const refused: RepoSource = {
      ...real.value,
      paths: async () => err("not_found"),
    };
    const h = open(alice, "pharos", "main", refused);
    try {
      await h.show();
      expect(h.text()).toContain("cannot list files");
      expect(h.text()).not.toContain("README.md");
      expect(h.text()).toContain("0 files");
    } finally {
      h.app.stop();
    }
  });
});
