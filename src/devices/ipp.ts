/**
 * IPP Get-Printer-Attributes: a small encoder and decoder, no dependency.
 * Wire format: RFC 8010 (encoding), operation 0x000B from RFC 8011 §4.2.5.
 * Plain bytes in, plain data out; `probePrinter` is the one function that
 * touches the network, to the one validated URL it is given.
 */

const OP_GET_PRINTER_ATTRIBUTES = 0x000b; // RFC 8011 §5.2 operation-id registry
const TAG = {
  operation: 0x01,
  end: 0x03,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  language: 0x48,
} as const;

const WANTED = [
  "printer-make-and-model",
  "printer-state",
  "printer-state-reasons",
  "printer-state-message",
  "marker-names",
  "marker-levels",
  "marker-types",
  "marker-colors",
];

const RESPONSE_MAX = 256 * 1024;

export type IppValue = string | number | boolean | Uint8Array;
export type IppAttributes = Map<string, IppValue[]>;

const enc = new TextEncoder();

function attr(tag: number, name: string, value: string): number[] {
  const n = enc.encode(name);
  const v = enc.encode(value);
  return [tag, n.length >> 8, n.length & 255, ...n, v.length >> 8, v.length & 255, ...v];
}

/** The request body for Get-Printer-Attributes on `printerUri`. */
export function encodeGetPrinterAttributes(printerUri: string, requestId = 1): Uint8Array {
  const out: number[] = [
    1, 1, // version 1.1
    OP_GET_PRINTER_ATTRIBUTES >> 8, OP_GET_PRINTER_ATTRIBUTES & 255,
    (requestId >>> 24) & 255, (requestId >>> 16) & 255, (requestId >>> 8) & 255, requestId & 255,
    TAG.operation,
    ...attr(TAG.charset, "attributes-charset", "utf-8"),
    ...attr(TAG.language, "attributes-natural-language", "en"),
    ...attr(TAG.uri, "printer-uri", printerUri),
  ];
  WANTED.forEach((k, i) => out.push(...attr(TAG.keyword, i === 0 ? "requested-attributes" : "", k)));
  out.push(TAG.end);
  return Uint8Array.from(out);
}

export interface IppResponse {
  readonly status: number;
  readonly attributes: IppAttributes;
}

/** Decode a response; `undefined` when the bytes are not well-formed IPP. */
export function decodeResponse(bytes: Uint8Array): IppResponse | undefined {
  if (bytes.length < 9) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getUint16(2);
  const attributes: IppAttributes = new Map();
  const text = new TextDecoder("utf-8", { fatal: false });
  let at = 8;
  let last = "";
  while (at < bytes.length) {
    const tag = bytes[at++]!;
    if (tag === TAG.end) return { status, attributes };
    if (tag <= 0x05) continue; // a group delimiter
    if (at + 2 > bytes.length) return undefined;
    const nameLength = view.getUint16(at);
    at += 2;
    if (at + nameLength + 2 > bytes.length) return undefined;
    const name = nameLength === 0 ? last : text.decode(bytes.subarray(at, at + nameLength));
    at += nameLength;
    const length = view.getUint16(at);
    at += 2;
    if (at + length > bytes.length) return undefined;
    const raw = bytes.subarray(at, at + length);
    at += length;
    last = name;
    let value: IppValue;
    if ((tag === TAG.integer || tag === TAG.enum) && length === 4) value = view.getInt32(at - 4);
    else if (tag === TAG.boolean && length === 1) value = raw[0] !== 0;
    else if (tag >= 0x40 && tag <= 0x4f) value = text.decode(raw);
    else if (tag === 0x34 || tag === 0x37 || tag === 0x4a) continue; // collections: not read
    else value = Uint8Array.from(raw);
    const list = attributes.get(name);
    if (list) list.push(value);
    else attributes.set(name, [value]);
  }
  return undefined; // no end-of-attributes tag
}

export type PrinterState = "idle" | "printing" | "stopped" | "unknown";

export interface Supply {
  readonly name: string;
  /** Percent 0–100, or null when the printer does not know (IPP reports −1 to −3). */
  readonly percent: number | null;
  readonly type: string;
}

export interface PrinterReport {
  readonly model: string;
  readonly state: PrinterState;
  readonly reasons: readonly string[];
  readonly message: string;
  readonly supplies: readonly Supply[];
}

const str = (a: IppAttributes, k: string): string[] =>
  (a.get(k) ?? []).filter((v): v is string => typeof v === "string");

/** printer-state enum: 3 idle, 4 processing, 5 stopped (RFC 8011 §5.4.11). */
function stateOf(code: unknown): PrinterState {
  return code === 3 ? "idle" : code === 4 ? "printing" : code === 5 ? "stopped" : "unknown";
}

/** Plain data from the decoded attributes. */
export function reportOf(attributes: IppAttributes): PrinterReport {
  const names = str(attributes, "marker-names");
  const types = str(attributes, "marker-types");
  const levels = (attributes.get("marker-levels") ?? []).filter((v): v is number => typeof v === "number");
  return {
    model: str(attributes, "printer-make-and-model")[0] ?? "",
    state: stateOf(attributes.get("printer-state")?.[0]),
    reasons: str(attributes, "printer-state-reasons").filter((r) => r !== "none"),
    message: str(attributes, "printer-state-message")[0] ?? "",
    supplies: names.map((name, i) => {
      const level = levels[i];
      return {
        name,
        type: types[i] ?? "",
        percent: level !== undefined && level >= 0 && level <= 100 ? level : null,
      };
    }),
  };
}

export type ProbeResult =
  | { readonly ok: true; readonly report: PrinterReport }
  | { readonly ok: false; readonly error: "unreachable" | "refused" | "bad_answer" };

/**
 * Ask the printer at `url` (already validated: `core/devices.ts`). The
 * transport is HTTP(S) to the same host, port and path; IPP's `ipp:` scheme
 * is `http:` on the wire. Redirects are errors, the answer is size-capped and
 * the wait bounded.
 */
export async function probePrinter(url: string, timeoutMs = 2500): Promise<ProbeResult> {
  const parsed = URL.parse(url);
  if (parsed === null) return { ok: false, error: "bad_answer" };
  const secure = parsed.protocol === "ipps:" || parsed.protocol === "https:";
  const ipp = parsed.protocol === "ipp:" || parsed.protocol === "ipps:";
  // A non-special scheme (`ipp:`) cannot be switched in place: rebuild the string.
  const port = parsed.port === "" && ipp ? "631" : parsed.port;
  const wire = `${secure ? "https" : "http"}://${parsed.hostname}${port === "" ? "" : `:${port}`}${parsed.pathname}`;
  try {
    const res = await fetch(wire, {
      method: "POST",
      headers: { "content-type": "application/ipp" },
      body: encodeGetPrinterAttributes(url),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: "refused" };
    const bytes = await readCapped(res);
    if (bytes === undefined) return { ok: false, error: "bad_answer" };
    const decoded = decodeResponse(bytes);
    // 0x0000–0x00ff: successful (RFC 8011 §5.4.1).
    if (decoded === undefined || decoded.status > 0xff) return { ok: false, error: "bad_answer" };
    return { ok: true, report: reportOf(decoded.attributes) };
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

async function readCapped(res: Response): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > RESPONSE_MAX) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
