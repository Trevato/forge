/**
 * One connection's SSH transport layer (RFC 4253): version exchange, binary
 * packet framing, KEXINIT negotiation, curve25519 key exchange, the exchange
 * hash, key derivation, NEWKEYS, strict KEX, rekey, and EXT_INFO.
 *
 * Above this line everything is a plain payload: `send(payload)` out,
 * `host.payload(payload, seq)` in. The transport never throws at its caller —
 * a malformed packet becomes a DISCONNECT and a closed socket.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomFillSync,
} from "node:crypto";
import type { Log } from "../kernel/log.ts";
import { deriveKey, exchangeHashOf } from "./kex.ts";
import { type HostKey, SERVER_SIG_ALGS, signWithHostKey } from "./keys.ts";
import {
  ByteQueue,
  concat,
  DISCONNECT,
  fromUtf8,
  MSG,
  Reader,
  utf8,
  WireError,
  Writer,
} from "./wire.ts";

/** Matches OpenSSH's PACKET_MAX_SIZE. Comfortably covers git pack data. */
const MAX_PACKET = 262144;
/** Before the first NEWKEYS an unauthenticated peer must not be able to make
 *  us allocate 256 KiB, so the RFC 4253 §6.1 floor applies instead. */
const MAX_PACKET_PLAINTEXT = 35000;
/** Version line: 255 bytes including CRLF, and we discard at most this much
 *  pre-banner junk before giving up. */
const MAX_VERSION_LINE = 255;
const MAX_VERSION_DISCARD = 1024;

/** Real key exchange methods, in our preference order. Identical behaviour;
 *  the `@libssh.org` name simply predates standardisation. */
const KEX_ALGORITHMS = ["curve25519-sha256", "curve25519-sha256@libssh.org"];
const HOST_KEY_ALGORITHMS = ["ssh-ed25519"];
const CIPHERS = ["aes256-gcm@openssh.com", "aes128-gcm@openssh.com"];
/** Advertised but ignored: under GCM, MAC negotiation is skipped entirely
 *  (OpenSSH PROTOCOL §1.6). An empty list is legal but has upset older
 *  implementations, and populating it costs nothing. */
const MACS = ["hmac-sha2-256"];
const COMPRESSION = ["none"];

const STRICT_KEX_CLIENT = "kex-strict-c-v00@openssh.com";
const STRICT_KEX_SERVER = "kex-strict-s-v00@openssh.com";
const EXT_INFO_CLIENT = "ext-info-c";

/** Pseudo-algorithm names that ride in `kex_algorithms` but are not key
 *  exchange methods. Selecting one of these as "the kex" is a classic bug. */
const PSEUDO_KEX = new Set([
  EXT_INFO_CLIENT,
  "ext-info-s",
  STRICT_KEX_CLIENT,
  STRICT_KEX_SERVER,
  "kex-strict-c",
  "kex-strict-s",
]);

type GcmName = "aes-256-gcm" | "aes-128-gcm";

const CIPHER_SPECS: Record<string, { node: GcmName; keyLength: number }> = {
  "aes256-gcm@openssh.com": { node: "aes-256-gcm", keyLength: 32 },
  "aes128-gcm@openssh.com": { node: "aes-128-gcm", keyLength: 16 },
};

interface CipherKeys {
  readonly node: GcmName;
  readonly key: Uint8Array;
  /** 12 bytes: a 4-byte fixed field then an 8-byte invocation counter that we
   *  increment in place after every packet (RFC 5647 §7.1). */
  readonly iv: Uint8Array;
}

export interface TransportHost {
  /** Hand framed bytes to the socket. */
  write(data: Uint8Array): void;
  /** A payload the transport did not consume, with its receive sequence number. */
  payload(payload: Uint8Array, seq: number): void;
  /** The transport is finished; close the socket. */
  closed(why: string): void;
  log: Log;
}

/** RFC 4253 §9: rekey after this much traffic (both ways) under one set of keys. */
export const REKEY_BYTES = 1024 * 1024 * 1024;
/** And after this long under one set of keys. */
export const REKEY_MS = 60 * 60 * 1000;

export interface TransportOptions {
  readonly hostKey: HostKey;
  readonly serverVersion: string;
  /** @default REKEY_BYTES */
  readonly rekeyBytes?: number;
  /** @default REKEY_MS */
  readonly rekeyMs?: number;
  /** @default Date.now */
  readonly now?: () => number;
}

function incrementInvocationCounter(iv: Uint8Array): void {
  for (let at = 11; at >= 4; at--) {
    const next = (iv[at]! + 1) & 0xff;
    iv[at] = next;
    if (next !== 0) return;
  }
}

/** First entry of the peer's list that we also support. Client preference
 *  wins (RFC 4253 §7.1). */
function negotiate(
  theirs: readonly string[],
  ours: readonly string[],
): string | undefined {
  for (const name of theirs) if (ours.includes(name)) return name;
  return undefined;
}

export class Transport {
  private readonly q = new ByteQueue();
  private dead = false;

  private clientVersion: Uint8Array | undefined;
  private readonly serverVersion: Uint8Array;
  private versionDiscarded = 0;

  private seqIn = 0;
  private seqOut = 0;
  private packetsIn = 0;

  private inKeys: CipherKeys | undefined;
  private outKeys: CipherKeys | undefined;
  private pendingInKeys: CipherKeys | undefined;
  private pendingOutKeys: CipherKeys | undefined;

  /** H of the *first* key exchange, fixed for the life of the connection. */
  private sessionIdBytes: Uint8Array | undefined;

  private kexActive = false;
  private initialKexDone = false;
  private sawPeerKexInit = false;
  private sawEcdhInit = false;
  private discardGuess = false;
  private strictKex = false;
  private extInfoRequested = false;
  private newKeysSent = false;
  private newKeysReceived = false;
  /** I_S / I_C: the exact KEXINIT payload bytes, message byte included.
   *  Never rebuild these — a re-serialised KEXINIT gives a wrong H. */
  private myKexInit: Uint8Array | undefined;
  private peerKexInit: Uint8Array | undefined;
  private negotiated: { cipherIn: string; cipherOut: string } | undefined;

  /** Outbound payloads parked while a key exchange is in flight (RFC 4253 §9
   *  forbids non-KEX traffic between our KEXINIT and our NEWKEYS). */
  private readonly parked: Uint8Array[] = [];

  /** Bytes moved, either way, since the keys now in use took effect. */
  private volume = 0;
  private keyedAt = 0;

  constructor(
    private readonly host: TransportHost,
    private readonly options: TransportOptions,
  ) {
    this.serverVersion = utf8(options.serverVersion);
  }

  get sessionId(): Uint8Array | undefined {
    return this.sessionIdBytes;
  }

  /** Send our version line and first KEXINIT. Both sides send unprompted. */
  start(): void {
    this.host.write(concat(this.serverVersion, utf8("\r\n")));
    this.beginKex();
  }

  /** Feed bytes from the socket. */
  receive(chunk: Uint8Array): void {
    if (this.dead) return;
    this.q.push(chunk);
    try {
      if (!this.clientVersion && !this.readVersion()) return;
      while (!this.dead && this.readPacket()) {
        // Loop: one TCP read may carry many packets, and OpenSSH pipelines.
      }
    } catch (cause) {
      if (cause instanceof WireError) {
        this.disconnect(DISCONNECT.PROTOCOL_ERROR, cause.message);
      } else {
        this.host.log.error("ssh transport fault", { error: String(cause) });
        this.disconnect(DISCONNECT.PROTOCOL_ERROR, "internal error");
      }
    }
  }

  /** Send an upper-layer payload, parking it if a key exchange is running. */
  send(payload: Uint8Array): void {
    if (this.dead) return;
    this.rekeyIfDue();
    if (this.kexActive) {
      this.parked.push(payload);
      return;
    }
    this.sendNow(payload);
  }

  /**
   * The server starts a rekey itself once the keys have carried 1 GiB or an
   * hour (checked as traffic passes: an idle line has nothing to protect).
   * The peer's own KEXINIT meets ours in the same exchange.
   */
  private rekeyIfDue(): void {
    if (this.dead || this.kexActive || !this.initialKexDone) return;
    const now = (this.options.now ?? Date.now)();
    if (
      this.volume >= (this.options.rekeyBytes ?? REKEY_BYTES) ||
      now - this.keyedAt >= (this.options.rekeyMs ?? REKEY_MS)
    )
      this.beginKex();
  }

  /** Tell the peer we did not understand the packet at `seq` (RFC 4253 §11.4). */
  unimplemented(seq: number): void {
    this.send(new Writer(8).u8(MSG.UNIMPLEMENTED).u32(seq).build());
  }

  /** Send DISCONNECT (best effort) and tear the connection down. */
  disconnect(reason: number, description: string): void {
    if (this.dead) return;
    this.dead = true;
    if (this.clientVersion) {
      try {
        this.sendNow(
          new Writer(128)
            .u8(MSG.DISCONNECT)
            .u32(reason)
            .string(description)
            .string("")
            .build(),
        );
      } catch {
        // The socket may already be gone; nothing useful left to do.
      }
    }
    this.host.closed(description);
  }

  // --- version exchange (RFC 4253 §4.2) ---------------------------------

  private readVersion(): boolean {
    for (;;) {
      const view = this.q.peek(this.q.size);
      const nl = view.indexOf(0x0a);
      if (nl < 0) {
        if (this.q.size > MAX_VERSION_LINE) {
          this.fail("version line too long");
        }
        return false;
      }
      // CR MAY be omitted by non-conforming senders; tolerate a bare LF.
      const end = nl > 0 && view[nl - 1] === 0x0d ? nl - 1 : nl;
      const line = view.slice(0, end);
      this.q.skip(nl + 1);
      const text = fromUtf8(line);
      if (text.startsWith("SSH-")) {
        if (!text.startsWith("SSH-2.0-")) {
          this.fail(`unsupported protocol version ${text.slice(0, 16)}`);
          return false;
        }
        // V_C for the exchange hash: the line without CR/LF.
        this.clientVersion = line;
        return true;
      }
      this.versionDiscarded += nl + 1;
      if (this.versionDiscarded > MAX_VERSION_DISCARD) {
        this.fail("too much pre-version banner");
        return false;
      }
    }
  }

  /** Abandon before the binary packet layer exists: TCP close, no DISCONNECT. */
  private fail(why: string): void {
    if (this.dead) return;
    this.dead = true;
    this.host.closed(why);
  }

  // --- binary packet protocol (RFC 4253 §6) -----------------------------

  private readPacket(): boolean {
    const keys = this.inKeys;
    if (this.q.size < 4) return false;
    const head = this.q.peek(4);
    const length =
      ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;

    let payload: Uint8Array;
    if (keys) {
      // AES-GCM: packet_length is sent in the clear and is the sole AAD, so
      // the 16-byte alignment applies to packet_length *itself* — the length
      // field is excluded, unlike the generic rule in RFC 4253 §6.
      if (length < 16 || length > MAX_PACKET || length % 16 !== 0) {
        this.disconnect(DISCONNECT.PROTOCOL_ERROR, "bad packet length");
        return false;
      }
      const total = 4 + length + 16;
      if (this.q.size < total) return false;
      const frame = this.q.peek(total);
      const decipher = createDecipheriv(keys.node, keys.key, keys.iv);
      decipher.setAAD(frame.subarray(0, 4));
      decipher.setAuthTag(frame.subarray(4 + length, total));
      let plain: Buffer;
      try {
        plain = Buffer.concat([
          decipher.update(frame.subarray(4, 4 + length)),
          decipher.final(),
        ]);
      } catch {
        this.disconnect(DISCONNECT.MAC_ERROR, "authentication tag mismatch");
        return false;
      }
      const padding = plain[0]!;
      if (padding < 4 || padding > length - 2) {
        this.disconnect(DISCONNECT.PROTOCOL_ERROR, "bad padding length");
        return false;
      }
      payload = new Uint8Array(plain.subarray(1, length - padding));
      this.q.skip(total);
      this.volume += total;
      incrementInvocationCounter(keys.iv);
    } else {
      // Cipher `none`: 4 + packet_length must be a multiple of 8.
      if (
        length < 8 ||
        length > MAX_PACKET_PLAINTEXT ||
        (4 + length) % 8 !== 0
      ) {
        this.disconnect(DISCONNECT.PROTOCOL_ERROR, "bad packet length");
        return false;
      }
      const total = 4 + length;
      if (this.q.size < total) return false;
      const frame = this.q.peek(total);
      const padding = frame[4]!;
      if (padding < 4 || padding > length - 2) {
        this.disconnect(DISCONNECT.PROTOCOL_ERROR, "bad padding length");
        return false;
      }
      payload = frame.slice(5, 4 + length - padding);
      this.q.skip(total);
    }

    const seq = this.seqIn;
    this.seqIn = (this.seqIn + 1) >>> 0;
    this.packetsIn++;
    this.handle(payload, seq);
    this.rekeyIfDue();
    return !this.dead;
  }

  private sendNow(payload: Uint8Array): void {
    const keys = this.outKeys;
    let frame: Uint8Array;
    if (keys) {
      let padding = (16 - ((1 + payload.length) % 16)) % 16;
      if (padding < 4) padding += 16;
      const packetLength = 1 + payload.length + padding;
      const plain = new Uint8Array(packetLength);
      plain[0] = padding;
      plain.set(payload, 1);
      randomFillSync(plain, 1 + payload.length, padding);
      const lengthField = new Uint8Array(4);
      new DataView(lengthField.buffer).setUint32(0, packetLength, false);
      const cipher = createCipheriv(keys.node, keys.key, keys.iv);
      cipher.setAAD(lengthField);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      frame = concat(lengthField, body, cipher.getAuthTag());
      incrementInvocationCounter(keys.iv);
    } else {
      let padding = (8 - ((5 + payload.length) % 8)) % 8;
      if (padding < 4) padding += 8;
      const packetLength = 1 + payload.length + padding;
      frame = new Uint8Array(4 + packetLength);
      new DataView(frame.buffer).setUint32(0, packetLength, false);
      frame[4] = padding;
      frame.set(payload, 5);
      randomFillSync(frame, 5 + payload.length, padding);
    }
    this.volume += frame.length;
    this.host.write(frame);
    this.seqOut = (this.seqOut + 1) >>> 0;
  }

  // --- dispatch ----------------------------------------------------------

  private handle(payload: Uint8Array, seq: number): void {
    if (payload.length === 0) throw new WireError("empty payload");
    const type = payload[0]!;

    // Strict KEX rule 3: KEXINIT must be the peer's very first message. We
    // enforce it unconditionally — it only tightens, and every OpenSSH client
    // complies — because at seq 0 we do not yet know whether strict KEX is on.
    if (this.packetsIn === 1 && type !== MSG.KEXINIT) {
      this.disconnect(DISCONNECT.PROTOCOL_ERROR, "expected KEXINIT first");
      return;
    }
    // RFC 4253 §7.1: once a key exchange is under way, nothing but KEX
    // traffic (plus the always-legal DISCONNECT/IGNORE/DEBUG/UNIMPLEMENTED)
    // may arrive until the peer's NEWKEYS. This is not a strict-KEX-only
    // rule: a peer that simply omits the kex-strict-c extension name must
    // not be able to smuggle upper-layer messages (USERAUTH_REQUEST,
    // CHANNEL_OPEN, ...) through in plaintext by never sending its own
    // NEWKEYS. Without this check such a peer can authenticate and open
    // channels entirely unencrypted, defeating confidentiality outright.
    if (this.kexActive && !this.newKeysReceived) {
      if (
        type !== MSG.KEXINIT &&
        type !== MSG.NEWKEYS &&
        type !== MSG.KEX_ECDH_INIT &&
        type !== MSG.DISCONNECT &&
        type !== MSG.IGNORE &&
        type !== MSG.DEBUG &&
        type !== MSG.UNIMPLEMENTED
      ) {
        this.disconnect(
          DISCONNECT.PROTOCOL_ERROR,
          `message ${type} before NEWKEYS`,
        );
        return;
      }
    }
    // Strict KEX rule 2: during the *initial* exchange only KEX traffic is
    // legal — IGNORE/DEBUG/UNIMPLEMENTED included. Tighter than the general
    // rule above (Terrapin mitigation), so it still needs its own check.
    if (this.strictKex && !this.initialKexDone) {
      if (
        type !== MSG.KEXINIT &&
        type !== MSG.NEWKEYS &&
        type !== MSG.KEX_ECDH_INIT
      ) {
        this.disconnect(
          DISCONNECT.PROTOCOL_ERROR,
          `message ${type} during strict initial KEX`,
        );
        return;
      }
    }

    switch (type) {
      case MSG.DISCONNECT: {
        const r = new Reader(payload);
        r.u8();
        const reason = r.u32();
        this.dead = true;
        this.host.closed(`peer disconnect (reason ${reason})`);
        return;
      }
      case MSG.IGNORE:
      case MSG.DEBUG:
      case MSG.UNIMPLEMENTED:
        return;
      case MSG.KEXINIT:
        this.onKexInit(payload);
        return;
      case MSG.NEWKEYS:
        this.onNewKeys();
        return;
      case MSG.KEX_ECDH_INIT:
        this.onEcdhInit(payload);
        return;
      default:
        if (type >= 30 && type <= 49) {
          throw new WireError(`unexpected kex message ${type}`);
        }
        this.host.payload(payload, seq);
    }
  }

  // --- key exchange ------------------------------------------------------

  private beginKex(): void {
    this.kexActive = true;
    this.newKeysSent = false;
    this.newKeysReceived = false;
    this.sawPeerKexInit = false;
    this.sawEcdhInit = false;
    this.discardGuess = false;
    this.peerKexInit = undefined;
    this.negotiated = undefined;
    const kex = this.initialKexDone
      ? KEX_ALGORITHMS
      : [...KEX_ALGORITHMS, STRICT_KEX_SERVER];
    const payload = new Writer(512)
      .u8(MSG.KEXINIT)
      .raw(randomBytes(16))
      .nameList(kex)
      .nameList(HOST_KEY_ALGORITHMS)
      .nameList(CIPHERS)
      .nameList(CIPHERS)
      .nameList(MACS)
      .nameList(MACS)
      .nameList(COMPRESSION)
      .nameList(COMPRESSION)
      .nameList([])
      .nameList([])
      .bool(false)
      .u32(0)
      .build();
    this.myKexInit = payload;
    this.sendNow(payload);
  }

  private onKexInit(payload: Uint8Array): void {
    // Two KEXINITs inside one exchange is a violation; a KEXINIT after one
    // finished is a rekey request, and `beginKex` clears the flag below.
    if (this.kexActive && this.sawPeerKexInit) {
      throw new WireError("duplicate KEXINIT");
    }
    // A KEXINIT arriving outside a key exchange is the peer asking to rekey
    // (OpenSSH does this around 1 GiB or per RekeyLimit). Answer with ours.
    if (!this.kexActive) this.beginKex();
    this.sawPeerKexInit = true;
    this.peerKexInit = payload;

    const r = new Reader(payload);
    r.u8();
    r.bytes(16);
    const kexAlgorithms = r.nameList();
    const hostKeyAlgorithms = r.nameList();
    const cipherIn = r.nameList();
    const cipherOut = r.nameList();
    r.nameList();
    r.nameList();
    const compressionIn = r.nameList();
    const compressionOut = r.nameList();
    r.nameList();
    r.nameList();
    const guessed = r.bool();
    r.u32();

    const firstKex = !this.initialKexDone;
    if (firstKex) {
      // The kex-strict-* and ext-info-* names are only meaningful in the very
      // first KEXINIT (strict-kex draft §3.1, RFC 8308 §2.2).
      this.strictKex = kexAlgorithms.includes(STRICT_KEX_CLIENT);
      this.extInfoRequested = kexAlgorithms.includes(EXT_INFO_CLIENT);
      if (this.strictKex && this.packetsIn !== 1) {
        this.disconnect(
          DISCONNECT.PROTOCOL_ERROR,
          "strict KEX: KEXINIT was not the first packet",
        );
        return;
      }
    }

    const kex = negotiate(
      kexAlgorithms.filter((name) => !PSEUDO_KEX.has(name)),
      KEX_ALGORITHMS,
    );
    const hostKeyAlgorithm = negotiate(hostKeyAlgorithms, HOST_KEY_ALGORITHMS);
    const selectedIn = negotiate(cipherIn, CIPHERS);
    const selectedOut = negotiate(cipherOut, CIPHERS);
    const compIn = negotiate(compressionIn, COMPRESSION);
    const compOut = negotiate(compressionOut, COMPRESSION);
    // MAC lists are deliberately not consulted: with GCM the selection is
    // skipped and a failure to select MUST NOT fail the connection.
    if (
      !kex ||
      !hostKeyAlgorithm ||
      !selectedIn ||
      !selectedOut ||
      !compIn ||
      !compOut
    ) {
      this.disconnect(DISCONNECT.KEY_EXCHANGE_FAILED, "no common algorithm");
      return;
    }
    this.negotiated = { cipherIn: selectedIn, cipherOut: selectedOut };

    // first_kex_packet_follows: the peer already sent its guessed KEX packet.
    // The guess is judged on its *literal* first entries; if wrong, the next
    // kex packet must be silently discarded, not processed and not errored.
    if (
      guessed &&
      (kexAlgorithms[0] !== kex || hostKeyAlgorithms[0] !== hostKeyAlgorithm)
    ) {
      this.discardGuess = true;
    }
  }

  private onEcdhInit(payload: Uint8Array): void {
    if (this.discardGuess) {
      this.discardGuess = false;
      return;
    }
    if (!this.kexActive || !this.sawPeerKexInit || !this.negotiated) {
      throw new WireError("KEX_ECDH_INIT outside key exchange");
    }
    if (this.sawEcdhInit) throw new WireError("duplicate KEX_ECDH_INIT");
    this.sawEcdhInit = true;

    const r = new Reader(payload);
    r.u8();
    const clientPublic = r.string();
    r.end();
    // curve25519-sha256 carries the raw 32-byte u-coordinate, not a SEC1 point.
    if (clientPublic.length !== 32) {
      this.disconnect(DISCONNECT.KEY_EXCHANGE_FAILED, "bad Q_C length");
      return;
    }

    const ephemeral = generateKeyPairSync("x25519");
    // SPKI for X25519 is a fixed 12-byte prefix then the 32-byte key.
    const spki = ephemeral.publicKey.export({ type: "spki", format: "der" });
    const serverPublic = new Uint8Array(spki.subarray(spki.length - 32));

    let shared: Buffer;
    try {
      shared = diffieHellman({
        privateKey: ephemeral.privateKey,
        publicKey: createPublicKey({
          key: {
            kty: "OKP",
            crv: "X25519",
            x: Buffer.from(clientPublic).toString("base64url"),
          },
          format: "jwk",
        }),
      });
    } catch {
      this.disconnect(DISCONNECT.KEY_EXCHANGE_FAILED, "invalid client point");
      return;
    }
    if (shared.every((byte) => byte === 0)) {
      this.disconnect(
        DISCONNECT.KEY_EXCHANGE_FAILED,
        "degenerate shared secret",
      );
      return;
    }

    const hostBlob = this.options.hostKey.publicKey.blob;
    const kMpint = new Writer(48).mpint(shared).build();
    const exchangeHash = exchangeHashOf({
      clientVersion: this.clientVersion ?? new Uint8Array(0),
      serverVersion: this.serverVersion,
      peerKexInit: this.peerKexInit ?? new Uint8Array(0),
      myKexInit: this.myKexInit ?? new Uint8Array(0),
      hostBlob,
      clientPublic,
      serverPublic,
      kMpint,
    });
    // The first exchange hash becomes the session id and never changes, even
    // across rekeys (RFC 4253 §7.2).
    this.sessionIdBytes ??= exchangeHash;
    const sessionId = this.sessionIdBytes;

    this.sendNow(
      new Writer(256)
        .u8(MSG.KEX_ECDH_REPLY)
        .string(hostBlob)
        .string(serverPublic)
        // Ed25519 hashes internally: sign H itself, not a digest of H.
        .string(signWithHostKey(this.options.hostKey, exchangeHash))
        .build(),
    );

    const derive = (letter: string, length: number): Uint8Array =>
      deriveKey(kMpint, exchangeHash, letter, sessionId, length);

    const inSpec = CIPHER_SPECS[this.negotiated.cipherIn]!;
    const outSpec = CIPHER_SPECS[this.negotiated.cipherOut]!;
    this.pendingInKeys = {
      node: inSpec.node,
      key: derive("C", inSpec.keyLength),
      iv: derive("A", 12),
    };
    this.pendingOutKeys = {
      node: outSpec.node,
      key: derive("D", outSpec.keyLength),
      iv: derive("B", 12),
    };

    // NEWKEYS itself travels under the *old* cipher; the new send keys (and a
    // fresh GCM invocation counter) take effect immediately after it.
    this.sendNow(new Uint8Array([MSG.NEWKEYS]));
    this.outKeys = this.pendingOutKeys;
    this.pendingOutKeys = undefined;
    this.newKeysSent = true;
    if (this.strictKex) this.seqOut = 0;

    // EXT_INFO must be inside the encrypted transport, and OpenSSH sends it as
    // the first packet after NEWKEYS. Without `server-sig-algs` an RSA-only
    // client offers SHA-1 `ssh-rsa`, which we reject.
    if (!this.initialKexDone && this.extInfoRequested) {
      this.sendNow(
        new Writer(256)
          .u8(MSG.EXT_INFO)
          .u32(1)
          .string("server-sig-algs")
          .string(SERVER_SIG_ALGS)
          .build(),
      );
    }
    this.finishKexIfDone();
  }

  private onNewKeys(): void {
    const pending = this.pendingInKeys;
    if (!pending) throw new WireError("NEWKEYS outside key exchange");
    this.inKeys = pending;
    this.pendingInKeys = undefined;
    this.newKeysReceived = true;
    // Strict KEX resets both counters at the NEWKEYS boundary so an injected
    // or dropped pre-KEX packet cannot shift the sequence (Terrapin).
    if (this.strictKex) this.seqIn = 0;
    this.finishKexIfDone();
  }

  private finishKexIfDone(): void {
    if (!this.newKeysSent || !this.newKeysReceived) return;
    this.kexActive = false;
    this.initialKexDone = true;
    this.volume = 0;
    this.keyedAt = (this.options.now ?? Date.now)();
    while (this.parked.length > 0 && !this.dead && !this.kexActive) {
      // SAFETY: length > 0 was just checked.
      this.sendNow(this.parked.shift()!);
    }
  }
}
