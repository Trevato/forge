/**
 * Notebooks, JSON Lines and logs in the terminal workspace: pure views first,
 * then each kind opened in a real headless workspace, `s` flipping to source,
 * and a malformed file of each kind falling back to the source.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal, type HeadlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { logLevel } from "../src/web/render/log.ts";
import { jsonlTable, kindView, logLines, LINE_CAP, notebookLines, ROW_CAP } from "../src/tui/screens/workspace_kinds.ts";

quietLogs();
const c = theme("dark").c;

const NB = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Title\n", "prose"] },
    { cell_type: "code", execution_count: 3, source: "print(1 < 2)", outputs: [{ output_type: "stream", text: "True & done\n" }] },
    { cell_type: "code", source: "boom()", outputs: [{ output_type: "error", ename: "E", evalue: "bad", traceback: ["Trace line"] }] },
  ],
});

describe("kind views, pure", () => {
  test("a notebook's cells in order, code dimmed, outputs as text", () => {
    const v = notebookLines(NB, c)!;
    const at = (s: string): number => v.plain.findIndex((l) => l.includes(s));
    expect(at("Title")).toBeGreaterThanOrEqual(0);
    expect(at("Title")).toBeLessThan(at("print(1 < 2)"));
    expect(at("print(1 < 2)")).toBeLessThan(at("True & done"));
    expect(at("True & done")).toBeLessThan(at("boom()"));
    expect(v.lines[at("print(1 < 2)")]![0]!.style.fg).toBe(c.faint);
    expect(v.lines[at("Trace line")]![0]!.style.fg).toBe(c.danger);
    expect(v.plain.join("\n")).not.toContain("<pre");
    expect(v.plain.join("\n")).not.toContain("&amp;");
  });
  test("a malformed notebook has no view", () => {
    expect(kindView("a.ipynb", "{not json", c)).toBeNull();
    expect(kindView("a.ipynb", '{"nope":1}', c)).toBeNull();
  });
  test("jsonl rows become a table, capped with the rest counted", () => {
    const text = Array.from({ length: ROW_CAP + 7 }, (_, i) => JSON.stringify({ id: i, name: `n${i}` })).join("\n");
    const t = jsonlTable(text)!;
    expect(t.header).toEqual(["id", "name"]);
    expect(t.rows.length).toBe(ROW_CAP);
    expect(t.more).toBe(7);
  });
  test("jsonl: a bad line is a row, a file of only bad lines has no view", () => {
    const t = jsonlTable('{"a":1}\nnot json\n{"a":2}')!;
    expect(t.rows[1]![0]).toContain("Line 2");
    expect(jsonlTable("nope\nstill nope")).toBeNull();
    expect(jsonlTable("")).toBeNull();
  });
  test("a log is coloured by its escapes, else by the level it states", () => {
    const v = logLines("\x1b[32mgreen\x1b[0m\nERROR boom\nWARN hmm\nplain\nDEBUG x\n", c);
    const l = v.lines;
    expect(v.plain).toEqual(["green", "ERROR boom", "WARN hmm", "plain", "DEBUG x"]);
    expect(l[0]![0]!.style.fg).toBe(c.success);
    expect(l[1]![0]!.style.fg).toBe(c.danger);
    expect(l[2]![0]!.style.fg).toBe(c.attn);
    expect(l[3]![0]!.style.fg).toBe(c.fg);
    expect(l[4]![0]!.style.fg).toBe(c.faint);
    expect(logLevel("all fine")).toBeUndefined();
  });
  test("only a leading level token colours a line, never prose", () => {
    for (const prose of ["no errors found", "0 failed", "Error handling is next", "the warning is gone", "retry failed once"])
      expect(logLevel(prose)).toBeUndefined();
    expect(logLevel("2026-01-02T03:04:05Z ERROR boom")).toBe("error");
    expect(logLevel("[03:04:05] WARN hmm")).toBe("warn");
    expect(logLevel("[error] x")).toBe("error");
    expect(logLevel("ts=1 level=error msg=x")).toBe("error");
    expect(logLevel("DEBUG x")).toBe("debug");
  });
  test("a long log says how many lines it leaves out", () => {
    const v = logLines("x\n".repeat(LINE_CAP + 5), c);
    expect(v.plain[v.plain.length - 1]).toBe("5 more lines not shown");
  });
  test("a long notebook says how many lines it leaves out", () => {
    const nb = JSON.stringify({ cells: [{ cell_type: "code", source: "x\n".repeat(LINE_CAP + 5), outputs: [] }] });
    expect(notebookLines(nb, c)!.plain.at(-1)).toMatch(/more lines? not shown$/);
  });
  test("markdown cells keep their lines and headings are bold", () => {
    const v = notebookLines(JSON.stringify({ cells: [{ cell_type: "markdown", source: "# Head\n- a\n- b" }] }), c)!;
    expect(v.plain.slice(0, 3)).toEqual(["# Head", "- a", "- b"]);
  });
  test("malformed logs: empty, NUL bytes, one very long line", () => {
    expect(logLines("", c).plain.join("")).toBe("");
    const nul = logLines("a\x00b\x01c\n", c);
    expect(nul.plain).toEqual(["abc"]);
    const long = logLines("y".repeat(200_000), c);
    expect(long.plain.length).toBe(1);
    expect(kindView("a.log", "", c)).not.toBeUndefined();
  });
  test("a hostile log never carries an escape or markup into the view", () => {
    const v = logLines("\x1b]0;t\x07<b>x</b> \x1b[2J &amp;\n", c);
    expect(v.plain).toEqual(["<b>x</b>  &amp;"]);
  });
  test("other files have no kind view", () => {
    expect(kindView("a.ts", "x", c)).toBeNull();
  });
});

describe("the workspace opens each kind", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;

  const identity = (): TuiIdentity => ({ sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice });
  interface Harness { text(): string; press(...k: string[]): Promise<void>; type(t: string): Promise<void>; settle(): Promise<void>; until(w: string): Promise<void>; stop(): void }

  function boot(cols = 120, rows = 40): Harness {
    const terminal: HeadlessTerminal = headlessTerminal(cols, rows);
    const { app } = createForgeApp(forge, identity(), { terminal, exitHooks: false });
    app.start();
    const settle = (): Promise<void> => settleApp(app);
    const send = (key: string): void => {
      const ctrl = key.startsWith("ctrl+");
      app.dispatch({ type: "key", key: ctrl ? key.slice(5) : key, ctrl, alt: false, shift: false });
    };
    return {
      text: () => app.screen.toText(),
      async press(...keys) { for (const k of keys) send(k); await settle(); },
      async type(t) { for (const ch of t) send(ch); await settle(); },
      settle,
      until: (w) => settleUntil(app, w),
      stop: () => app.stop(),
    };
  }
  async function open(h: Harness, name: string): Promise<void> {
    await h.press("/");
    await h.type(name);
    await h.press("enter");
    await h.press("enter");
    await h.until(`alice/${name}`);
  }
  async function openFile(h: Harness, query: string): Promise<void> {
    await h.press("t");
    await h.settle();
    await h.type(query);
    await h.press("enter");
    await h.settle();
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-kinds-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const made = await createRepo(forge, alice, { name: "kinds", visibility: "public", description: "files" });
    if (!made.ok) throw new Error("repo failed");
    const rows = Array.from({ length: ROW_CAP + 3 }, (_, i) => JSON.stringify({ id: i, who: `person${i}` })).join("\n");
    await commitToBranch(forge, alice, made.value, {
      message: "seed",
      files: [
        { path: "good.ipynb", content: NB },
        { path: "bad.ipynb", content: "{not json" },
        { path: "rows.jsonl", content: rows },
        { path: "bad.jsonl", content: "nope\nnope" },
        { path: "run.log", content: "INFO started\n\x1b[32mERROR kaboom\x1b[0m\n" },
        { path: "empty.log", content: "" },
        { path: "nul.log", content: "a\x00b\nline two\n" },
      ],
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an .ipynb reads as cells; s shows the JSON; a malformed one is source already", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h, "kinds");
      await openFile(h, "good.ipynb");
      expect(h.text()).toContain("True & done");
      expect(h.text()).not.toContain("cell_type");
      await h.press("s");
      expect(h.text()).toContain("cell_type");
      await openFile(h, "bad.ipynb");
      expect(h.text()).toContain("{not json");
    } finally {
      h.stop();
    }
  });

  test("a .jsonl reads as a table with the cap said; s shows the source", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h, "kinds");
      await openFile(h, "rows.jsonl");
      expect(h.text()).toContain("person0");
      expect(h.text()).toContain("3 more rows not shown");
      await h.press("s");
      expect(h.text()).toContain('{"id":0');
      await openFile(h, "bad.jsonl");
      expect(h.text()).toContain("nope");
    } finally {
      h.stop();
    }
  });

  test("a .log reads without its escapes; s shows the bytes, so the view changes", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h, "kinds");
      await openFile(h, "run.log");
      expect(h.text()).toContain("ERROR kaboom");
      expect(h.text()).not.toContain("[32m");
      const before = h.text();
      await h.press("s");
      expect(h.text()).not.toBe(before);
      expect(h.text()).toContain("INFO started");
      await h.press("s");
      expect(h.text()).toBe(before);
    } finally {
      h.stop();
    }
  });

  test("an empty .log and a .log with NUL bytes open without breaking", async () => {
    const h = boot();
    try {
      await h.settle();
      await open(h, "kinds");
      await openFile(h, "nul.log");
      expect(h.text()).toContain("Binary file");
      await openFile(h, "empty.log");
      expect(h.text()).toContain("alice/kinds");
    } finally {
      h.stop();
    }
  });
});
