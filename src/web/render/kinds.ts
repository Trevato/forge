/**
 * One registry of file kinds: what a file in a repository is, the one media
 * type the forge will ever serve it as, and the module that draws it.
 *
 * It is plain data with no web dependency, so the terminal asks it too. The
 * media route (`pages/media.ts`) asks for a type, and
 * gets one only from the allowlist below, decided by extension and confirmed
 * by the file's own first bytes where its format has a signature; anything
 * else, or a file whose bytes say it is not what its name says, goes out as
 * `application/octet-stream`. Never HTML, never script. `renderBlob` asks
 * `renderers.ts` what draws a kind, and a kind with nothing there keeps the
 * source view it always had.
 */

export type FileKind =
  | "image"
  | "svg"
  | "pdf"
  | "audio"
  | "video"
  | "csv"
  | "sqlite"
  | "model3d"
  | "archive"
  | "font"
  | "config"
  | "markdown"
  | "patch"
  | "log"
  | "subtitles"
  | "calendar"
  | "text"
  | "binary";

const MB = 1_000_000;

/**
 * The largest file each kind draws inline. Over it the page offers Download,
 * which streams at any size. A text kind is bounded by the page's own
 * render ceiling too, since its body is read to draw it.
 */
export const RENDER_CAP: Readonly<Record<FileKind, number>> = {
  image: 50 * MB,
  svg: 5 * MB,
  pdf: 100 * MB,
  audio: 500 * MB,
  video: 4_000 * MB,
  csv: 10 * MB,
  // Under the source's own 5 MB read ceiling: a larger file is never read.
  sqlite: 5 * MB,
  model3d: 100 * MB,
  archive: 50 * MB,
  font: 20 * MB,
  config: 1 * MB,
  markdown: 1 * MB,
  patch: 1 * MB,
  log: 1 * MB,
  subtitles: 5 * MB,
  calendar: 5 * MB,
  text: 1 * MB,
  binary: 0,
};

type Magic = (head: Uint8Array) => boolean;

const at = (head: Uint8Array, offset: number, text: string): boolean => {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++)
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};
const bytes =
  (...sig: number[]): Magic =>
  (head) =>
    head.length >= sig.length && sig.every((b, i) => head[i] === b);
const ascii =
  (text: string, offset = 0): Magic =>
  (head) =>
    at(head, offset, text);
const any =
  (...checks: Magic[]): Magic =>
  (head) =>
    checks.some((c) => c(head));

/** ISO base media (mp4, m4a, mov, avif): a box size, then `ftyp`. */
const ftyp = ascii("ftyp", 4);
/** An older QuickTime file may open on another top-level atom. */
const quicktime = any(ftyp, ...["moov", "mdat", "wide", "free", "skip", "pnot"].map((a) => ascii(a, 4)));
const riff = (form: string): Magic => (head) => at(head, 0, "RIFF") && at(head, 8, form);
/** MPEG audio: an ID3 tag, or a frame sync (eleven set bits). */
const mpegAudio: Magic = (head) =>
  at(head, 0, "ID3") || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
/** Raw AAC in ADTS frames: a twelve-bit sync, layer zero. */
const adts: Magic = (head) => head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0;
/** SVG is text, and has no signature but its root element. */
const svgRoot: Magic = (head) =>
  !head.includes(0) && /<svg[\s>]/i.test(new TextDecoder().decode(head));

interface Media {
  readonly kind: FileKind;
  /** The format as a person says it, for a header: `WebM`, `QuickTime`. */
  readonly name: string;
  readonly type: string;
  /** Absent for a format with no signature (STL); the extension decides. */
  readonly magic?: Magic;
}

/** The allowlist. A media type that is not here is never served. */
const MEDIA: Readonly<Record<string, Media>> = {
  png: { kind: "image", name: "PNG", type: "image/png", magic: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  jpg: { kind: "image", name: "JPEG", type: "image/jpeg", magic: bytes(0xff, 0xd8, 0xff) },
  jpeg: { kind: "image", name: "JPEG", type: "image/jpeg", magic: bytes(0xff, 0xd8, 0xff) },
  gif: { kind: "image", name: "GIF", type: "image/gif", magic: any(ascii("GIF87a"), ascii("GIF89a")) },
  webp: { kind: "image", name: "WebP", type: "image/webp", magic: riff("WEBP") },
  avif: { kind: "image", name: "AVIF", type: "image/avif", magic: (h) => ftyp(h) && (at(h, 8, "avif") || at(h, 8, "avis")) },
  bmp: { kind: "image", name: "BMP", type: "image/bmp", magic: ascii("BM") },
  ico: { kind: "image", name: "ICO", type: "image/x-icon", magic: bytes(0x00, 0x00, 0x01, 0x00) },
  svg: { kind: "svg", name: "SVG", type: "image/svg+xml", magic: svgRoot },
  pdf: { kind: "pdf", name: "PDF", type: "application/pdf", magic: ascii("%PDF-") },
  mp3: { kind: "audio", name: "MP3", type: "audio/mpeg", magic: mpegAudio },
  ogg: { kind: "audio", name: "Ogg", type: "audio/ogg", magic: ascii("OggS") },
  oga: { kind: "audio", name: "Ogg", type: "audio/ogg", magic: ascii("OggS") },
  wav: { kind: "audio", name: "WAV", type: "audio/wav", magic: riff("WAVE") },
  flac: { kind: "audio", name: "FLAC", type: "audio/flac", magic: ascii("fLaC") },
  m4a: { kind: "audio", name: "MPEG-4 audio", type: "audio/mp4", magic: ftyp },
  aac: { kind: "audio", name: "AAC", type: "audio/aac", magic: any(adts, ftyp) },
  mp4: { kind: "video", name: "MPEG-4", type: "video/mp4", magic: ftyp },
  m4v: { kind: "video", name: "MPEG-4", type: "video/mp4", magic: ftyp },
  webm: { kind: "video", name: "WebM", type: "video/webm", magic: bytes(0x1a, 0x45, 0xdf, 0xa3) },
  mov: { kind: "video", name: "QuickTime", type: "video/quicktime", magic: quicktime },
  db: { kind: "sqlite", name: "SQLite", type: "application/vnd.sqlite3", magic: ascii("SQLite format 3\0") },
  sqlite: { kind: "sqlite", name: "SQLite", type: "application/vnd.sqlite3", magic: ascii("SQLite format 3\0") },
  sqlite3: { kind: "sqlite", name: "SQLite", type: "application/vnd.sqlite3", magic: ascii("SQLite format 3\0") },
  stl: { kind: "model3d", name: "STL", type: "model/stl" },
  ttf: { kind: "font", name: "TrueType", type: "font/ttf", magic: bytes(0x00, 0x01, 0x00, 0x00) },
  otf: { kind: "font", name: "OpenType", type: "font/otf", magic: ascii("OTTO") },
  woff: { kind: "font", name: "WOFF", type: "font/woff", magic: ascii("wOFF") },
  woff2: { kind: "font", name: "WOFF2", type: "font/woff2", magic: ascii("wOF2") },
  glb: { kind: "model3d", name: "glTF binary", type: "model/gltf-binary", magic: ascii("glTF") },
};

/** Kinds read as text: the extension names the kind, the bytes must be text. */
const TEXTUAL: Readonly<Record<string, FileKind>> = {
  csv: "csv",
  tsv: "csv",
  jsonl: "csv",
  ndjson: "csv",
  gltf: "model3d",
  json: "config",
  jsonc: "config",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  conf: "config",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  patch: "patch",
  diff: "patch",
  log: "log",
  ansi: "log",
  srt: "subtitles",
  vtt: "subtitles",
  ics: "calendar",
};

/**
 * Archives: the extension names the kind and the bytes confirm it. Their
 * media type is never an archive type; the media route sends octet-stream.
 * `gz` counts only as the end of `.tar.gz`.
 */
const ARCHIVES: Readonly<Record<string, Magic>> = {
  zip: bytes(0x50, 0x4b, 0x03, 0x04),
  tar: ascii("ustar", 257),
  tgz: bytes(0x1f, 0x8b),
  gz: bytes(0x1f, 0x8b),
};

const isArchive = (path: string, head: Uint8Array): boolean => {
  const ext = extension(path);
  if (ext === "gz" && !/\.tar\.gz$/i.test(path)) return false;
  return ARCHIVES[ext]?.(head) === true;
};

/** For a caller that has only a name: the kind its extension gives. */
export const NO_BYTES: Uint8Array = new Uint8Array(0);

/** How many leading bytes the registry needs to decide. */
export const HEAD_BYTES = 4096;

const extension = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Git's own heuristic: a NUL in the first 8 KB means binary. */
const looksBinary = (head: Uint8Array): boolean => head.subarray(0, 8000).includes(0);

/** The allowlisted media entry for a file, if its bytes agree with its name. */
function confirmed(path: string, head: Uint8Array): Media | undefined {
  const media = MEDIA[extension(path)];
  if (media === undefined) return undefined;
  if (media.magic !== undefined && !media.magic(head)) return undefined;
  return media;
}

/**
 * What a file is, from its name and its first bytes (`HEAD_BYTES` is enough).
 * A name the bytes contradict — a `.png` that is not a PNG — is read as the
 * text or binary its bytes say it is.
 */
export function fileKind(path: string, head: Uint8Array): FileKind {
  const media = confirmed(path, head);
  if (media !== undefined) return media.kind;
  if (isArchive(path, head)) return "archive";
  if (looksBinary(head)) return "binary";
  return TEXTUAL[extension(path)] ?? "text";
}

/**
 * What a file's name alone claims to be, unconfirmed: for a page that never
 * read the bytes (a long video) and only points an element at the media
 * route, which confirms them before it sends one with this type.
 */
export function claimedMedia(
  path: string,
): { kind: FileKind; type: string; name: string } | undefined {
  const media = MEDIA[extension(path)];
  return media === undefined ? undefined : { kind: media.kind, type: media.type, name: media.name };
}

/**
 * The one content type the media route sends a file under: an allowlisted
 * media type its bytes confirm, or `application/octet-stream`.
 */
export function mediaType(path: string, head: Uint8Array): string {
  return confirmed(path, head)?.type ?? "application/octet-stream";
}

/** Every extension the registry names, for the test that walks them all. */
export const KNOWN_EXTENSIONS: readonly string[] = [
  ...Object.keys(MEDIA),
  ...Object.keys(TEXTUAL),
  "zip",
  "tar",
  "tgz",
];
