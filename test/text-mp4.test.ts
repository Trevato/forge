/** src/text/mp4.ts: duration from mvhd (v0 and v1), picture size from tkhd, and a truncated or moov-less file answered without a throw. */
import { expect, test } from "bun:test";
import { clock, describeMedia, readMp4 } from "../src/text/mp4.ts";
import { ROTATE_90, box, concat, ftyp, mvex, mvhd0, mvhd1, tkhd, u32, u64 } from "./helpers/mp4-boxes.ts";

test("v0: 92.5 s at timescale 1000, a 1920×1080 track beside an audio track", () => {
  const file = concat(
    ftyp(),
    box("moov", mvhd0(1000, 92_500), box("trak", tkhd(0, 0, 0)), box("trak", tkhd(0, 1920, 1080))),
  );
  expect(readMp4(file)).toEqual({ ok: true, value: { seconds: 92.5, width: 1920, height: 1080 } });
  expect(describeMedia("clip.MP4", file)).toEqual({
    kind: "video",
    seconds: 92.5,
    width: 1920,
    height: 1080,
    says: "video · 1:32 · 1920×1080",
  });
});

test("v1: 64-bit duration 3725 s at 90 kHz, and a 64-bit largesize moov after mdat", () => {
  const inner = concat(mvhd1(90_000, 3725n * 90_000n), box("trak", tkhd(1, 1280, 720)));
  const moov = concat(u32(1), new TextEncoder().encode("moov"), u64(BigInt(16 + inner.length)), inner);
  const file = concat(ftyp(), box("mdat", new Uint8Array(32)), moov);
  expect(readMp4(file)).toEqual({ ok: true, value: { seconds: 3725, width: 1280, height: 720 } });
  expect(describeMedia("a.mov", file)?.says).toBe("video · 1:02:05 · 1280×720");
});

test("an audio-only file says audio; an .m4a is audio even with a picture track", () => {
  const audio = concat(ftyp(), box("moov", mvhd0(44_100, 44_100 * 61)));
  expect(describeMedia("song.mp4", audio)).toEqual({ kind: "audio", seconds: 61, says: "audio · 1:01" });
  const cover = concat(ftyp(), box("moov", mvhd0(1, 5), box("trak", tkhd(0, 600, 600))));
  expect(describeMedia("song.m4a", cover)?.kind).toBe("audio");
});

test("truncated, moov-less or unknown-duration files are errors, never throws", () => {
  const whole = concat(ftyp(), box("moov", mvhd0(1000, 5000), box("trak", tkhd(0, 640, 480))));
  for (let n = 0; n < whole.length; n++) expect(readMp4(whole.subarray(0, n)).ok).toBe(false);
  expect(readMp4(whole).ok).toBe(true);
  expect(readMp4(concat(ftyp(), box("mdat", new Uint8Array(4)))).ok).toBe(false);
  expect(readMp4(concat(box("moov", mvhd0(1000, 0xffffffff))))).toEqual({ ok: false, error: "duration unknown" });
  expect(readMp4(concat(box("moov", mvhd0(0, 10))))).toEqual({ ok: false, error: "duration unknown" });
  // A box claiming more bytes than exist, and one claiming fewer than its header.
  expect(readMp4(concat(u32(1 << 30), new TextEncoder().encode("moov"))).ok).toBe(false);
  expect(readMp4(concat(u32(3), new TextEncoder().encode("moov"))).ok).toBe(false);
  expect(describeMedia("x.mp4", new Uint8Array(3))).toEqual({ kind: "video", says: "video · duration unknown" });
});

test("other extensions are not described; the clock rounds down", () => {
  expect(describeMedia("a.mp3", new Uint8Array(0))).toBeUndefined();
  expect(describeMedia("mp4.txt", new Uint8Array(0))).toBeUndefined();
  expect(clock(59.9)).toBe("0:59");
  expect(clock(3600)).toBe("1:00:00");
});

test("a fragmented file (mvhd duration 0) takes its length from mvex → mehd, v0 and v1", () => {
  const v0 = concat(ftyp(), box("moov", mvhd0(1000, 0), box("trak", tkhd(0, 640, 480)), mvex(0, 92_500)));
  expect(describeMedia("rec.mp4", v0)?.says).toBe("video · 1:32 · 640×480");
  const v1 = concat(ftyp(), box("moov", mvhd1(90_000, 0n), mvex(1, 90_000 * 61)));
  expect(readMp4(v1)).toEqual({ ok: true, value: { seconds: 61 } });
});

test("mvhd duration 0 with no mvex, or an mehd of 0, is duration unknown, not 0:00", () => {
  const bare = concat(ftyp(), box("moov", mvhd0(1000, 0), box("trak", tkhd(0, 640, 480))));
  expect(readMp4(bare)).toEqual({ ok: false, error: "duration unknown" });
  expect(describeMedia("rec.mp4", bare)?.says).toBe("video · duration unknown");
  expect(readMp4(concat(box("moov", mvhd0(1000, 0), mvex(0, 0)))).ok).toBe(false);
});

test("a portrait clip whose matrix turns 90° reports the displayed size, height over width", () => {
  const v0 = concat(ftyp(), box("moov", mvhd0(1, 10), box("trak", tkhd(0, 1920, 1080, ROTATE_90))));
  expect(describeMedia("phone.mov", v0)?.says).toBe("video · 0:10 · 1080×1920");
  const v1 = concat(ftyp(), box("moov", mvhd0(1, 10), box("trak", tkhd(1, 1920, 1080, ROTATE_90.map((n) => -n)))));
  expect(readMp4(v1)).toEqual({ ok: true, value: { seconds: 10, width: 1080, height: 1920 } });
});
