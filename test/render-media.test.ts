/**
 * Audio and video play inline on the blob page (#7333): the right element,
 * pointed at the media route with the right type, for every container; a
 * file too long for the page to read still plays, and seeks by Range; a
 * name the bytes contradict keeps the source view; and the "can't play"
 * note is in the markup for the shell script to show.
 *
 * The pages are read signed in, and the crawl clock is held "behind" (#8269):
 * an anonymous reader's deep-page budget is 30 a minute, a quarter of that
 * while the event loop runs late, and under the gate's load this file's
 * twelve reads ran past it and were answered 429. What is drawn here does
 * not depend on who reads it; the budget has its own suite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setCrawlClock } from "../src/http/crawl.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { shellJs } from "../src/web/client.ts";
import { MEDIA_PLAY_JS } from "../src/web/render/player.ts";
import { rendererFor } from "../src/web/render/renderers.ts";
import { mediaNote } from "../src/tui/ui/media-note.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** A few bytes after a signature, so each file is what its name says. */
const file = (head: string | number[], size = 64): Uint8Array => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 13 + 1) & 0xff;
  out.set(typeof head === "string" ? enc(head) : new Uint8Array(head), 0);
  return out;
};

const FILES: ReadonlyArray<{ path: string; bytes: Uint8Array; element: string; types: string[]; container: string }> = [
  { path: "a.mp3", bytes: file("ID3\x03\0"), element: "audio", types: ["audio/mpeg"], container: "MP3" },
  { path: "a.wav", bytes: file("RIFF\0\0\0\0WAVEfmt "), element: "audio", types: ["audio/wav"], container: "WAV" },
  { path: "a.ogg", bytes: file("OggS\0"), element: "audio", types: ["audio/ogg"], container: "Ogg" },
  { path: "a.m4a", bytes: file("\0\0\0\x20ftypM4A "), element: "audio", types: ["audio/mp4"], container: "MPEG-4 audio" },
  { path: "v.mp4", bytes: file("\0\0\0\x20ftypisom"), element: "video", types: ["video/mp4"], container: "MPEG-4" },
  { path: "v.webm", bytes: file([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), element: "video", types: ["video/webm"], container: "WebM" },
  { path: "v.mov", bytes: file("\0\0\0\x14ftypqt  "), element: "video", types: ["video/quicktime", "video/mp4"], container: "QuickTime" },
];

/** Over the page's 1 MB read ceiling: drawn by name, bytes streamed. */
const LONG = file("\0\0\0\x20ftypisom", 1_500_000);

let dataDir = "";
let app: App;
let servers: Servers;
let base = "";
let cookie = "";

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { cookie, ...headers } });

const page = async (path: string): Promise<string> => {
  const res = await get(`/alice/tapes/blob/main/${path}`);
  expect(res.status).toBe(200);
  return res.text();
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-render-media-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  // The gate's load, on every run: the anonymous budget at its smallest.
  setCrawlClock(app, Date.now, true);
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-media-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  cookie = `forge_session=${createSession(app.db, a.value.id).token}`;
  const repo = await createRepo(app, a.value, { name: "tapes", visibility: "public" });
  if (!repo.ok) throw new Error("repo failed");
  const made = await commitToBranch(app, a.value, repo.value, {
    message: "tapes",
    files: [
      ...FILES.map((f) => ({ path: f.path, content: f.bytes })),
      { path: "long.mp4", content: LONG },
      { path: "fake.mp4", content: "not a video, just words\n" },
    ],
  });
  if (!made.ok) throw new Error("commit failed");
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("audio and video on the blob page", () => {
  for (const f of FILES) {
    test(`${f.path} is a <${f.element}> with its source and type`, async () => {
      const text = await page(f.path);
      const media = `/alice/tapes/media/main/${f.path}`;
      if (f.element === "video")
        expect(text).toContain('<video class="media-player" controls playsinline preload="metadata">');
      else expect(text).toContain('<audio class="media-player" controls preload="metadata">');
      const sources = [...text.matchAll(/<source src="([^"]*)" type="([^"]*)"/g)];
      expect(sources.map((m) => m[1])).toEqual(f.types.map(() => media));
      expect(sources.map((m) => m[2])).toEqual(f.types);
      // The header names the size and the container, not a line count.
      expect(text).toContain(`${f.bytes.length} B · ${f.container}`);
      // Every view keeps the switch, Raw and Download.
      expect(text).toContain(`href="/alice/tapes/blob/main/${f.path}?view=source"`);
      expect(text).toContain(`href="/alice/tapes/raw/main/${f.path}"`);
      expect(text).toContain(`href="${media}?download=1"`);
    });
  }

  test("the can't-play note and its Download are in the markup, hidden", async () => {
    const text = await page("v.webm");
    expect(text).toMatch(/<div class="media-unplayable" hidden>[\s\S]*Your browser can(&#39;|&#x27;|')t play this format/);
    expect(shellJs).toContain(MEDIA_PLAY_JS);
  });

  test("with no script running, the pane itself still offers Download", async () => {
    const text = await page("v.webm");
    const pane = text.slice(text.indexOf('<div class="media-pane"'));
    const noscript = pane.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";
    expect(noscript).toContain('href="/alice/tapes/media/main/v.webm?download=1"');
    expect(noscript).toContain("Download");
  });

  test("Source drops the player", async () => {
    const res = await get("/alice/tapes/blob/main/v.mp4?view=source");
    const text = await res.text();
    expect(text).not.toContain("<video");
    expect(text).toContain("Binary file");
  });

  test("a video past the page's read ceiling still plays, and seeks mid-file", async () => {
    const text = await page("long.mp4");
    expect(text).toContain('<source src="/alice/tapes/media/main/long.mp4" type="video/mp4"');
    expect(text).toContain("1.4 MB · MPEG-4");
    const res = await get("/alice/tapes/media/main/long.mp4", { range: "bytes=750000-750099" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 750000-750099/${LONG.length}`);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LONG.slice(750000, 750100));
  });

  test("a name the bytes contradict keeps the source view", async () => {
    const text = await page("fake.mp4");
    expect(text).not.toContain("<video");
    expect(text).toContain("not a video, just words");
  });
});

describe("rendererFor", () => {
  test("an unread file is drawn only when its kind streams", () => {
    expect(rendererFor("x.webm", { kind: "too_large", size: 9_000_000 })?.body.length).toBe(0);
    expect(rendererFor("x.ogg", { kind: "too_large", size: 9_000_000 })).toBeDefined();
    expect(rendererFor("x.md", { kind: "too_large", size: 2_000_000 })).toBeUndefined();
    expect(rendererFor("x.bin", { kind: "too_large", size: 2_000_000 })).toBeUndefined();
  });

  test("over its kind's cap, nothing draws it", () => {
    expect(rendererFor("x.mp3", { kind: "too_large", size: 600_000_000 })).toBeUndefined();
    expect(rendererFor("x.mp4", { kind: "too_large", size: 3_000_000_000 })).toBeDefined();
  });
});

/** Just enough DOM for the shell's media part: elements, a pane, a note. */
function fakeDom() {
  type El = {
    tagName: string;
    hidden: boolean;
    error: unknown;
    networkState: number;
    nextElementSibling: El | null;
    parentElement: El | null;
    classList: { contains: (c: string) => boolean };
    closest: (sel: string) => El | null;
    querySelector: (sel: string) => El | null;
  };
  const el = (tagName: string, cls: string): El => ({
    tagName,
    hidden: false,
    error: null,
    networkState: 1,
    nextElementSibling: null,
    parentElement: null,
    classList: { contains: (c) => c === cls },
    closest: () => null,
    querySelector: () => null,
  });
  const pane = el("DIV", "media-pane");
  const note = el("DIV", "media-unplayable");
  note.hidden = true;
  const video = el("VIDEO", "media-player");
  const first = el("SOURCE", "");
  const last = el("SOURCE", "");
  first.nextElementSibling = last;
  first.parentElement = last.parentElement = video;
  pane.querySelector = (sel) => (sel === ".media-unplayable" ? note : null);
  video.closest = (sel) => (sel === ".media-pane" ? pane : null);
  let onError: ((e: { target: El }) => void) | undefined;
  const doc = {
    addEventListener: (type: string, fn: (e: { target: El }) => void, capture: boolean) => {
      if (type === "error" && capture) onError = fn;
    },
    querySelectorAll: (sel: string) => (sel === ".media-player" ? [video] : []),
  };
  const run = (): void => new Function("doc", MEDIA_PLAY_JS)(doc);
  const fire = (target: El): void => onError?.({ target });
  return { video, note, first, last, run, fire };
}

describe("the shell's can't-play swap", () => {
  test("a source with another after it is left for the browser to try next", () => {
    const d = fakeDom();
    d.run();
    d.fire(d.first);
    expect(d.video.hidden).toBe(false);
    expect(d.note.hidden).toBe(true);
  });

  test("the last source failing hides the player and shows the note", () => {
    const d = fakeDom();
    d.run();
    d.fire(d.last);
    expect(d.video.hidden).toBe(true);
    expect(d.note.hidden).toBe(false);
  });

  test("a decode error on the element itself does the same", () => {
    const d = fakeDom();
    d.run();
    d.fire(d.video);
    expect(d.video.hidden).toBe(true);
    expect(d.note.hidden).toBe(false);
  });

  test("a player that failed before the script ran is found on load", () => {
    const d = fakeDom();
    d.video.networkState = 3;
    d.run();
    expect(d.note.hidden).toBe(false);
  });
});

describe("the terminal's note for a media file", () => {
  test("names the format and prints the media route", () => {
    expect(mediaNote("clips/a b.webm", "3.2 M", "https://forge.dev/alice/tapes", "main")).toBe(
      "Video, WebM, 3.2 M — not played in the terminal. Play it in a browser: https://forge.dev/alice/tapes/media/main/clips/a%20b.webm",
    );
    expect(mediaNote("a.mp3", "4 K", undefined, "main")).toBe("Audio, MP3, 4 K — not played in the terminal.");
    expect(mediaNote("a.png", "4 K", "https://forge.dev/a/b", "main")).toBeUndefined();
  });
});
