/**
 * A media file over the page's 1 MB read ceiling still reaches its renderer,
 * up to its kind's `RENDER_CAP` (#7384): its kind is read from its first
 * bytes, never from the whole file. A text kind keeps the 1 MB ceiling.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { blobHead } from "../src/git/read.ts";
import type { Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { localSource } from "../src/view/local.ts";
import type { Blob } from "../src/view/source.ts";
import { blobBody, capped } from "../src/web/pages/repo.ts";
import { HEAD_BYTES } from "../src/web/render/kinds.ts";
import { rendererFor, type RenderInput, type Renderer } from "../src/web/render/renderers.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const MB = 1_000_000;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** `size` bytes opening on `head`, the rest filler of the same nature. */
const filled = (head: string, size: number, fill: number): Uint8Array => {
  const out = new Uint8Array(size).fill(fill);
  out.set(enc(head), 0);
  return out;
};

const PDF = filled("%PDF-1.7\n", 3 * MB, 0);
const MARKDOWN = filled("# Notes\n\n", 3 * MB, 0x61);
/** Just over the source's own 5 MB fetch ceiling, so only the head is ever read. */
const BIG_PDF = filled("%PDF-1.7\n", 6 * MB, 0);
const BIG_VIDEO = filled("\0\0\0\x20ftypisom", 6 * MB, 0);
/** A `.mp4` whose bytes are words: its bytes, not its name, decide. */
const WORDS_MP4 = filled("not a video, just words\n", 3 * MB, 0x61);

const blob = (body: Uint8Array): Blob => ({ kind: "binary", body, size: body.length });

/** A renderer that records what it was handed. */
function stub(): { render: Renderer; seen: RenderInput[] } {
  const seen: RenderInput[] = [];
  return { seen, render: (input) => (seen.push(input), { content: "" as never, lines: 0 }) };
}

describe("the page ceiling, by kind", () => {
  test("a 3 MB PDF reaches its renderer with an empty body", () => {
    const pdf = stub();
    const found = rendererFor("doc/big.pdf", capped(blob(PDF)), { pdf: pdf.render });
    expect(found).toBeDefined();
    found!.render({ path: "doc/big.pdf", size: PDF.length, body: found!.body, media: "/m", download: "/m?download=1" });
    expect(pdf.seen).toHaveLength(1);
    expect(pdf.seen[0]!.body.length).toBe(0);
    expect(pdf.seen[0]!.media).toBe("/m");
  });

  test("capped keeps only the head of a body it drops", () => {
    const cut = capped(blob(PDF));
    expect(cut.kind).toBe("too_large");
    if (cut.kind !== "too_large") return;
    expect(cut.size).toBe(PDF.length);
    expect(cut.head?.length).toBe(HEAD_BYTES);
  });

  test("a 3 MB Markdown file still shows the over-cap note", () => {
    const md = stub();
    const cut = capped({ kind: "text", body: MARKDOWN, size: MARKDOWN.length });
    expect(rendererFor("notes.md", cut, { markdown: md.render })).toBeUndefined();
    expect(md.seen).toHaveLength(0);
    expect(String(blobBody("/a/r", "main", "notes.md", cut).content)).toContain(
      "over the render cap",
    );
  });

  test("a media name its head contradicts is not drawn", () => {
    const video = stub();
    expect(rendererFor("words.mp4", capped(blob(WORDS_MP4)), { video: video.render })).toBeUndefined();
  });

  test("over its kind's cap, a media file is not drawn", () => {
    const head = PDF.subarray(0, HEAD_BYTES);
    const pdf = stub();
    expect(rendererFor("x.pdf", { kind: "too_large", size: 100 * MB + 1, head }, { pdf: pdf.render })).toBeUndefined();
    expect(rendererFor("x.pdf", { kind: "too_large", size: 100 * MB, head }, { pdf: pdf.render })).toBeDefined();
  });
});

describe("a large blob on the page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";
  let dir = "";
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-blob-ceiling-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-ceiling-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const created = await createRepo(app, a.value, { name: "big", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    repo = created.value;
    dir = repoDir(app.reposRoot, "alice", "big");
    // Over the commit route's file ceiling, so the files go in by plumbing.
    const made = await commitToBranch(app, a.value, repo, {
      message: "start",
      files: [{ path: "README.md", content: "# big\n" }],
    });
    if (!made.ok) throw new Error("commit failed");
    const git = (args: string[], stdin?: Uint8Array | string): string => {
      const input = typeof stdin === "string" ? enc(stdin) : (stdin ?? "ignore");
      const run = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdin: input,
        // The check's machine has no git identity; the commit names its own.
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "alice",
          GIT_AUTHOR_EMAIL: "a@f.dev",
          GIT_COMMITTER_NAME: "alice",
          GIT_COMMITTER_EMAIL: "a@f.dev",
        },
      });
      if (run.exitCode !== 0) throw new Error(`git ${args[0]}: ${run.stderr.toString()}`);
      return run.stdout.toString().trim();
    };
    const files: Record<string, Uint8Array> = {
      "big.pdf": BIG_PDF,
      "big.mp4": BIG_VIDEO,
      "words.mp4": WORDS_MP4,
      "notes.md": MARKDOWN,
    };
    const lines = [git(["ls-tree", "main"])];
    for (const [name, body] of Object.entries(files))
      lines.push(`100644 blob ${git(["hash-object", "-w", "--stdin"], body)}\t${name}`);
    const tree = git(["mktree"], lines.join("\n") + "\n");
    const commit = git(["commit-tree", tree, "-p", "main", "-m", "big files"]);
    git(["update-ref", "refs/heads/main", commit]);
  }, 60_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("blobHead reads the first bytes and no more", async () => {
    const head = await blobHead(dir, "main", "big.pdf", HEAD_BYTES);
    expect(head?.length).toBe(HEAD_BYTES);
    expect(new TextDecoder().decode(head!.subarray(0, 5))).toBe("%PDF-");
    expect(await blobHead(dir, "main", "missing.pdf", HEAD_BYTES)).toBeUndefined();
  });

  test("a video past the source's ceiling is drawn from its head", async () => {
    const res = await fetch(`${base}/alice/big/blob/main/big.mp4`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("<video");
    expect(text).toContain('src="/alice/big/media/main/big.mp4"');
    expect(text).not.toContain("over the render cap");
    expect(text.length).toBeLessThan(200_000);
  });

  test("a PDF past the source's ceiling comes with its head, and reaches its renderer", async () => {
    const source = localSource(app, repo);
    const read = await source.blob("main", "big.pdf");
    expect(read.ok).toBe(true);
    if (!read.ok || read.value.kind !== "too_large") throw new Error("expected too_large");
    expect(read.value.size).toBe(BIG_PDF.length);
    expect(read.value.head?.length).toBe(HEAD_BYTES);
    const pdf = stub();
    const found = rendererFor("big.pdf", capped(read.value), { pdf: pdf.render });
    expect(found?.body.length).toBe(0);
  });

  test("a 3 MB .mp4 of words, and a 3 MB Markdown file, keep the over-cap note", async () => {
    for (const path of ["words.mp4", "notes.md"]) {
      const text = await (await fetch(`${base}/alice/big/blob/main/${path}`)).text();
      expect(text).toContain("over the render cap");
      expect(text).not.toContain("<video");
    }
  });
});
