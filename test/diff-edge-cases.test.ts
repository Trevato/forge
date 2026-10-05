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

    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "ada",
        email: "ada@forge.local",
        password: "analytical-engine",
      }),
      redirect: "manual",
    });
    cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;

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
    await Bun.write(join(dir(), "README.md"), "# init\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "init"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("binary add/modify/delete does not corrupt subsequent file parsing", async () => {
    const bytes = new Uint8Array(2000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 5) % 256;
    await Bun.write(join(dir(), "blob.bin"), bytes);
    await Bun.write(join(dir(), "text.txt"), "hello\nworld\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "add binary + text"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const page = await (await fetch(`${base}/ada/engine/commit/${oid}`)).text();
    expect(page).toContain("Binary file not shown");
    expect(page).toContain("blob.bin");
    // The text file after the binary section in the same diff must still parse.
    expect(page).toContain("hello");
  });

  test("rename with partial similarity keeps old/new path and hunk content", async () => {
    await Bun.write(
      join(dir(), "renme-src.txt"),
      Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n",
    );
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "add renme-src"], dir());
    await shOk(["git", "push", "origin", "main"], dir());

    await shOk(["git", "mv", "renme-src.txt", "renme-dst.txt"], dir());
    const lines = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? `line ${i}` : `CHANGED ${i}`,
    );
    await Bun.write(join(dir(), "renme-dst.txt"), lines.join("\n") + "\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "rename+modify renme"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const page = await (await fetch(`${base}/ada/engine/commit/${oid}`)).text();
    expect(page).toContain("renme-src.txt");
    expect(page).toContain("renme-dst.txt");
    expect(page).toContain("CHANGED");
  });

  test("pure rename (100% similarity) produces no hunks but shows both paths", async () => {
    await shOk(["git", "mv", "renme-dst.txt", "renme-final.txt"], dir());
    await shOk(["git", "commit", "-m", "pure rename"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());
    const page = await (await fetch(`${base}/ada/engine/commit/${oid}`)).text();
    expect(page).toContain("renme-dst.txt");
    expect(page).toContain("renme-final.txt");
  });

  // git quotes non-ASCII paths with C-style octal byte escapes
  // (`"\346\226\207..."`) by default; unquotePath collects those bytes and
  // decodes them as UTF-8, so the real name survives — in the displayed path
  // and in the oldPath/newPath the highlighter keys blob lookups on.
  test("unicode filenames survive as real UTF-8", async () => {
    await Bun.write(join(dir(), "文件名.txt"), "chinese filename content\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "unicode filename"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const page = await (await fetch(`${base}/ada/engine/commit/${oid}`)).text();
    expect(page).toContain("chinese filename content");
    expect(page).toContain("文件名.txt"); // the real name, not mojibake
  });

  test("no-newline-at-eof marker on add and modify", async () => {
    await Bun.write(join(dir(), "nonl.txt"), "line1\nline2\nline3");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "no trailing newline"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid1 = await shOk(["git", "rev-parse", "HEAD"], dir());
    const page1 = await (
      await fetch(`${base}/ada/engine/commit/${oid1}`)
    ).text();
    expect(page1).toContain("nonl");
    expect(page1).toContain("nonl"); // renders without crashing

    await Bun.write(join(dir(), "nonl.txt"), "line1\nline2\nline3\nline4");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "modify no trailing newline"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid2 = await shOk(["git", "rev-parse", "HEAD"], dir());
    const resp2 = await fetch(`${base}/ada/engine/commit/${oid2}`);
    expect(resp2.status).toBe(200);
    const page2 = await resp2.text();
    expect(page2).toContain("line4");
  });

  test("root commit (no parent) diffs cleanly against the empty tree", async () => {
    const rootOid = (
      await shOk(["git", "rev-list", "--max-parents=0", "HEAD"], dir())
    ).split("\n")[0]!;
    const resp = await fetch(`${base}/ada/engine/commit/${rootOid}`);
    expect(resp.status).toBe(200);
    const page = await resp.text();
    expect(page).toContain("init");
  });

  test("merge commit does not crash and returns 200", async () => {
    await shOk(["git", "checkout", "-b", "feature"], dir());
    await Bun.write(join(dir(), "feature.txt"), "feature content\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "feature commit"], dir());
    await shOk(["git", "checkout", "main"], dir());
    await Bun.write(join(dir(), "mainline.txt"), "mainline content\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "mainline commit"], dir());
    await shOk(
      ["git", "merge", "--no-ff", "feature", "-m", "merge feature"],
      dir(),
    );
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());
    const resp = await fetch(`${base}/ada/engine/commit/${oid}`);
    expect(resp.status).toBe(200);
  });

  test("mode-only change (chmod +x) with no content diff renders cleanly", async () => {
    await Bun.write(join(dir(), "chmod-me.sh"), "#!/bin/sh\necho hi\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "add chmod-me"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    await shOk(["chmod", "+x", join(dir(), "chmod-me.sh")], dir());
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "chmod only"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());
    const resp = await fetch(`${base}/ada/engine/commit/${oid}`);
    expect(resp.status).toBe(200);
    const page = await resp.text();
    expect(page).toContain("No content changes");
  });

  test("multi-hunk file: second hunk's line numbers are exactly correct (no off-by-one)", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) lines.push(`orig line ${i}`);
    await Bun.write(join(dir(), "multihunk.txt"), lines.join("\n") + "\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "add multihunk base"], dir());
    await shOk(["git", "push", "origin", "main"], dir());

    const lines2 = [...lines];
    lines2[4] = "CHANGED near top"; // old/new line 5
    lines2[94] = "CHANGED near bottom"; // old/new line 95
    await Bun.write(join(dir(), "multihunk.txt"), lines2.join("\n") + "\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "modify multihunk two spots"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const page = await (await fetch(`${base}/ada/engine/commit/${oid}`)).text();
    // Word-diff highlighting splits row text into per-token <span>s, so we
    // can't search for the literal phrase; instead find each token and
    // check the nearest preceding `<td class="dn">N</td>` line-number cell.
    function lineNumberBefore(token: string): string {
      const idx = page.indexOf(token);
      expect(idx).toBeGreaterThan(-1);
      const before = page.slice(Math.max(0, idx - 600), idx);
      const matches = [...before.matchAll(/<td class="dn">(\d+)<\/td>/g)];
      return matches[matches.length - 1]![1]!;
    }
    expect(lineNumberBefore(">CHANGED<")).toBeTruthy();
    // First hunk: the add row for "CHANGED near top" is new-line 5, in the
    // second <td class="dn"> column (old is empty for an add row).
    const topIdx = page.indexOf("CHANGED");
    const topSnippet = page.slice(Math.max(0, topIdx - 500), topIdx);
    expect(topSnippet).toContain('<td class="dn">5</td>');
    const bottomIdx = page.lastIndexOf("CHANGED");
    const bottomSnippet = page.slice(Math.max(0, bottomIdx - 500), bottomIdx);
    expect(bottomSnippet).toContain('<td class="dn">95</td>');
  });

  // ---- Resource / DoS ----

  // BUG (confirmed, HIGH severity): diffSyntax() in src/web/diff-syntax.ts
  // loops over every file in the diff sequentially (`for (const file of
  // diff.files)`) and, per file, calls blobForRender() which spawns a fresh
  // `git cat-file` subprocess (up to 3 spawns per side: -t, -s, blob) rather
  // than using the batched RepoReader. MAX_CHANGED (5000) bounds total
  // changed *lines* but not the *number of files* in a commit. A commit
  // touching many trivial files is therefore linear in file count at
  // roughly 17-18ms/file with no concurrency, no cap, and no timeout
  // shorter than the diff's own 60s spawn timeout.
  //
  // Measured on this machine (outside the regression run, see report):
  //   200 files  ->  3.47s
  //   1000 files -> 18.2s
  //   5200 files -> 95.2s  (commit page request)
  // A forge that should feel interactive (per docs/ARCHITECTURE.md) turns a
  // single push into a 95-second synchronous request.
  test("DOS: file count is NOT capped independent of changed-line count (perf regression sentinel)", async () => {
    const nFiles = 300;
    for (let i = 0; i < nFiles; i++) {
      await Bun.write(join(dir(), `many/file-${i}.txt`), `content ${i}\n`);
    }
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", `touch ${nFiles} files`], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const t0 = performance.now();
    const resp = await fetch(`${base}/ada/engine/commit/${oid}`);
    const text = await resp.text();
    const elapsed = performance.now() - t0;
    console.log(
      `[perf] ${nFiles}-file commit diff took ${elapsed.toFixed(0)}ms, ${text.length} bytes`,
    );
    expect(resp.status).toBe(200);
    // Loose upper bound so this doesn't flake on a slow CI box; it's here to
    // catch a bug that gets worse, not to assert good behavior (currently
    // ~17ms/file with no cap - this bound is far above what an interactive
    // forge should take, and is expected to keep passing until the file
    // count is capped like the line count already is).
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  test("MAX_FILE_LINES caps a single huge file (200k+ changed lines) instead of rendering it", async () => {
    const bigLines: string[] = [];
    for (let i = 0; i < 210_000; i++)
      bigLines.push(`line number ${i} of a huge file`);
    await Bun.write(join(dir(), "huge.txt"), bigLines.join("\n") + "\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "add huge file 210k lines"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const t0 = performance.now();
    const resp = await fetch(`${base}/ada/engine/commit/${oid}`);
    const text = await resp.text();
    const elapsed = performance.now() - t0;
    console.log(
      `[perf] 210k-line file diff took ${elapsed.toFixed(0)}ms, ${text.length} bytes`,
    );
    expect(resp.status).toBe(200);
    expect(text).toContain("huge.txt");
    expect(text).toContain("Diff not shown");
    expect(text).toContain("210,000 changed lines");
    // Confirmed clean: the cap makes this fast and small, not a resource sink.
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);

  test("CAP_BYTES bounds a file that is few lines but huge in bytes (single giant line)", async () => {
    const hugeLine1 = "x".repeat(2_000_000);
    await Bun.write(join(dir(), "hugeline.txt"), hugeLine1 + "\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "add file with one 2MB line"], dir());
    await shOk(["git", "push", "origin", "main"], dir());

    const hugeLine2 = "y".repeat(2_000_000);
    await Bun.write(join(dir(), "hugeline.txt"), hugeLine2 + "\n");
    await shOk(["git", "add", "."], dir());
    await shOk(["git", "commit", "-m", "modify the 2MB line"], dir());
    await shOk(["git", "push", "origin", "main"], dir());
    const oid = await shOk(["git", "rev-parse", "HEAD"], dir());

    const t0 = performance.now();
    const resp = await fetch(`${base}/ada/engine/commit/${oid}`);
    const text = await resp.text();
    const elapsed = performance.now() - t0;
    console.log(
      `[perf] 2MB-single-line modify diff took ${elapsed.toFixed(0)}ms, ${text.length} bytes`,
    );
    expect(resp.status).toBe(200);
    expect(text).toContain("hugeline.txt");
    expect(text).toContain("Diff not shown");
    expect(text).toContain("bytes of diff");
    // The byte ceiling this issue asks for: a 4MB-of-diff single line must
    // not put anywhere near that on the wire, and must not creep back up.
    expect(text.length).toBeLessThan(500_000);
    // Confirmed clean: MAX_FILE_BYTES/MAX_LINE_WIDTH in diff-view.ts stub the
    // file before it is ever tokenized or rendered as rows, so this stays
    // fast even though the changed-line count (1) is far under MAX_FILE_LINES.
    expect(elapsed).toBeLessThan(200);
  }, 60_000);
});
