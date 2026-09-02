/**
 * The connection protocol (RFC 4254): `session` channels and nothing else.
 * No port forwarding, no X11, no subsystems — a forge needs a shell and an
 * exec, and every other channel type is attack surface.
 *
 * Flow control is the part that silently hangs when it is wrong, so both
 * windows are explicit: `remoteWindow` is credit the peer granted us and is
 * never exceeded; `localWindow` is credit we granted and is topped up before
 * it runs dry.
 */

import type { Log } from "../kernel/log.ts";
import type { SshPublicKey } from "./keys.ts";
import {
  EXTENDED_DATA_STDERR,
  MSG,
  OPEN_FAILURE,
  Reader,
  utf8,
  WireError,
  Writer,
} from "./wire.ts";

/** Credit we advertise: large enough that a big push never stalls on
 *  round-trips for more window. */
const LOCAL_WINDOW = 2 * 1024 * 1024;
/** Largest CHANNEL_DATA payload we accept — the RFC 4253 §6.1 floor, which
 *  every implementation supports. Distinct from the transport packet cap. */
const LOCAL_MAX_PACKET = 32768;
/** Largest CHANNEL_DATA payload we send, before the peer's own limits. */
const SEND_CHUNK = 32768;
const MAX_CHANNELS = 8;
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE = 1024;
const UINT32_MAX = 0xffffffff;

export interface SshSession {
  readonly key: SshPublicKey;
  readonly username: string;
  readonly remoteAddress: string;
  readonly kind: "shell" | "exec";
  readonly command: string | undefined;
  readonly term: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  /** 0 when the client requested no pty. */
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array | string): void;
  writeStderr(data: Uint8Array | string): void;
  onData(cb: (data: Uint8Array) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  onClose(cb: () => void): void;
  exit(code: number): void;
}

export interface ChannelHost {
  send(payload: Uint8Array): void;
  unimplemented(seq: number): void;
  disconnect(reason: number, description: string): void;
  onSession(session: SshSession): void;
  readonly key: SshPublicKey;
  readonly username: string;
  readonly remoteAddress: string;
  readonly log: Log;
}

interface Outgoing {
  readonly data: Uint8Array;
  offset: number;
  readonly stderr: boolean;
}

class Channel implements SshSession {
  kind: "shell" | "exec" = "shell";
  command: string | undefined;
  term: string | undefined;
  cols = 0;
  rows = 0;
  readonly env: Record<string, string> = {};

  private started = false;
  private readonly queue: Outgoing[] = [];
  private exitCode: number | undefined;
  private sentClose = false;
  private closeFired = false;
  private localWindow = LOCAL_WINDOW;

  private dataCb: ((data: Uint8Array) => void) | undefined;
  private resizeCb: ((cols: number, rows: number) => void) | undefined;
  private closeCb: (() => void) | undefined;

  constructor(
    private readonly host: ChannelHost,
    readonly id: number,
    readonly peerId: number,
    private remoteWindow: number,
    private readonly remoteMaxPacket: number,
  ) {}

  get key(): SshPublicKey {
    return this.host.key;
  }
  get username(): string {
    return this.host.username;
  }
  get remoteAddress(): string {
    return this.host.remoteAddress;
  }
  get running(): boolean {
    return this.started;
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resizeCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  write(data: Uint8Array | string): void {
    this.enqueue(data, false);
  }
  writeStderr(data: Uint8Array | string): void {
    this.enqueue(data, true);
  }

  private enqueue(data: Uint8Array | string, stderr: boolean): void {
    if (this.sentClose || this.exitCode !== undefined) return;
    const bytes = typeof data === "string" ? utf8(data) : data;
    if (bytes.length === 0) return;
    this.queue.push({ data: bytes, offset: 0, stderr });
    this.flush();
  }

  exit(code: number): void {
    if (this.sentClose || this.exitCode !== undefined) return;
    this.exitCode = code;
    this.flush();
  }

  /** Push as much queued output as the peer's window and packet cap allow. */
  flush(): void {
    while (this.queue.length > 0 && this.remoteWindow > 0 && !this.sentClose) {
      // SAFETY: length > 0 was just checked.
      const head = this.queue[0]!;
      const n = Math.min(
        head.data.length - head.offset,
        this.remoteWindow,
        this.remoteMaxPacket,
        SEND_CHUNK,
      );
      if (n <= 0) break;
      const slice = head.data.subarray(head.offset, head.offset + n);
      const w = new Writer(n + 32);
      if (head.stderr) {
        w.u8(MSG.CHANNEL_EXTENDED_DATA)
          .u32(this.peerId)
          .u32(EXTENDED_DATA_STDERR);
      } else {
        w.u8(MSG.CHANNEL_DATA).u32(this.peerId);
      }
      this.host.send(w.string(slice).build());
      head.offset += n;
      this.remoteWindow -= n;
      if (head.offset >= head.data.length) this.queue.shift();
    }
    if (
      this.queue.length === 0 &&
      this.exitCode !== undefined &&
      !this.sentClose
    ) {
      this.finish(this.exitCode);
    }
  }

  /** exit-status → EOF → CLOSE. A status after CLOSE is too late: the client
   *  has already decided the command died and reports 255. */
  private finish(code: number): void {
    this.sentClose = true;
    this.host.send(
      new Writer(64)
        .u8(MSG.CHANNEL_REQUEST)
        .u32(this.peerId)
        .string("exit-status")
        .bool(false)
        .u32(code >>> 0)
        .build(),
    );
    this.host.send(new Writer(8).u8(MSG.CHANNEL_EOF).u32(this.peerId).build());
    this.host.send(
      new Writer(8).u8(MSG.CHANNEL_CLOSE).u32(this.peerId).build(),
    );
  }

  /** Send CLOSE without a status — used when the peer closed on us first. */
  closeNow(): void {
    if (this.sentClose) return;
    this.sentClose = true;
    this.host.send(
      new Writer(8).u8(MSG.CHANNEL_CLOSE).u32(this.peerId).build(),
    );
  }

  fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    const cb = this.closeCb;
    if (!cb) return;
    try {
      cb();
    } catch (cause) {
      this.host.log.error("ssh session onClose threw", {
        error: String(cause),
      });
    }
  }

  adjustRemoteWindow(bytes: number): void {
    if (this.remoteWindow + bytes > UINT32_MAX) {
      throw new WireError("window adjust overflow");
    }
    this.remoteWindow += bytes;
    this.flush();
  }

  receiveData(data: Uint8Array): void {
    if (data.length > this.localWindow) {
      throw new WireError("peer overran the channel window");
    }
    this.localWindow -= data.length;
    // Top up before the client can run dry: half the window is the standard
    // hysteresis and keeps a bulk transfer from stalling on round-trips.
    if (this.localWindow < LOCAL_WINDOW / 2) {
      const top = LOCAL_WINDOW - this.localWindow;
      this.localWindow = LOCAL_WINDOW;
      this.host.send(
        new Writer(16)
          .u8(MSG.CHANNEL_WINDOW_ADJUST)
          .u32(this.peerId)
          .u32(top)
          .build(),
      );
    }
    const cb = this.dataCb;
    if (!cb) return;
    try {
      cb(data);
    } catch (cause) {
      this.host.log.error("ssh session onData threw", { error: String(cause) });
    }
  }

  /** Handle a CHANNEL_REQUEST. Returns whether to answer SUCCESS. */
  request(type: string, r: Reader): boolean {
    switch (type) {
      case "pty-req": {
        this.term = r.text();
        this.cols = r.u32();
        this.rows = r.u32();
        r.u32();
        r.u32();
        // Terminal modes are parsed only to prove the packet is well formed;
        // we allocate no pty, so there is no termios to apply.
        r.string();
        return true;
      }
      case "env": {
        const name = r.text();
        const value = r.text();
        if (
          Object.keys(this.env).length < MAX_ENV_VARS &&
          value.length <= MAX_ENV_VALUE &&
          /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)
        ) {
          this.env[name] = value;
        }
        return true;
      }
      case "shell":
      case "exec": {
        // RFC 4254 §6.5: at most one of shell/exec/subsystem per channel.
        if (this.started) return false;
        this.started = true;
        this.kind = type === "exec" ? "exec" : "shell";
        if (type === "exec") this.command = r.text();
        return true;
      }
      case "window-change": {
        this.cols = r.u32();
        this.rows = r.u32();
        const cb = this.resizeCb;
        if (cb) {
          try {
            cb(this.cols, this.rows);
          } catch (cause) {
            this.host.log.error("ssh session onResize threw", {
              error: String(cause),
            });
          }
        }
        return true;
      }
      case "signal":
      case "xon-xoff":
      case "eow@openssh.com":
        return true;
      default:
        // subsystem (sftp), x11-req, and anything else.
        return false;
    }
  }

  /** Hand the session to the application once shell/exec has been accepted. */
  begin(): void {
    try {
      this.host.onSession(this);
    } catch (cause) {
      this.host.log.error("ssh onSession threw", { error: String(cause) });
      this.exit(1);
    }
  }
}

export class Channels {
  private readonly channels = new Map<number, Channel>();
  private nextId = 1;

  constructor(private readonly host: ChannelHost) {}

  /** Handle one post-auth payload. Throws `WireError` on a malformed packet. */
  handle(payload: Uint8Array, seq: number): void {
    // SAFETY: the transport rejects empty payloads before dispatch.
    const type = payload[0]!;
    const r = new Reader(payload);
    r.u8();
    switch (type) {
      case MSG.GLOBAL_REQUEST: {
        r.text();
        const wantReply = r.bool();
        // We support no global requests. REQUEST_FAILURE is the right answer
        // to all of them, keepalive@openssh.com included — the client only
        // cares that *a* reply arrives. Replying when want_reply is false
        // would desynchronise the client's reply queue.
        if (wantReply) {
          this.host.send(new Uint8Array([MSG.REQUEST_FAILURE]));
        }
        return;
      }
      case MSG.CHANNEL_OPEN:
        this.open(r);
        return;
      case MSG.CHANNEL_WINDOW_ADJUST: {
        const channel = this.lookup(r.u32());
        channel?.adjustRemoteWindow(r.u32());
        return;
      }
      case MSG.CHANNEL_DATA: {
        const channel = this.lookup(r.u32());
        const data = r.string();
        if (data.length > LOCAL_MAX_PACKET) {
          throw new WireError("channel data exceeds maximum packet size");
        }
        channel?.receiveData(data.slice());
        return;
      }
      case MSG.CHANNEL_EOF: {
        // "I will send no more data." The channel stays open our way, so the
        // application gets onClose and decides when to exit.
        this.lookup(r.u32())?.fireClose();
        return;
      }
      case MSG.CHANNEL_CLOSE: {
        const channel = this.lookup(r.u32());
        if (!channel) return;
        channel.fireClose();
        channel.closeNow();
        this.channels.delete(channel.id);
        return;
      }
      case MSG.CHANNEL_REQUEST: {
        const channel = this.lookup(r.u32());
        const request = r.text();
        const wantReply = r.bool();
        if (!channel) {
          if (wantReply) this.host.send(new Uint8Array([MSG.REQUEST_FAILURE]));
          return;
        }
        const started = channel.running;
        const okay = channel.request(request, r);
        // Replies go out in arrival order; OpenSSH pipelines pty-req, several
        // envs and shell without waiting for any of them.
        if (wantReply) {
          this.host.send(
            new Writer(8)
              .u8(okay ? MSG.CHANNEL_SUCCESS : MSG.CHANNEL_FAILURE)
              .u32(channel.peerId)
              .build(),
          );
        }
        if (okay && !started && channel.running) channel.begin();
        return;
      }
      case MSG.CHANNEL_OPEN_CONFIRMATION:
      case MSG.CHANNEL_OPEN_FAILURE:
      case MSG.CHANNEL_SUCCESS:
      case MSG.CHANNEL_FAILURE:
        // We never open a channel or send a request that wants a reply.
        return;
      default:
        this.host.unimplemented(seq);
    }
  }

  /** Fire onClose for every live session — the socket went away. */
  shutdown(): void {
    for (const channel of this.channels.values()) channel.fireClose();
    this.channels.clear();
  }

  private lookup(id: number): Channel | undefined {
    return this.channels.get(id);
  }

  private open(r: Reader): void {
    const kind = r.text();
    const peerId = r.u32();
    const window = r.u32();
    const maxPacket = r.u32();
    const fail = (reason: number, description: string): void => {
      this.host.send(
        new Writer(128)
          .u8(MSG.CHANNEL_OPEN_FAILURE)
          .u32(peerId)
          .u32(reason)
          .string(description)
          .string("")
          .build(),
      );
    };
    if (kind !== "session") {
      fail(OPEN_FAILURE.UNKNOWN_CHANNEL_TYPE, `unsupported channel ${kind}`);
      return;
    }
    if (this.channels.size >= MAX_CHANNELS) {
      fail(OPEN_FAILURE.RESOURCE_SHORTAGE, "too many channels");
      return;
    }
    if (maxPacket < 128) {
      fail(OPEN_FAILURE.ADMINISTRATIVELY_PROHIBITED, "packet size too small");
      return;
    }
    // Our own ids, not the peer's, so a mismatched-id bug surfaces at once.
    const id = this.nextId++;
    this.channels.set(
      id,
      new Channel(this.host, id, peerId, window, maxPacket),
    );
    this.host.send(
      new Writer(32)
        .u8(MSG.CHANNEL_OPEN_CONFIRMATION)
        .u32(peerId)
        .u32(id)
        .u32(LOCAL_WINDOW)
        .u32(LOCAL_MAX_PACKET)
        .build(),
    );
  }
}
