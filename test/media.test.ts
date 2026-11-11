/**
 * The media route, `/:owner/:name/media/:ref/*path`, against a real forge:
 * an allowlisted type confirmed by the bytes, the sandbox policy that keeps
 * an SVG's script from running, byte ranges on a buffered and a streamed
 * file, the ETag and its 304, and `/raw`'s access — a private repository is
 * a 404 to a stranger. And the blob page's switch points at it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { mediaGate } from "../src/git/env.ts";
import { blobStream, MEDIA_QUEUE_MAX, refTip, readerFor } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cachedMedia } from "../src/web/pages/tree_cache.ts";
import { MEDIA_POLICY, PDF_POLICY } from "../src/web/pages/media.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n");
const EVIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script><rect width="1" height="1"/></svg>\n';
/** Over the pooled read, so it is sniffed and streamed off git. */
const CLIP = (() => {
  const bytes = new Uint8Array(1_500_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  bytes.set(new TextEncoder().encode("\0\0\0\x20ftypisom"), 0);
  return bytes;
})();

let dataDir = "";
let app: App;
let servers: Servers;
let base = "";
let alice = "";
let sha = "";

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { redirect: "manual", headers });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-media-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-media-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = `forge_session=${createSession(app.db, a.value.id).token}`;

  const shown = await createRepo(app, a.value, { name: "gallery", visibility: "public" });
  if (!shown.ok) throw new Error("repo failed");
  const made = await commitToBranch(app, a.value, shown.value, {
    message: "pictures",
    files: [
      { path: "art/logo.png", content: PNG },
      { path: "art/fake.png", content: "not a png at all\n" },
      { path: "art/evil.svg", content: EVIL_SVG },
      { path: "doc.pdf", content: PDF },
      { path: "fake.pdf", content: "<script>alert(1)</script>" },
      { path: "art/page.txt", content: "<script>alert(1)</script>" },
      { path: "clip.mp4", content: CLIP },
      { path: "README.md", content: "# gallery\n" },
      { path: "src/a.ts", content: "export const a = 1\n" },
      { path: "empty.png", content: "" },
    ],
  });
  if (!made.ok) throw new Error("commit failed");
  sha = (await refTip(repoDir(app.reposRoot, "alice", "gallery"), "refs/heads/main")) ?? "";

  const hidden = await createRepo(app, a.value, { name: "vault", visibility: "private" });
  if (!hidden.ok) throw new Error("private repo failed");
  await commitToBranch(app, a.value, hidden.value, {
    message: "hidden",
    files: [{ path: "secret.png", content: PNG }],
  });
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the media route", () => {
  test("a small file at a full commit id is kept, a branch's and a large one are not", async () => {
    const repoId = app.db.query<{ id: string }, []>("select id from repo where name = 'gallery'").get()!.id;
    expect(cachedMedia(repoId, sha, "art/logo.png")).toBeUndefined();
    const first = await get(`/alice/gallery/media/${sha}/art/logo.png`);
    const bytes = new Uint8Array(await first.arrayBuffer());
    const held = cachedMedia(repoId, sha, "art/logo.png");
    expect(held?.body).toEqual(PNG);
    const again = await get(`/alice/gallery/media/${sha}/art/logo.png`);
    expect(again.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    await get("/alice/gallery/media/main/art/logo.png");
    expect(cachedMedia(repoId, "main", "art/logo.png")).toBeUndefined();
    await (await get(`/alice/gallery/media/${sha}/clip.mp4`)).arrayBuffer();
    expect(cachedMedia(repoId, sha, "clip.mp4")).toBeUndefined();
  });

  test("a confirmed PNG is served as image/png with its bytes", async () => {
    const res = await get("/alice/gallery/media/main/art/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("a name the bytes contradict, or a type off the allowlist, is octet-stream", async () => {
    const fake = await get("/alice/gallery/media/main/art/fake.png");
    expect(fake.status).toBe(200);
    expect(fake.headers.get("content-type")).toBe("application/octet-stream");
    const page = await get("/alice/gallery/media/main/art/page.txt");
    expect(page.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("an SVG with a script is an image under the sandbox policy", async () => {
    const res = await get("/alice/gallery/media/main/art/evil.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe(MEDIA_POLICY);
    expect(MEDIA_POLICY).toStartWith("sandbox;");
    expect(MEDIA_POLICY).toContain("default-src 'none'");
    expect(MEDIA_POLICY).not.toContain("script-src");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a PDF drops sandbox for the viewer; an SVG keeps it; both embed same-origin only", async () => {
    const pdf = await get("/alice/gallery/media/main/doc.pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
    );
    expect(PDF_POLICY).not.toContain("sandbox");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdf.headers.get("content-disposition")).toBeNull();
    expect(pdf.headers.get("x-frame-options")).toBe("SAMEORIGIN");

    const svg = await get("/alice/gallery/media/main/art/evil.svg");
    expect(svg.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    );
    expect(svg.headers.get("x-frame-options")).toBe("SAMEORIGIN");

    // Only bytes that are a PDF get the PDF policy; a download never does.
    const fake = await get("/alice/gallery/media/main/fake.pdf");
    expect(fake.headers.get("content-type")).toBe("application/octet-stream");
    expect(fake.headers.get("content-security-policy")).toBe(MEDIA_POLICY);
    const dl = await get("/alice/gallery/media/main/doc.pdf?download=1");
    expect(dl.headers.get("content-security-policy")).toBe(MEDIA_POLICY);
  });

  test("a single range is 206 with its window", async () => {
    const res = await get("/alice/gallery/media/main/art/logo.png", { range: "bytes=1-3" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 1-3/${PNG.length}`);
    expect(res.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG.subarray(1, 4));
  });

  test("a suffix range is the last bytes", async () => {
    const res = await get("/alice/gallery/media/main/art/logo.png", { range: "bytes=-4" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${PNG.length - 4}-${PNG.length - 1}/${PNG.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG.subarray(PNG.length - 4));
  });

  test("a range past the end is 416", async () => {
    const res = await get("/alice/gallery/media/main/art/logo.png", { range: `bytes=${PNG.length}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${PNG.length}`);
    const empty = await get("/alice/gallery/media/main/empty.png", { range: "bytes=0-" });
    expect(empty.status).toBe(416);
  });

  test("a large file streams off git, whole and in windows", async () => {
    const whole = await get("/alice/gallery/media/main/clip.mp4");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(CLIP);

    // A window across git's pipe chunks, the kind a seeking video asks for.
    const mid = await get("/alice/gallery/media/main/clip.mp4", { range: "bytes=700000-900122" });
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes 700000-900122/${CLIP.length}`);
    expect(new Uint8Array(await mid.arrayBuffer())).toEqual(CLIP.subarray(700000, 900123));

    const tail = await get("/alice/gallery/media/main/clip.mp4", { range: "bytes=-10" });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(CLIP.subarray(CLIP.length - 10));
  });

  test("a reader that hangs up mid-stream hands its permit back", async () => {
    const res = await get("/alice/gallery/media/main/clip.mp4");
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    for (let i = 0; i < 200 && mediaGate.stats().active > 0; i++) await Bun.sleep(10);
    expect(mediaGate.stats().active).toBe(0);
  });

  test("If-Range that still holds gets the range; a stale one gets the whole file", async () => {
    const etag = (await get("/alice/gallery/media/main/art/logo.png")).headers.get("etag") ?? "";
    const held = await get("/alice/gallery/media/main/art/logo.png", { range: "bytes=1-3", "if-range": etag });
    expect(held.status).toBe(206);
    expect(new Uint8Array(await held.arrayBuffer())).toEqual(PNG.subarray(1, 4));
    const stale = await get("/alice/gallery/media/main/art/logo.png", {
      range: "bytes=1-3",
      "if-range": `"${"0".repeat(40)}"`,
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-range")).toBeNull();
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(PNG);
  });

  test("the ETag is the blob id, and holding it is a 304", async () => {
    const res = await get("/alice/gallery/media/main/art/logo.png");
    const etag = res.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const again = await get("/alice/gallery/media/main/art/logo.png", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  test("a 304 is answered from the stat alone: no sniff, no permit", async () => {
    const etag = (await get("/alice/gallery/media/main/clip.mp4", { range: "bytes=0-0" })).headers.get("etag") ?? "";
    const held = await holdAll();
    try {
      // Every permit is taken, so a 304 that sniffed would wait here.
      const again = await get("/alice/gallery/media/main/clip.mp4", { "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(again.headers.get("content-type")).toBeNull();
      expect(again.headers.get("etag")).toBe(etag);
    } finally {
      held.forEach((release) => release());
    }
  });

  test("a full commit id is cached for a year; a branch revalidates", async () => {
    const pinned = await get(`/alice/gallery/media/${sha}/art/logo.png`);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=86400, immutable");
    const moving = await get("/alice/gallery/media/main/art/logo.png");
    expect(moving.headers.get("cache-control")).toBe("private, max-age=0");
  });

  test("?download=1 is an attachment under its own name, never rendered", async () => {
    const res = await get("/alice/gallery/media/main/art/evil.svg?download=1");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith('attachment; filename="evil.svg"');
  });

  test("a private repository is a 404 signed out, and its owner's to see", async () => {
    const out = await get("/alice/vault/media/main/secret.png");
    expect(out.status).toBe(404);
    expect(out.headers.get("content-type") ?? "").not.toStartWith("image/");
    const owner = await get("/alice/vault/media/main/secret.png", { cookie: alice });
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-type")).toBe("image/png");
  });

  test("a missing file, a tree, and an unsafe ref are the same 404", async () => {
    expect((await get("/alice/gallery/media/main/nope.png")).status).toBe(404);
    expect((await get("/alice/gallery/media/main/art")).status).toBe(404);
    expect((await get("/alice/gallery/media/--output=x/art/logo.png")).status).toBe(404);
  });
});

/** Take every media permit, as sixteen stalled streams would. */
async function holdAll(): Promise<(() => void)[]> {
  const held: (() => void)[] = [];
  while (mediaGate.stats().active < mediaGate.limit) held.push(await mediaGate.acquire());
  return held;
}

const settled = async (): Promise<number> => {
  for (let i = 0; i < 300 && mediaGate.stats().active > 0; i++) await Bun.sleep(10);
  return mediaGate.stats().active;
};

describe("the media permits", () => {
  const clip = async (): Promise<{ dir: string; oid: string }> => {
    const dir = repoDir(app.reposRoot, "alice", "gallery");
    const stat = await readerFor(dir).stat("main:clip.mp4");
    if (!stat.ok) throw new Error("no clip");
    return { dir, oid: stat.value.oid };
  };

  test("a reader that stalls gets its permit taken back", async () => {
    const { dir, oid } = await clip();
    const stream = await blobStream(dir, oid, 0, CLIP.length - 1, { idleMs: 50 });
    if (typeof stream === "string") throw new Error(stream);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Then it never pulls again.
    expect(await settled()).toBe(0);
    // What was queued before the stall still reads; then the stream ends.
    // A loaded machine can hand the whole blob over in the first two pipe
    // reads, and then the range ends before any stall — so either the idle
    // timer cut it short, or every byte had already arrived.
    let received = first.value?.length ?? 0;
    let cut: unknown = null;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read())
        received += next.value.length;
    } catch (error) {
      cut = error;
    }
    if (received < CLIP.length) expect(String(cut)).toContain("idle");
    else expect(cut).toBeNull();
  });

  test("a stream nobody ever reads ends too", async () => {
    const { dir, oid } = await clip();
    const stream = await blobStream(dir, oid, 0, 9, { idleMs: 50 });
    expect(typeof stream).not.toBe("string");
    expect(await settled()).toBe(0);
  });

  test("a reader that leaves while it waits for a permit spends none", async () => {
    const { dir, oid } = await clip();
    const held = await holdAll();
    const gone = new AbortController();
    const waiting = blobStream(dir, oid, 0, 9, { signal: gone.signal });
    expect(mediaGate.stats().waiting).toBe(1);
    gone.abort();
    held.forEach((release) => release());
    expect(await waiting).toBe("gone");
    expect(await settled()).toBe(0);
  });

  test("a full queue is a 503 with Retry-After, not one more waiter", async () => {
    const { dir, oid } = await clip();
    const held = await holdAll();
    const queued = Array.from({ length: MEDIA_QUEUE_MAX }, () => blobStream(dir, oid, 0, 9));
    try {
      expect(mediaGate.stats().waiting).toBe(MEDIA_QUEUE_MAX);
      const res = await get("/alice/gallery/media/main/clip.mp4");
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(mediaGate.stats().waiting).toBe(MEDIA_QUEUE_MAX);
      // A small file never queues: it is read through the pool.
      expect((await get("/alice/gallery/media/main/art/logo.png")).status).toBe(200);
    } finally {
      held.forEach((release) => release());
      for (const stream of await Promise.all(queued))
        if (typeof stream !== "string") await stream.cancel();
    }
    expect(await settled()).toBe(0);
  });
});

describe("the blob page of a PDF", () => {
  const policy = async (path: string): Promise<{ csp: string; html: string }> => {
    const res = await get(path);
    const bare = (res.headers.get("content-security-policy") ?? "").replace(/'nonce-[^']+'/g, "'nonce'");
    return { csp: bare, html: await res.text() };
  };

  test("draws the media URL in an object and alone sends object-src 'self'", async () => {
    const pdf = await policy("/alice/gallery/blob/main/doc.pdf");
    expect(pdf.html).toContain('<object class="pdf-frame" data="/alice/gallery/media/main/doc.pdf" type="application/pdf">');
    expect(pdf.html).toContain('href="/alice/gallery/media/main/doc.pdf?download=1"');
    expect(pdf.csp).toContain("object-src 'self'; ");

    // Every other policy is exactly what it was, with object-src left out.
    const readme = await policy("/alice/gallery/blob/main/README.md");
    expect(readme.csp).not.toContain("object-src");
    expect(pdf.csp.replace("object-src 'self'; ", "")).toBe(readme.csp);
    const source = await policy("/alice/gallery/blob/main/doc.pdf?view=source");
    expect(source.csp).not.toContain("object-src");
    expect(source.html).not.toContain("<object");
    for (const path of ["/alice/gallery", "/alice/gallery/blob/main/fake.pdf", "/alice/gallery/blob/main/art/logo.png"])
      expect((await policy(path)).csp).not.toContain("object-src");
  });
});

describe("the blob page's switch", () => {
  const flat = (s: string): string => s.replace(/\s+/g, " ");

  test("Markdown chooses Rendered or Source, beside Raw and Download", async () => {
    const html = flat(await (await get("/alice/gallery/blob/main/README.md")).text());
    expect(html).toContain('aria-current="page" >Rendered');
    expect(html).toContain('href="/alice/gallery/blob/main/README.md?view=source"');
    expect(html).toContain('href="/alice/gallery/raw/main/README.md"');
    expect(html).toContain('href="/alice/gallery/media/main/README.md?download=1"');
    // Raw and Download are actions, not views: never inside the switch.
    const views = /<div class="seg">(.*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(views).toContain("Rendered");
    expect(views).not.toContain("Raw");
    expect(views).not.toContain("Download");
  });

  test("a kind with no renderer keeps its view, no switch, with Raw and Download", async () => {
    const code = flat(await (await get("/alice/gallery/blob/main/src/a.ts")).text());
    expect(code).toContain('class="card code"');
    expect(code).not.toContain('class="blob-view"');
    expect(code).not.toContain(">Rendered");
    expect(code).toContain('href="/alice/gallery/raw/main/src/a.ts"');
    expect(code).toContain('href="/alice/gallery/media/main/src/a.ts?download=1"');

    const png = flat(await (await get("/alice/gallery/blob/main/art/logo.png")).text());
    expect(png).toContain('src="/alice/gallery/media/main/art/logo.png"');
    expect(png).toContain('href="/alice/gallery/media/main/art/logo.png?download=1"');
  });
});
