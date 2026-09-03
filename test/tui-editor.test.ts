/**
 * The built-in editor, the commit dialog behind `ctrl+s`, and the handoff to
 * an external `$EDITOR` over a pty.
 *
 * Two halves. The buffer is tested directly, because the interesting claims
 * there are about *bytes* — CRLF, a BOM, a trailing newline, tabs — and the
 * only honest way to check "the file round-trips" is to round-trip it. The
 * screen half is driven through the real app, so a save really does reach
 * `actions/contents.ts` and really does produce a commit and a pull.
 *
 * The external editor is exercised with a fake one: a two-line bun script
 * that rewrites the file and exits. That covers everything except nvim's own
 * teardown, which is what the `nvim -es` smoke below adds when nvim is on the
 * machine and skips when it is not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { blobForRender } from "../src/git/read.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { App } from "../src/tui/app/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { forgetEditor } from "../src/tui/screens/external.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { Editor, colFromDisplay, displayCol } from "../src/tui/ui/editor.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

setLogLevel("error");

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function key(
  editor: Editor,
  name: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): void {
  editor.key({
    type: "key",
    key: name,
    ctrl: mods.ctrl ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
  });
}

function typeInto(editor: Editor, s: string): void {
  for (const ch of s) key(editor, ch);
}

// ---- the buffer ----

describe("the editor buffer", () => {
  test("bytes round-trip: CRLF, a BOM and a missing final newline survive", () => {
    const crlf = new Editor(bytes("a\r\nb\r\n"), "x.txt");
    expect(crlf.lines).toEqual(["a", "b"]);
    expect(text(crlf.toBytes())).toBe("a\r\nb\r\n");

    // A BOM is stripped for editing and re-emitted only if it was there.
    // Asserted on the *bytes*: `TextDecoder` swallows a leading BOM, so a
    // string comparison here would pass whether we re-emitted it or not.
    const bom = new Editor(bytes("﻿hello\n"), "x.txt");
    expect(bom.lines).toEqual(["hello"]);
    expect([...bom.toBytes()].slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(bom.toBytes().length).toBe(9);
    // …and a file without one does not grow one.
    expect([...new Editor(bytes("hello\n"), "x.txt").toBytes()]).toEqual([
      ...bytes("hello\n"),
    ]);

    // No trailing newline stays no trailing newline. This one matters more
    // here than in a general editor: forge is a git host, and an editor that
    // adds a final LF turns every no-op save into a spurious diff.
    const bare = new Editor(bytes("one\ntwo"), "x.txt");
    expect(text(bare.toBytes())).toBe("one\ntwo");
    expect(bare.modified).toBe(false);
  });

  test("tabs stay tabs in the buffer and render at four", () => {
    const editor = new Editor(bytes("\tif (x) {\n"), "x.ts");
    expect(editor.lines[0]).toBe("\tif (x) {");
    // Display columns and buffer columns are different things, and this pair
    // is the only place they are allowed to be confused.
    expect(displayCol("\tif", 1)).toBe(4);
    expect(displayCol("\tif", 3)).toBe(6);
    expect(colFromDisplay("\tif", 4)).toBe(1);
    // A tab typed into the buffer is a tab, not four spaces.
    key(editor, "end");
    key(editor, "tab");
    expect(editor.lines[0]?.endsWith("{\t")).toBe(true);
  });

  test("typing, undo, redo: a run of characters is one undo step", () => {
    const editor = new Editor(bytes("start\n"), "x.txt");
    key(editor, "end");
    typeInto(editor, "ing");
    expect(editor.lines[0]).toBe("starting");
    // Coalesced: the three characters were typed contiguously inside the
    // window, so one undo takes all of them.
    expect(editor.undo()).toBe(true);
    expect(editor.lines[0]).toBe("start");
    expect(editor.redo()).toBe(true);
    expect(editor.lines[0]).toBe("starting");
    // A word boundary breaks the run: undo gives back the word, not the
    // whole line, which is the behaviour people have the strongest intuition
    // about. So "up" and the space before it are two records.
    typeInto(editor, " up");
    editor.undo();
    expect(editor.lines[0]).toBe("starting ");
    editor.undo();
    expect(editor.lines[0]).toBe("starting");
  });

  test("selection, cut and paste stay inside the buffer", () => {
    const editor = new Editor(bytes("hello world\n"), "x.txt");
    key(editor, "home");
    for (let i = 0; i < 5; i++) key(editor, "right", { shift: true });
    expect(editor.selection()).not.toBeNull();
    expect(editor.copy()).toBe("hello");
    key(editor, "delete");
    expect(editor.lines[0]).toBe(" world");
    key(editor, "end");
    key(editor, "v", { ctrl: true });
    expect(editor.lines[0]).toBe(" worldhello");
  });

  test("find walks matches and replace-all rewrites every one", () => {
    const editor = new Editor(bytes("a lamp\nno lamp\nlamp\n"), "x.txt");
    expect(editor.matches("lamp").length).toBe(3);
    expect(editor.seek("lamp")).toBe(true);
    expect(editor.cursor.row).toBe(0);
    expect(editor.seek("lamp")).toBe(true);
    expect(editor.cursor.row).toBe(1);
    expect(editor.replaceAll("lamp", "beacon")).toBe(3);
    expect(text(editor.toBytes())).toBe("a beacon\nno beacon\nbeacon\n");
  });

  test("a large file opens read-only rather than slowly", () => {
    const huge = new Editor(bytes("x\n".repeat(60_000)), "big.txt");
    expect(huge.readOnly).toBe(true);
    expect(huge.readOnlyReason).toContain("lines");
    const before = huge.lines.length;
    typeInto(huge, "nope");
    expect(huge.lines.length).toBe(before);
    expect(huge.modified).toBe(false);
    expect(huge.status()).toContain("read-only");
  });

  test("the status line says where the caret is, and whether it is dirty", () => {
    const editor = new Editor(bytes("one\ntwo\n"), "src/x.ts");
    key(editor, "down");
    key(editor, "right");
    expect(editor.status()).toBe("src/x.ts · Ln 2, Col 2");
    typeInto(editor, "!");
    expect(editor.status()).toContain("modified");
  });
});

// ---- the screens ----

describe("editing a file in the terminal", () => {
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

  interface Harness {
    app: App;
    text(): string;
    press(...keys: string[]): Promise<void>;
    type(s: string): Promise<void>;
    settle(): Promise<void>;
    until(what: string): Promise<void>;
    stop(): void;
  }

  function boot(cols = 120, rows = 40): Harness {
    const terminal = headlessTerminal(cols, rows);
    const { app } = createForgeApp(forge, asAlice(), {
      terminal,
      exitHooks: false,
    });
    app.start();
    const settle = (): Promise<void> => settleApp(app);
    const send = (k: string): void => {
      const ctrl = k.startsWith("ctrl+");
      app.dispatch({
        type: "key",
        key: ctrl ? k.slice(5) : k,
        ctrl,
        alt: false,
        shift: false,
      });
    };
    return {
      app,
      text: () => app.screen.toText(),
      async press(...keys) {
        for (const k of keys) send(k);
        await settle();
      },
      async type(s) {
        for (const ch of s) send(ch);
        await settle();
      },
      settle,
      until: (what) => settleUntil(app, what),
      stop: () => app.stop(),
    };
  }

  /** Dashboard → the repo → the file browser → `src/main.ts` in the editor. */
  async function openEditorOn(h: Harness, path: string): Promise<void> {
    await h.press("/");
    await h.type("workshop");
    await h.press("enter");
    await h.press("enter");
    await h.until("alice/workshop");
    await h.press("f");
    await h.settle();
    await h.press("t");
    await h.settle();
    await h.type(path.replace(/[^A-Za-z0-9]/g, ""));
    await h.press("enter");
    await h.settle();
    await h.press("e");
    await h.settle();
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-editor-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await signUp(forge, {
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-passphrase",
    });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const made = await createRepo(forge, alice, {
      name: "workshop",
      visibility: "public",
    });
    if (!made.ok) throw new Error("repo failed");
    repo = made.value;
    await commitToBranch(forge, alice, repo, {
      message: "seed",
      files: [
        { path: "README.md", content: "# Workshop\n" },
        { path: "src/main.ts", content: "export const one = 1;\n" },
      ],
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("type, undo, save: the commit lands on a new branch with a pull open", async () => {
    const h = boot();
    try {
      await h.settle();
      await openEditorOn(h, "srcmain");
      expect(h.text()).toContain("export const one");
      // The status line names the file and the caret.
      expect(h.text()).toContain("src/main.ts · Ln 1, Col 1");

      await h.press("end");
      await h.type("typo");
      expect(h.text()).toContain("modified");
      // Ctrl+Z reaches the editor: the loop swallows it only *after* the
      // screen has declined it, so an editor can own undo while a list
      // still cannot suspend a session that has no process group.
      await h.press("ctrl+z");
      await h.settle();
      // The coalesced run went in one step, so there is nothing left over.
      expect(h.text()).not.toContain("modified");

      await h.type(" // note");
      await h.press("ctrl+s");
      await h.settle();
      expect(h.text()).toContain("Commit src/main.ts");
      // The default target is a new branch named for the file, with the
      // subject prefilled — nothing here writes to a default branch by
      // accident.
      expect(h.text()).toContain("alice/edit-src-main-ts");
      expect(h.text()).toContain("Update src/main.ts");

      // Tab past the subject and body to the target, keep "new branch",
      // tab to the branch name, tab to the pull checkbox and tick it.
      await h.press("tab", "tab", "tab", "tab");
      await h.press(" ");
      expect(h.text()).toContain("[x] open a pull request");
      await h.press("ctrl+s");
      await h.until("pull #");

      // And it really is a commit, on that branch, with a pull.
      const fresh = getRepo(forge.db, "alice", "workshop")!;
      const dir = join(forge.reposRoot, "alice", "workshop.git");
      const blob = await blobForRender(
        dir,
        "alice/edit-src-main-ts",
        "src/main.ts",
        1 << 20,
      );
      expect(blob.kind).toBe("text");
      if (blob.kind === "text") expect(text(blob.body)).toContain("// note");
      // The default branch did not move.
      const onMain = await blobForRender(dir, "main", "src/main.ts", 1 << 20);
      if (onMain.kind === "text")
        expect(text(onMain.body)).not.toContain("// note");
      expect(getPull(forge.db, fresh.id, 1)).toBeDefined();
    } finally {
      h.stop();
    }
  });

  test("esc with unsaved changes asks before discarding", async () => {
    const h = boot();
    try {
      await h.settle();
      await openEditorOn(h, "README");
      await h.press("end");
      await h.type("!");
      await h.press("esc");
      await h.settle();
      expect(h.text()).toContain("Discard changes?");
      // Keeping is the default, and it really keeps.
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("modified");
    } finally {
      h.stop();
    }
  });

  test("ctrl+f finds, and the editor says when there is no match", async () => {
    const h = boot();
    try {
      await h.settle();
      await openEditorOn(h, "srcmain");
      await h.press("ctrl+f");
      await h.type("const");
      await h.press("enter");
      await h.settle();
      expect(h.text()).not.toContain("no match");
      await h.press("esc");
      await h.press("ctrl+f");
      await h.type("zzzz");
      await h.press("enter");
      await h.settle();
      expect(h.text()).toContain("no match");
    } finally {
      h.stop();
    }
  });

  test("D deletes a file through editFiles, on a branch", async () => {
    const h = boot();
    try {
      await h.settle();
      await h.press("/");
      await h.type("workshop");
      await h.press("enter");
      await h.press("enter");
      await h.until("alice/workshop");
      await h.press("f");
      await h.settle();
      // Row 0 is README.md at the root (src/ sorts after it in git's order,
      // so the cursor may be on either; find the file explicitly).
      await h.press("t");
      await h.settle();
      await h.type("README");
      await h.press("enter");
      await h.settle();
      await h.press("tab"); // back to the explorer, cursor on the file
      await h.press("D");
      await h.settle();
      expect(h.text()).toContain("Delete file");
      await h.press("right", "enter");
      await h.settle();
      expect(h.text()).toContain("Delete README.md");
      await h.press("ctrl+s");
      await h.until("committed to");
      const dir = join(forge.reposRoot, "alice", "workshop.git");
      const gone = await blobForRender(
        dir,
        "alice/edit-README-md",
        "README.md",
        1 << 20,
      );
      expect(gone.kind).toBe("missing");
      // …and only on that branch: a delete is a commit like any other.
      const still = await blobForRender(dir, "main", "README.md", 1 << 20);
      expect(still.kind).toBe("text");
    } finally {
      h.stop();
    }
  });
});

// ---- the external editor ----

describe("handing the terminal to $EDITOR", () => {
  let scriptDir: string;
  let script: string;

  beforeAll(async () => {
    scriptDir = await mkdtemp(join(tmpdir(), "forge-fake-editor-"));
    script = join(scriptDir, "fake-editor");
    // A tiny editor: append a line to whatever it is given, and exit. It
    // writes to the pty too, so the bytes really travel back through the
    // session the way nvim's would.
    await writeFile(
      script,
      `#!/usr/bin/env bun\n` +
        `const path = process.argv[2];\n` +
        `process.stdout.write("editing\\r\\n");\n` +
        `await Bun.write(path, (await Bun.file(path).text()) + "edited by hand\\n");\n`,
    );
    await chmod(script, 0o755);
  });

  afterAll(async () => {
    await rm(scriptDir, { recursive: true, force: true });
    delete process.env["FORGE_EDITOR"];
    forgetEditor();
  });

  test("with FORGE_EDITOR unset the feature is absent, and says how to get it", async () => {
    delete process.env["FORGE_EDITOR"];
    forgetEditor();
    const { editorHint, hasExternalEditor } =
      await import("../src/tui/screens/external.ts");
    expect(hasExternalEditor()).toBe(false);
    expect(editorHint()).toContain("FORGE_EDITOR=nvim");
  });

  test("a FORGE_EDITOR with an argument in it is refused, not split", async () => {
    process.env["FORGE_EDITOR"] = "code -w";
    forgetEditor();
    const { hasExternalEditor } =
      await import("../src/tui/screens/external.ts");
    // git passes `$EDITOR` through a shell so that "code -w" works. That is a
    // command-injection surface with no upside for one operator, so a name
    // with whitespace resolves to nothing rather than being tokenized.
    expect(hasExternalEditor()).toBe(false);
    delete process.env["FORGE_EDITOR"];
    forgetEditor();
  });

  test("the pty carries the editor's bytes out and the file's bytes back", async () => {
    process.env["FORGE_EDITOR"] = script;
    forgetEditor();
    const { hasExternalEditor } =
      await import("../src/tui/screens/external.ts");
    expect(hasExternalEditor()).toBe(true);

    // Drive the pty loop the way the screen does: suspend, spawn, resume.
    const dir = await mkdtemp(join(tmpdir(), "forge-edit-"));
    try {
      const file = join(dir, "note.txt");
      await writeFile(file, "before\n");
      const seen: string[] = [];
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data: (_t, chunk) => seen.push(new TextDecoder().decode(chunk)),
      });
      const proc = Bun.spawn([script, file], {
        terminal,
        env: { ...process.env, TERM: "xterm-256color" },
        cwd: dir,
      });
      // `proc.exited`, never the pty's own `exit` callback: that one is a pty
      // lifecycle event whose code is 0-for-EOF, and it fires after close().
      const code = await proc.exited;
      terminal.close();
      expect(code).toBe(0);
      expect(seen.join("")).toContain("editing");
      expect(await readFile(file, "utf8")).toBe("before\nedited by hand\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env["FORGE_EDITOR"];
      forgetEditor();
    }
  });

  test("the UI suspends and resumes around a handoff, resetting the cursor shape", async () => {
    const terminal = headlessTerminal(80, 24);
    const { App: LoopApp } = await import("../src/tui/app/app.ts");
    const app = new LoopApp({
      terminal,
      root: () => ({
        title: "Root",
        keys: [],
        render: () => undefined,
        key: () => false,
      }),
    });
    app.start();
    app.frame();
    terminal.takeOutput();

    let sawTerm: string | undefined;
    const result = await app.ctx.suspend(async (host) => {
      sawTerm = host.term;
      host.write(new TextEncoder().encode("child output"));
      return 7;
    });
    expect(result).toBe(7);
    // `Bun.Terminal`'s `name:` does not populate the child's TERM, so the
    // host has to hand it over; over a headless session there is none, and
    // the caller falls back rather than shipping `dumb`.
    expect(sawTerm).toBeUndefined();

    const out = terminal.output();
    // Suspend: modes off, wrap back ON (the renderer runs with ?7l and nvim
    // assumes wrap is on), alt screen left last.
    const leave = out.indexOf("\x1b[?1049l");
    expect(leave).toBeGreaterThan(-1);
    expect(out.indexOf("\x1b[?2004l")).toBeLessThan(leave);
    expect(out.indexOf("\x1b[?7h")).toBeLessThan(leave);
    // Resume: back into the alt screen, and the cursor shape reset — nvim
    // exits leaving `ESC[2 q` and never restores it.
    const enter = out.indexOf("\x1b[?1049h", leave);
    expect(enter).toBeGreaterThan(leave);
    expect(out.indexOf("\x1b[0 q", enter)).toBeGreaterThan(enter);
    expect(out.indexOf("\x1b[>0u", enter)).toBeGreaterThan(enter);
    // And the child's own bytes went straight through, unwrapped.
    expect(out).toContain("child output");
    app.stop();
  });

  test("a second suspend on the same session is refused, not nested", async () => {
    const terminal = headlessTerminal(80, 24);
    const { App: LoopApp } = await import("../src/tui/app/app.ts");
    const app = new LoopApp({
      terminal,
      root: () => ({
        title: "Root",
        keys: [],
        render: () => undefined,
        key: () => false,
      }),
    });
    app.start();
    let inner: unknown = "not run";
    await app.ctx.suspend(async () => {
      // Nested suspends are the failure mode behind every "my TUI wedged
      // after I shelled out" bug report, so the second one is a no-op.
      inner = await app.ctx.suspend(async () => "ran");
      return 0;
    });
    expect(inner).toBeUndefined();
    app.stop();
  });

  test("a session that ends mid-edit hangs up the editor and closes the pty", async () => {
    // An editor that never exits on its own: the shape of nvim waiting for
    // a keystroke from a client that has already disconnected.
    const sleeper = join(scriptDir, "sleeper");
    await writeFile(
      sleeper,
      `#!/bin/sh\n` +
        `trap 'echo hup > "$1.hup"; exit 0' HUP\n` +
        `echo started\n` +
        `while :; do sleep 0.05; done\n`,
    );
    await chmod(sleeper, 0o755);
    const { runEditor } = await import("../src/tui/screens/external.ts");

    const dir = await mkdtemp(join(tmpdir(), "forge-hup-"));
    try {
      const file = join(dir, "note.txt");
      await writeFile(file, "before\n");
      let seen = "";
      const host = {
        write: (bytes: Uint8Array) => {
          seen += new TextDecoder().decode(bytes);
        },
        onData: () => undefined,
        onResize: () => undefined,
        cols: 80,
        rows: 24,
        term: "xterm-256color",
        local: false,
      };
      const session = new AbortController();
      const running = runEditor(host, sleeper, file, dir, session.signal);
      const deadline = Date.now() + 5_000;
      while (!seen.includes("started") && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
      expect(seen).toContain("started");

      // The client is gone. Without the hangup this promise never settles,
      // the child holds a pty nobody reads, and the process never exits.
      session.abort();
      const code = await Promise.race([
        running,
        new Promise<"leaked">((r) => setTimeout(() => r("leaked"), 5_000)),
      ]);
      expect(code).not.toBe("leaked");
      expect(await readFile(`${file}.hup`, "utf8")).toBe("hup\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stopping the TUI mid-handoff aborts the screen the editor was opened from", async () => {
    // The wiring: the code screen hands its own abort signal to the
    // external editor, and `App.stop()` aborts every screen on the stack.
    // A dropped SSH channel is `terminal.onClose` → `stop()`.
    const terminal = headlessTerminal(80, 24);
    const { App: LoopApp } = await import("../src/tui/app/app.ts");
    let signal: AbortSignal | undefined;
    const app = new LoopApp({
      terminal,
      root: () => ({
        title: "Root",
        keys: [],
        render: () => undefined,
        key: () => false,
        load: async (s) => {
          signal = s;
        },
      }),
    });
    app.start();
    await settleApp(app);
    expect(signal?.aborted).toBe(false);
    let aborted = false;
    const suspended = app.ctx.suspend(
      () =>
        new Promise<number>((resolve) => {
          signal!.addEventListener("abort", () => {
            aborted = true;
            resolve(129);
          });
        }),
    );
    app.stop();
    expect(await suspended).toBe(129);
    expect(aborted).toBe(true);
  });

  test("nvim smoke: a real editor writes through the pty", async () => {
    const nvim = Bun.which("nvim");
    if (nvim === null) return; // not installed here; the fake editor covers the path
    const dir = await mkdtemp(join(tmpdir(), "forge-nvim-"));
    try {
      const file = join(dir, "note.txt");
      await writeFile(file, "before\n");
      const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => {} });
      const proc = Bun.spawn(
        [nvim, "-es", "-u", "NONE", "-c", "%s/before/after/", "-c", "wq", file],
        { terminal, env: { ...process.env, TERM: "xterm-256color" }, cwd: dir },
      );
      const code = await proc.exited;
      terminal.close();
      expect(code).toBe(0);
      expect(await readFile(file, "utf8")).toBe("after\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
