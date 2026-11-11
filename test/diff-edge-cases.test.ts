// Adversarial coverage for the diff engine (src/git/diff.ts) and the
// resource bounds around whole-file syntax highlighting in a diff
// (src/web/diff-syntax.ts, src/git/read.ts). Drives a real server + real
// git subprocesses; see docs/ARCHITECTURE.md for the shape being tested.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("diff engine + resource edge cases", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let token = "";

  const clientEnv = gitClientEnv({
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@forge.local",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@forge.local",
  });

  async function shOk(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(args, {
      cwd,
      env: clientEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`${args.join(" ")} failed: ${errText}`);
    return out.trim();
  }

  const dir = () => join(work, "engine");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-diffedge-"));
    work = await mkdtemp(join(tmpdir(), "forge-diffedgework-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.local",
      password: "analytical-engine",
    });

    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({
        name: "engine",
        visibility: "public",
        description: "d",
      }),
      redirect: "manual",
    });

    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "ada",
        password: "analytical-engine",
        name: "cli",
        scope: "rw",
      }),
    });
    token = ((await minted.json()) as { token: string }).token;
    const remote = `${base.replace("http://", `http://ada:${token}@`)}/ada/engine.git`;

    await shOk(["git", "clone", remote, "engine"], work);
    await buildHistory();
    // One push carries every scenario's commits: the server sees the same
    // objects it would from one push per test, at a fraction of the cost.
    await shOk(["git", "push", "origin", "main"], dir());
  });

  // Each scenario's commit, built once locally in beforeAll and pushed in one
  // go; tests only read the server's rendering of them.
  const oid: Record<string, string> = {};

  async function commit(key: string, message: string): Promise<void> {
    await shOk(["git", "add", "-A"], dir());
    await shOk(["git", "commit", "-m", message], dir());
    oid[key] = await shOk(["git", "rev-parse", "HEAD"], dir());
  }

  // Sized just past the caps in src/web/diff-view.ts (MAX_FILE_LINES 5000,
  // MAX_FILE_BYTES 100_000): far enough over to trip each cap, small enough
  // that git and the server move them in milliseconds.
  const HUGE_LINES = 6_000;
  const GIANT_LINE = 60_000;

  async function buildHistory(): Promise<void> {
    await Bun.write(join(dir(), "README.md"), "# init\n");
    await commit("root", "init");

    const bytes = new Uint8Array(2000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 5) % 256;
    await Bun.write(join(dir(), "blob.bin"), bytes);
    await Bun.write(join(dir(), "text.txt"), "hello\nworld\n");
    await commit("binary", "add binary + text");
    bytes.reverse();
    await Bun.write(join(dir(), "blob.bin"), bytes);
    await Bun.write(join(dir(), "text.txt"), "hello\nworld\nmodified\n");
    await commit("binaryModify", "modify binary + text");
    await shOk(["git", "rm", "-q", "blob.bin"], dir());
    await Bun.write(join(dir(), "text.txt"), "hello\nworld\nmodified\ndeleted\n");
    await commit("binaryDelete", "delete binary, modify text");

    await Bun.write(
      join(dir(), "renme-src.txt"),
      Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n",
    );
    await commit("renameBase", "add renme-src");
    await shOk(["git", "mv", "renme-src.txt", "renme-dst.txt"], dir());
    const renamed = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? `line ${i}` : `CHANGED ${i}`,
    );
    await Bun.write(join(dir(), "renme-dst.txt"), renamed.join("\n") + "\n");
    await commit("renamePartial", "rename+modify renme");
    await shOk(["git", "mv", "renme-dst.txt", "renme-final.txt"], dir());
    await commit("renamePure", "pure rename");

    await Bun.write(join(dir(), "文件名.txt"), "chinese filename content\n");
    await commit("unicode", "unicode filename");

    await Bun.write(join(dir(), "nonl.txt"), "line1\nline2\nline3");
    await commit("nonlAdd", "no trailing newline");
    await Bun.write(join(dir(), "nonl.txt"), "line1\nline2\nline3\nline4");
    await commit("nonlModify", "modify no trailing newline");

    await shOk(["git", "checkout", "-b", "feature"], dir());
    await Bun.write(join(dir(), "feature.txt"), "feature content\n");
    await commit("feature", "feature commit");
    await shOk(["git", "checkout", "main"], dir());
    await Bun.write(join(dir(), "mainline.txt"), "mainline content\n");
    await commit("mainline", "mainline commit");
    await shOk(["git", "merge", "--no-ff", "feature", "-m", "merge feature"], dir());
    oid.merge = await shOk(["git", "rev-parse", "HEAD"], dir());

    await Bun.write(join(dir(), "chmod-me.sh"), "#!/bin/sh\necho hi\n");
    await commit("chmodBase", "add chmod-me");
    await shOk(["chmod", "+x", join(dir(), "chmod-me.sh")], dir());
    await commit("chmod", "chmod only");

    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) lines.push(`orig line ${i}`);
    await Bun.write(join(dir(), "multihunk.txt"), lines.join("\n") + "\n");
    await commit("multihunkBase", "add multihunk base");
    const lines2 = [...lines];
    lines2[4] = "CHANGED near top"; // old/new line 5
    lines2[94] = "CHANGED near bottom"; // old/new line 95
    await Bun.write(join(dir(), "multihunk.txt"), lines2.join("\n") + "\n");
    await commit("multihunk", "modify multihunk two spots");

    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        Bun.write(join(dir(), `many/file-${i}.txt`), `content ${i}\n`),
      ),
    );
    await commit("many", "touch 300 files");

    // Short lines, so only the line-count cap can fire: HUGE_LINES lines of
    // at most 5 characters stay well under MAX_FILE_BYTES and MAX_LINE_WIDTH.
    const big = Array.from({ length: HUGE_LINES }, (_, i) => `L${i}`);
    await Bun.write(join(dir(), "huge.txt"), big.join("\n") + "\n");
    await commit("huge", `add huge file ${HUGE_LINES} lines`);

    await Bun.write(join(dir(), "hugeline.txt"), "x".repeat(GIANT_LINE) + "\n");
    await commit("hugelineBase", "add file with one giant line");
    await Bun.write(join(dir(), "hugeline.txt"), "y".repeat(GIANT_LINE) + "\n");
    await commit("hugeline", "modify the giant line");
  }

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const page = async (key: string): Promise<Response> =>
    fetch(`${base}/ada/engine/commit/${oid[key]}`);

  test("binary add/modify/delete does not corrupt subsequent file parsing", async () => {
    // Invariant: a binary section in a diff is stubbed and the text file after it still parses.
    // blob.bin sorts before text.txt, so the text section follows the binary one.
    const cases: Array<[string, string]> = [
      ["binary", "hello"],
      ["binaryModify", "modified"],
      ["binaryDelete", "deleted"],
    ];
    for (const [key, textLine] of cases) {
      const text = await (await page(key)).text();
      expect(text).toContain("Binary file not shown");
      expect(text).toContain("blob.bin");
      expect(text).toContain("text.txt");
      expect(text).toContain(textLine);
    }
  });

  test("rename with partial similarity keeps old/new path and hunk content", async () => {
    // Invariant: a rename-with-edits shows both paths and its hunk.
    const text = await (await page("renamePartial")).text();
    expect(text).toContain("renme-src.txt");
    expect(text).toContain("renme-dst.txt");
    expect(text).toContain("CHANGED");
  });

  test("pure rename (100% similarity) produces no hunks but shows both paths", async () => {
    // Invariant: a hunkless pure rename still names old and new path.
    const text = await (await page("renamePure")).text();
    expect(text).toContain("renme-dst.txt");
    expect(text).toContain("renme-final.txt");
  });

  // git quotes non-ASCII paths with C-style octal byte escapes
  // (`"\346\226\207..."`) by default; unquotePath collects those bytes and
  // decodes them as UTF-8, so the real name survives — in the displayed path
  // and in the oldPath/newPath the highlighter keys blob lookups on.
  test("unicode filenames survive as real UTF-8", async () => {
    // Invariant: git's octal-quoted path decodes to the real UTF-8 name.
    const text = await (await page("unicode")).text();
    expect(text).toContain("chinese filename content");
    expect(text).toContain("文件名.txt"); // the real name, not mojibake
  });

  test("no-newline-at-eof marker on add and modify", async () => {
    // Invariant: "\ No newline at end of file" neither crashes nor swallows the next line.
    const page1 = await (await page("nonlAdd")).text();
    expect(page1).toContain("nonl"); // renders without crashing
    const resp2 = await page("nonlModify");
    expect(resp2.status).toBe(200);
    expect(await resp2.text()).toContain("line4");
  });

  test("root commit (no parent) diffs cleanly against the empty tree", async () => {
    // Invariant: a parentless commit diffs against the empty tree.
    const resp = await page("root");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("init");
  });

  test("merge commit does not crash and returns 200", async () => {
    // Invariant: a two-parent commit renders.
    const resp = await page("merge");
    expect(resp.status).toBe(200);
  });

  test("mode-only change (chmod +x) with no content diff renders cleanly", async () => {
    // Invariant: a mode change with no hunks says so instead of rendering an empty table.
    const resp = await page("chmod");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("No content changes");
  });

  test("multi-hunk file: second hunk's line numbers are exactly correct (no off-by-one)", async () => {
    // Invariant: each hunk's rows carry the line numbers from its own header.
    const text = await (await page("multihunk")).text();
    // Word-diff highlighting splits row text into per-token <span>s, so we
    // can't search for the literal phrase; instead find each token and
    // check the nearest preceding `<td class="dn">N</td>` line-number cell.
    function lineNumberBefore(token: string): string {
      const idx = text.indexOf(token);
      expect(idx).toBeGreaterThan(-1);
      const before = text.slice(Math.max(0, idx - 600), idx);
      const matches = [...before.matchAll(/<td class="dn">(\d+)<\/td>/g)];
      return matches[matches.length - 1]![1]!;
    }
    expect(lineNumberBefore(">CHANGED<")).toBeTruthy();
    // First hunk: the add row for "CHANGED near top" is new-line 5, in the
    // second <td class="dn"> column (old is empty for an add row).
    const topIdx = text.indexOf("CHANGED");
    const topSnippet = text.slice(Math.max(0, topIdx - 500), topIdx);
    expect(topSnippet).toContain('<td class="dn">5</td>');
    const bottomIdx = text.lastIndexOf("CHANGED");
    const bottomSnippet = text.slice(Math.max(0, bottomIdx - 500), bottomIdx);
    expect(bottomSnippet).toContain('<td class="dn">95</td>');
  });

  // ---- Resource / DoS ----

  // A commit touching many trivial files once cost a `git cat-file` spawn per
  // file in diffSyntax(); MAX_DIFF_FILES (100) in diff-view.ts now bounds the
  // files rendered and highlighted, and says how many it left out.
  test("MAX_DIFF_FILES: a 300-file commit page answers 200 rendering 100 files and naming the rest", async () => {
    // Invariant: past MAX_DIFF_FILES the page renders exactly that many files and counts the hidden ones.
    const resp = await page("many");
    const text = await resp.text();
    expect(resp.status).toBe(200);
    const shown = new Set(text.match(/many\/file-\d+\.txt/g) ?? []);
    expect(shown.size).toBe(100);
    expect(text).toContain("200 more files not");
  });

  test("MAX_FILE_LINES caps a single huge file instead of rendering it", async () => {
    // Invariant: a file over MAX_FILE_LINES changed lines is a stub naming its count, none of its lines on the wire.
    const resp = await page("huge");
    const text = await resp.text();
    expect(resp.status).toBe(200);
    expect(text).toContain("huge.txt");
    expect(text).toContain("Diff not shown");
    expect(text).toContain(`${HUGE_LINES.toLocaleString()} changed lines`);
    expect(text).not.toContain(`>L${HUGE_LINES - 1}<`);
    expect(text.length).toBeLessThan(500_000);
  });

  test("MAX_FILE_BYTES bounds a file that is few lines but huge in bytes (single giant line)", async () => {
    // Invariant: a one-line change over MAX_FILE_BYTES of diff is a stub, and neither giant line reaches the page.
    const resp = await page("hugeline");
    const text = await resp.text();
    expect(resp.status).toBe(200);
    expect(text).toContain("hugeline.txt");
    expect(text).toContain("Diff not shown");
    expect(text).toContain("bytes of diff");
    expect(text.length).toBeLessThan(500_000);
    // The changed-line count (1) is far under MAX_FILE_LINES: only the byte
    // bound keeps either giant line off the page.
    expect(text).not.toContain("x".repeat(1_000));
    expect(text).not.toContain("y".repeat(1_000));
  });
});
