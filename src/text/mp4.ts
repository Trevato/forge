/**
 * What an MP4, MOV or M4A file is, read from its ISO-BMFF boxes (ISO/IEC 14496-12):
 * `moov` → `mvhd` for timescale and duration, `moov` → `trak` → `tkhd` for the
 * picture size. Bounds-checked against the bytes given; never throws.
 */
import { err, ok, type Result } from "../kernel/result.ts";

export type Mp4Facts = { seconds: number; width?: number; height?: number };
export type MediaAbout = {
  kind: "video" | "audio";
  seconds?: number;
  width?: number;
  height?: number;
  says: string;
};

/** The extensions `read_file` describes. */
const MEDIA_EXTENSIONS = [".mp4", ".m4v", ".mov", ".m4a"] as const;

type Box = { type: string; body: number; end: number };

/** The boxes laid end to end in bytes[from, to); a box running past `to` ends the walk. */
function boxes(view: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7),
    );
    let header = 8;
    if (size === 1) {
      // 64-bit largesize follows the type (§4.2).
      if (at + 16 > to) break;
      const big = view.getBigUint64(at + 8);
      if (big > BigInt(to - at)) break;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = to - at; // "box extends to the end of the file"
    }
    if (size < header || at + size > to) break;
    out.push({ type, body: at + header, end: at + size });
    at += size;
  }
  return out;
}

function child(view: DataView, box: Box, type: string): Box | undefined {
  return boxes(view, box.body, box.end).find((b) => b.type === type);
}

/** mvhd (§8.2.2): v0 has 32-bit times, v1 64-bit; timescale is units per second.
 * A fragmented file writes duration 0 here and the length in `mvex` → `mehd` (§8.8.2). */
function movieHeader(view: DataView, box: Box, moov: Box): Result<number, string> {
  const v = box.body + 4 <= box.end ? view.getUint8(box.body) : -1;
  const need = v === 1 ? 4 + 8 + 8 + 4 + 8 : 4 + 4 + 4 + 4 + 4;
  if ((v !== 0 && v !== 1) || box.body + need > box.end) return err("mvhd is truncated");
  const timescale = view.getUint32(box.body + (v === 1 ? 20 : 12));
  const duration =
    v === 1 ? view.getBigUint64(box.body + 24) : BigInt(view.getUint32(box.body + 16));
  // All ones means "duration unknown" (§8.2.2.3).
  const unknown = v === 1 ? 0xffffffffffffffffn : 0xffffffffn;
  if (timescale === 0 || duration === unknown) return err("duration unknown");
  if (duration > 0n) return ok(Number(duration) / timescale);
  const fragments = fragmentDuration(view, moov);
  return fragments ? ok(Number(fragments) / timescale) : err("duration unknown");
}

/** mehd (§8.8.2): fragment_duration right after version and flags, u32 in v0, u64 in v1, in the mvhd timescale. */
function fragmentDuration(view: DataView, moov: Box): bigint | undefined {
  const mvex = child(view, moov, "mvex");
  const mehd = mvex && child(view, mvex, "mehd");
  if (!mehd || mehd.body + 4 > mehd.end) return undefined;
  const v = view.getUint8(mehd.body);
  if (v === 1 && mehd.body + 12 <= mehd.end) return view.getBigUint64(mehd.body + 4) || undefined;
  if (v === 0 && mehd.body + 8 <= mehd.end) return BigInt(view.getUint32(mehd.body + 4)) || undefined;
  return undefined;
}

/** tkhd (§8.3.2): width and height are 16.16 fixed point after the matrix {a b u c d v x y w}.
 * The size answered is the displayed one: a 90° or 270° matrix (a = d = 0, |b| = |c| = 1.0,
 * as a portrait phone clip writes) swaps the stored width and height. */
function trackSize(view: DataView, box: Box): { width: number; height: number } | undefined {
  const v = box.body + 4 <= box.end ? view.getUint8(box.body) : -1;
  if (v !== 0 && v !== 1) return undefined;
  const matrix = box.body + (v === 1 ? 52 : 40);
  const at = matrix + 36;
  if (at + 8 > box.end) return undefined;
  const width = Math.round(view.getUint32(at) / 65536);
  const height = Math.round(view.getUint32(at + 4) / 65536);
  if (width === 0 || height === 0) return undefined;
  const [a, b, c, d] = [0, 4, 12, 16].map((o) => view.getInt32(matrix + o));
  const quarterTurn = a === 0 && d === 0 && Math.abs(b!) === 65536 && Math.abs(c!) === 65536;
  return quarterTurn ? { width: height, height: width } : { width, height };
}

/** Duration in seconds and, when a track has a picture, the largest picture size. */
export function readMp4(bytes: Uint8Array): Result<Mp4Facts, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxes(view, 0, bytes.byteLength).find((b) => b.type === "moov");
  if (!moov) return err("no moov box");
  const mvhd = child(view, moov, "mvhd");
  if (!mvhd) return err("no mvhd box");
  const seconds = movieHeader(view, mvhd, moov);
  if (!seconds.ok) return seconds;
  let size: { width: number; height: number } | undefined;
  for (const trak of boxes(view, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = child(view, trak, "tkhd");
    const s = tkhd && trackSize(view, tkhd);
    if (s && (!size || s.width * s.height > size.width * size.height)) size = s;
  }
  return ok(size ? { seconds: seconds.value, ...size } : { seconds: seconds.value });
}

/** 92.4 → "1:32", 3725 → "1:02:05"; whole seconds, rounded down. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The `about` for a media file at `path`, or undefined when the extension is not one we describe. */
export function describeMedia(path: string, bytes: Uint8Array): MediaAbout | undefined {
  const lower = path.toLowerCase();
  if (!MEDIA_EXTENSIONS.some((e) => lower.endsWith(e))) return undefined;
  const facts = readMp4(bytes);
  const audioOnly = lower.endsWith(".m4a");
  if (!facts.ok) {
    const kind = audioOnly ? "audio" : "video";
    return { kind, says: `${kind} · duration unknown` };
  }
  const { seconds, width, height } = facts.value;
  const seconds3 = Math.round(seconds * 1000) / 1000;
  if (width === undefined || height === undefined || audioOnly)
    return { kind: "audio", seconds: seconds3, says: `audio · ${clock(seconds)}` };
  return {
    kind: "video",
    seconds: seconds3,
    width,
    height,
    says: `video · ${clock(seconds)} · ${width}×${height}`,
  };
}
