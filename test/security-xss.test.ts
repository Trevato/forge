/**
 * Adversarial coverage for diff/highlight/blob rendering: hostile file
 * content, paths, commit messages, and hunk section headers must never
 * produce unescaped markup in the rendered HTML. Also covers the
 * highlighter/word-diff robustness spec (huge lines, invalid UTF-8, CRLF
 * mismatch) end to end through a real running server and real git pushes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { seedAdmin } from "./helpers/admin.ts";

const clientEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@forge.local",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@forge.local",
});

async function sh(args: string[], cwd: string) {
  const proc = Bun.spawn(args, {
    cwd,
    env: clientEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}
async function shOk(args: string[], cwd: string) {
  const r = await sh(args, cwd);
  if (r.code !== 0) throw new Error(`${args.join(" ")} failed: ${r.err}`);
  return r.out;
}

describe("XSS through diff/highlight rendering (real server, real git)", () => {
  let dataDir: string, work: string, app: App, servers: Servers, base: string;
  let token = "";
  let dir: string;

  const api = (path: string, init?: RequestInit & { token?: boolean }) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    if (init?.token !== false && token !== "")
      headers.set("authorization", `Bearer ${token}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-xss-"));
    work = await mkdtemp(join(tmpdir(), "forge-xsswork-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.local",
      password: "correct-horse-battery",
    });
    const minted = await api("/api/v1/tokens", {
      method: "POST",
      token: false,
      body: JSON.stringify({ adminConfirm: true,
        username: "alice",
        password: "correct-horse-battery",
        name: "cli",
        scope: "admin",
      }),
    });
    token = ((await minted.json()) as { token: string }).token;

    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "app", description: "x" }),
    });
    const remote = `${base.replace("http://", `http://alice:${token}@`)}/alice/app.git`;
    await shOk(["git", "clone", remote, "app"], work);
    dir = join(work, "app");
    await Bun.write(join(dir, "README.md"), "# app\n");
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "genesis"], dir);
    await shOk(["git", "push", "origin", "main"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("file content that tries to break out of a highlighter span", async () => {
    await Bun.write(join(dir, "evil.ts"), "</span><script>alert(1)</script>");
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "add evil file"], dir);
    await shOk(["git", "push"], dir);

    const commit = await shOk(["git", "rev-parse", "HEAD"], dir);
    const diffBody = await (await api(`/alice/app/commit/${commit}`)).text();
    expect(diffBody).not.toContain("<script>alert(1)</script>");

    const blobBody = await (await api(`/alice/app/blob/main/evil.ts`)).text();
    expect(blobBody).not.toContain("<script>alert(1)</script>");
  });

  test('string-literal content that tries to break out of class="..."', async () => {
    const payload = 'const x = "\\"><script>alert(2)</script>";\n';
    await Bun.write(join(dir, "attr.ts"), payload);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "attr breakout"], dir);
    await shOk(["git", "push"], dir);
    const body = await (await api(`/alice/app/blob/main/attr.ts`)).text();
    expect(body).not.toContain("<script>alert(2)</script>");
    expect(body).not.toMatch(/class="[^"]*"[^>]*>alert\(2\)/);
  });

  test("renamed file path with HTML metacharacters", async () => {
    await Bun.write(join(dir, "orig.txt"), "hello\n");
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "add orig"], dir);
    await shOk(["git", "push"], dir);

    const evilName = `"><img src=x onerror=alert(3)>.txt`;
    await shOk(["git", "mv", "orig.txt", evilName], dir);
    await shOk(["git", "commit", "-m", "rename to evil"], dir);
    await shOk(["git", "push"], dir);

    const commit = await shOk(["git", "rev-parse", "HEAD"], dir);
    const body = await (await api(`/alice/app/commit/${commit}`)).text();
    expect(body).not.toContain("<img src=x onerror=alert(3)>");
    expect(body).toContain("&lt;img src=x onerror=alert(3)&gt;");
  });

  test("commit message with script tags, ampersand, and quotes", async () => {
    await Bun.write(join(dir, "msgtest.txt"), "a\n");
    await shOk(["git", "add", "."], dir);
    await shOk(
      [
        "git",
        "commit",
        "-m",
        `evil <script>alert(4)</script> & "quoted" 'single'`,
      ],
      dir,
    );
    await shOk(["git", "push"], dir);
    const body = await (await api(`/alice/app/commits`)).text();
    expect(body).not.toContain("<script>alert(4)</script>");
  });

  test("branch name with & and ' renders escaped in page title", async () => {
    const branchName = "feature/a&b'c";
    const r = await sh(["git", "checkout", "-b", branchName], dir);
    if (r.code === 0) {
      await shOk(["git", "push", "-u", "origin", branchName], dir);
      const body = await (
        await api(`/alice/app/tree/${encodeURIComponent(branchName)}`)
      ).text();
      expect(body).toContain("feature/a&amp;b&#39;c");
      await shOk(["git", "checkout", "main"], dir);
    }
  });

  test("hunk section heading (function signature) is escaped", async () => {
    let content = "function normal() {\n  return 1;\n}\n\n";
    for (let i = 0; i < 30; i++) content += `// pad ${i}\n`;
    content += `function evil"><script>alert(5)</script>(x) {\n  return x + 1;\n}\n`;
    await Bun.write(join(dir, "sect.ts"), content);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "add sect.ts"], dir);
    await shOk(["git", "push"], dir);

    const lines = content.split("\n");
    const targetIdx = lines.findIndex((l) => l.includes("return x + 1"));
    lines[targetIdx] = "  return x + 2;";
    await Bun.write(join(dir, "sect.ts"), lines.join("\n"));
    await shOk(["git", "commit", "-am", "tweak"], dir);
    await shOk(["git", "push"], dir);

    const commit = await shOk(["git", "rev-parse", "HEAD"], dir);
    const body = await (await api(`/alice/app/commit/${commit}`)).text();
    expect(body).not.toContain("<script>alert(5)</script>");
  });

  test("1MB-ish single line renders quickly (no tokenizer blowup)", async () => {
    const big = "x".repeat(900_000);
    await Bun.write(join(dir, "huge.ts"), `const y = "${big}";\n`);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "huge line"], dir);
    await shOk(["git", "push"], dir);
    const t0 = performance.now();
    const res = await api(`/alice/app/blob/main/huge.ts`);
    await res.text();
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(10_000);
  }, 20_000);

  test("unterminated block comment: tokenizer terminates, output escaped", async () => {
    let content = "/* start of comment\n";
    for (let i = 0; i < 500; i++)
      content += `line ${i} of comment with "quotes" and <tags>\n`;
    await Bun.write(join(dir, "unterminated.ts"), content);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "unterminated comment"], dir);
    await shOk(["git", "push"], dir);
    const res = await api(`/alice/app/blob/main/unterminated.ts`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain("<tags>");
    expect(body).toContain("&lt;tags&gt;");
  });

  test("deeply nested template literals do not hang the tokenizer", async () => {
    let content = "const x = ";
    for (let i = 0; i < 300; i++) content += "`${";
    content += "1";
    for (let i = 0; i < 300; i++) content += "}`";
    content += ";\n";
    await Bun.write(join(dir, "nested.ts"), content);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "nested templates"], dir);
    await shOk(["git", "push"], dir);
    const t0 = performance.now();
    const res = await api(`/alice/app/blob/main/nested.ts`);
    await res.text();
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(5000);
  }, 15_000);

  test("invalid UTF-8 bytes in a blob (raw object, not a JS string) render without a 500", async () => {
    const invalid = new Uint8Array([
      0x66, 0x6f, 0x6f, 0xff, 0xfe, 0x00, 0x80, 0x0a,
    ]);
    const path = join(work, "invalid.bin");
    await Bun.write(path, invalid);
    const hashProc = Bun.spawn(
      ["git", "hash-object", "-w", "--path=weird.ts", path],
      { cwd: dir, env: clientEnv, stdout: "pipe" },
    );
    const oid = (await new Response(hashProc.stdout).text()).trim();
    await hashProc.exited;
    const headTree = await shOk(["git", "rev-parse", "HEAD^{tree}"], dir);
    const lsTree = await shOk(["git", "ls-tree", headTree], dir);
    const mktreeProc = Bun.spawn(["git", "mktree"], {
      cwd: dir,
      env: clientEnv,
      stdin: "pipe",
      stdout: "pipe",
    });
    mktreeProc.stdin.write(lsTree + `\n100644 blob ${oid}\tweird.ts\n`);
    await mktreeProc.stdin.end();
    const newTree = (await new Response(mktreeProc.stdout).text()).trim();
    await mktreeProc.exited;
    const commitProc = Bun.spawn(
      ["git", "commit-tree", newTree, "-p", "HEAD", "-m", "invalid utf8 blob"],
      { cwd: dir, env: clientEnv, stdout: "pipe" },
    );
    const newCommit = (await new Response(commitProc.stdout).text()).trim();
    await commitProc.exited;
    await shOk(["git", "update-ref", "refs/heads/main", newCommit], dir);
    await shOk(["git", "push"], dir);

    const res = await api(`/alice/app/blob/main/weird.ts`);
    expect(res.status).not.toBe(500);
  });

  test("50,000 blank lines render without hanging", async () => {
    await Bun.write(join(dir, "blank.ts"), "\n".repeat(50_000));
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "blank lines"], dir);
    await shOk(["git", "push"], dir);
    const t0 = performance.now();
    const res = await api(`/alice/app/blob/main/blank.ts`);
    await res.text();
    const ms = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(10_000);
  }, 20_000);

  test("CRLF vs LF sides of a diff stay in sync (no garbled markup)", async () => {
    const lfContent =
      'function f() {\n  return "hello world this is a test";\n}\n';
    await Bun.write(join(dir, "crlf.ts"), lfContent);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "add lf file"], dir);
    await shOk(["git", "push"], dir);

    const crlfContent = lfContent
      .replace(/\n/g, "\r\n")
      .replace(
        'return "hello world this is a test"',
        'return "hello world this is CHANGED"',
      );
    await Bun.write(join(dir, "crlf.ts"), crlfContent);
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "convert to crlf and change"], dir);
    await shOk(["git", "push"], dir);

    const commit = await shOk(["git", "rev-parse", "HEAD"], dir);
    const res = await api(`/alice/app/commit/${commit}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("CHANGED");
  });

  // --- Confirmed bug (see report): binary files whose path git must
  // C-quote (non-ASCII, quotes, backslash, control chars) lose their name
  // entirely because parseUnifiedDiff only reads oldPath/newPath off the
  // `--- `/`+++ ` marker lines, which don't exist for a binary diff — only
  // "Binary files a/X and b/Y differ" does, and that line is never parsed
  // for paths (src/git/diff.ts:190-194). This is a functional/display bug,
  // not directly an XSS vector (the fallback path is escaped), but it is
  // real and reproducible. This test documents the current (buggy) behavior
  // so a fix shows up as an intentional test change, not a silent regression
  // in the other direction.
  test("binary file with a non-ASCII path keeps its filename", async () => {
    await Bun.write(join(dir, "bïnary.bin"), new Uint8Array([0, 1, 2, 255]));
    await shOk(["git", "add", "."], dir);
    await shOk(["git", "commit", "-m", "add non-ascii binary"], dir);
    await shOk(["git", "push"], dir);
    const commit = await shOk(["git", "rev-parse", "HEAD"], dir);
    const body = await (await api(`/alice/app/commit/${commit}`)).text();
    expect(body).toContain("Binary file not shown");
    // Recovered from the "Binary files a/X and b/Y differ" line.
    expect(body).toContain("bïnary.bin");
    expect(body).not.toContain("(unknown)");
  });
});
