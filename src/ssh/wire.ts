/**
 * SSH wire vocabulary: the RFC 4251 §5 data types, plus the message numbers
 * and disconnect reason codes everything else in `src/ssh/` speaks.
 *
 * Error discipline: `Reader` throws `WireError` on a short or out-of-range
 * read rather than threading a `Result` through every field access — a packet
 * parse is a dozen reads deep and `Result` at that grain is unreadable.
 * `WireError` is a *contained* expected failure: every entry point that feeds
 * a reader (the transport's packet dispatch) catches it and turns it into a
 * DISCONNECT. It must never escape into the event loop.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** A malformed peer packet. Caught at the packet-dispatch boundary. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

/** Transport-layer message numbers (RFC 4250 §4.1.2, 5656 §7.1, 8308 §2.3). */
export const MSG = {
  DISCONNECT: 1,
  IGNORE: 2,
  UNIMPLEMENTED: 3,
  DEBUG: 4,
  SERVICE_REQUEST: 5,
  SERVICE_ACCEPT: 6,
  EXT_INFO: 7,
  KEXINIT: 20,
  NEWKEYS: 21,
  /** 30–49 are key-exchange-method specific; for ECDH these two. */
  KEX_ECDH_INIT: 30,
  KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50,
  USERAUTH_FAILURE: 51,
  USERAUTH_SUCCESS: 52,
  USERAUTH_BANNER: 53,
  /** 60–79 are userauth-method specific; 60 is PK_OK under `publickey`. */
  USERAUTH_PK_OK: 60,
  GLOBAL_REQUEST: 80,
  REQUEST_SUCCESS: 81,
  REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90,
  CHANNEL_OPEN_CONFIRMATION: 91,
  CHANNEL_OPEN_FAILURE: 92,
  CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94,
  CHANNEL_EXTENDED_DATA: 95,
  CHANNEL_EOF: 96,
  CHANNEL_CLOSE: 97,
  CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99,
  CHANNEL_FAILURE: 100,
} as const;

/** SSH_DISCONNECT_* reason codes (RFC 4250 §4.2.2). */
export const DISCONNECT = {
  PROTOCOL_ERROR: 2,
  KEY_EXCHANGE_FAILED: 3,
  MAC_ERROR: 5,
  SERVICE_NOT_AVAILABLE: 7,
  CONNECTION_LOST: 10,
  BY_APPLICATION: 11,
  NO_MORE_AUTH_METHODS_AVAILABLE: 14,
} as const;

/** SSH_OPEN_* channel-open failure codes (RFC 4254 §5.1). */
export const OPEN_FAILURE = {
  ADMINISTRATIVELY_PROHIBITED: 1,
  UNKNOWN_CHANNEL_TYPE: 3,
  RESOURCE_SHORTAGE: 4,
} as const;

/** SSH_EXTENDED_DATA_STDERR (RFC 4254 §5.2) — the only defined data type. */
export const EXTENDED_DATA_STDERR = 1;

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Cursor over a packet payload. Every accessor is bounds-checked. */
export class Reader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Bytes consumed so far. Used to slice the exact signed prefix in auth. */
  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private take(n: number): number {
    if (n < 0 || n > this.remaining) {
      throw new WireError(`short read: want ${n}, have ${this.remaining}`);
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    // SAFETY: take() proved the index is in range.
    return this.buf[this.take(1)]!;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    return this.view.getUint32(this.take(4), false);
  }

  /** `n` raw octets. Shares memory with the underlying buffer. */
  bytes(n: number): Uint8Array {
    const at = this.take(n);
    return this.buf.subarray(at, at + n);
  }

  /** `string`: uint32 length + that many raw octets. May hold binary. */
  string(): Uint8Array {
    return this.bytes(this.u32());
  }

  /** A `string` decoded as UTF-8 (algorithm names, service names, …). */
  text(): string {
    return fromUtf8(this.string());
  }

  /** `name-list`: a `string` of comma-separated ASCII names. */
  nameList(): string[] {
    const raw = this.text();
    return raw === "" ? [] : raw.split(",");
  }

  /** Reject trailing bytes — a blob with a tail is a different blob. */
  end(): void {
    if (this.remaining !== 0) {
      throw new WireError(`${this.remaining} trailing bytes`);
    }
  }
}

/** Append-only builder for a packet payload. */
export class Writer {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = Math.max(this.buf.length * 2, 64);
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): this {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u32(value: number): this {
    this.ensure(4);
    this.buf[this.len++] = (value >>> 24) & 0xff;
    this.buf[this.len++] = (value >>> 16) & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
    this.buf[this.len++] = value & 0xff;
    return this;
  }

  /** Raw octets, no length prefix. */
  raw(bytes: Uint8Array): this {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    return this;
  }

  string(value: Uint8Array | string): this {
    const bytes = typeof value === "string" ? utf8(value) : value;
    return this.u32(bytes.length).raw(bytes);
  }

  /**
   * `mpint`: two's-complement big-endian. `value` is an unsigned magnitude —
   * strip leading zeros, then re-prepend one 0x00 if the high bit is set, or
   * the peer reads a negative number. Half of all X25519 shared secrets have
   * that high bit set, which is why forgetting this fails only half the time.
   */
  mpint(value: Uint8Array): this {
    let start = 0;
    while (start < value.length && value[start] === 0) start++;
    const magnitude = value.subarray(start);
    if (magnitude.length === 0) return this.u32(0);
    const needsSignByte = (magnitude[0]! & 0x80) !== 0;
    this.u32(magnitude.length + (needsSignByte ? 1 : 0));
    if (needsSignByte) this.u8(0);
    return this.raw(magnitude);
  }

  nameList(names: readonly string[]): this {
    return this.string(names.join(","));
  }

  build(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Encode a single `string` — the shape hashed into H and signed blobs. */
export function sshString(value: Uint8Array | string): Uint8Array {
  return new Writer(64).string(value).build();
}

/**
 * Growable FIFO over inbound TCP bytes. TCP gives no framing: a packet may
 * span reads and a read may hold many packets, so the receive path is
 * "append, then loop while a whole packet is present".
 */
export class ByteQueue {
  private buf = new Uint8Array(16384);
  private head = 0;
  private tail = 0;

  get size(): number {
    return this.tail - this.head;
  }

  push(chunk: Uint8Array): void {
    if (this.buf.length - this.tail < chunk.length) {
      const size = this.size;
      if (this.buf.length - size >= chunk.length) {
        this.buf.copyWithin(0, this.head, this.tail);
      } else {
        let cap = Math.max(this.buf.length * 2, 16384);
        while (cap - size < chunk.length) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(this.head, this.tail));
        this.buf = next;
      }
      this.head = 0;
      this.tail = size;
    }
    this.buf.set(chunk, this.tail);
    this.tail += chunk.length;
  }

  /** View of the first `n` queued bytes. Invalid after the next `push`. */
  peek(n: number): Uint8Array {
    return this.buf.subarray(this.head, this.head + n);
  }

  skip(n: number): void {
    this.head += n;
    if (this.head >= this.tail) {
      this.head = 0;
      this.tail = 0;
    }
  }
}
