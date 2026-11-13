/**
 * `serveSsh` — a listening SSH server and the per-connection state machine
 * that ties transport, userauth and channels together.
 *
 * The one rule this file exists to enforce: nothing a peer sends may throw
 * into the event loop. Every socket callback funnels into code that catches,
 * disconnects with a reason code, and keeps the process serving.
 */

import type { Log } from "../kernel/log.ts";
import { Auth } from "./auth.ts";
import { Channels, type SshSession } from "./channels.ts";
import { loadOrCreateHostKey, type SshPublicKey } from "./keys.ts";
import { ConnectionLimits, DEFAULT_LIMITS, type SshLimitValues } from "./limits.ts";
import { Transport } from "./transport.ts";
import { DISCONNECT, WireError } from "./wire.ts";

export type { SshPublicKey } from "./keys.ts";
export type { SshSession } from "./channels.ts";

const DEFAULT_LOGIN_GRACE_MS = 30_000;

export interface SshServerOptions {
  /** 0 for an ephemeral port; read the real one back from `SshServer.port`. */
  port: number;
  /** @default "0.0.0.0" */
  hostname?: string;
  /** `host_ed25519` and `host_ed25519.pub` are created here if absent. */
  hostKeyDir: string;
  /** Optional USERAUTH_BANNER text, shown before success or failure. */
  banner?: string;
  /** @default "SSH-2.0-forge" */
  serverVersion?: string;
  log: Log;
  /**
   * Called for every publickey attempt, including the signature-less query.
   * Return true to accept the key for `username`. Must not throw.
   */
  authorize(key: SshPublicKey, username: string): boolean | Promise<boolean>;
  /** Called once a session channel has received `shell` or `exec`. */
  onSession(session: SshSession): void;
  /** Drop a connection that has not authenticated in this long. @default 30000 */
  loginGraceMs?: number;
  /** Signature-bearing auth attempts allowed per connection. @default 6 */
  maxAuthAttempts?: number;
  /** Caps on connections and handshakes, refused before any key work. @default DEFAULT_LIMITS */
  limits?: Partial<SshLimitValues>;
  /** When the server starts a rekey itself. @default 1 GiB or an hour */
  rekey?: { rekeyBytes?: number; rekeyMs?: number; now?: () => number };
}

export interface SshServer {
  readonly port: number;
  readonly hostKey: SshPublicKey;
  stop(): void;
  /** How many connections are open right now. */
  sessions(): number;
  /**
   * Stop answering new connections and resolve once every open one has
   * ended on its own: a release's old process, letting people finish.
   */
  drain(): Promise<void>;
}

type Socket = Bun.Socket<Connection | undefined>;

class Connection {
  private readonly transport: Transport;
  private readonly auth: Auth;
  private readonly channels: Channels;
  private readonly pending: { payload: Uint8Array; seq: number }[] = [];
  private readonly backlog: Uint8Array[] = [];
  private pumping = false;
  private dead = false;
  private grace: ReturnType<typeof setTimeout> | undefined;

  key: SshPublicKey | undefined;
  username = "";

  constructor(
    private readonly socket: Socket,
    private readonly options: SshServerOptions,
    hostKey: ReturnType<typeof loadOrCreateHostKey>,
    private readonly onGone: (connection: Connection) => void,
  ) {
    const log = options.log;
    const self = this;
    this.transport = new Transport(
      {
        write: (data) => this.writeSocket(data),
        payload: (payload, seq) => {
          this.pending.push({ payload, seq });
          void this.pump();
        },
        closed: (why) => this.shutdown(why),
        log,
      },
      {
        hostKey,
        serverVersion: options.serverVersion ?? "SSH-2.0-forge",
        ...(options.rekey ?? {}),
      },
    );
    this.auth = new Auth({
      send: (payload) => this.transport.send(payload),
      unimplemented: (seq) => this.transport.unimplemented(seq),
      disconnect: (reason, description) =>
        this.transport.disconnect(reason, description),
      sessionId: () => this.transport.sessionId ?? new Uint8Array(0),
      authorize: (key, username) => options.authorize(key, username),
      succeeded: (key, username) => {
        this.key = key;
        this.username = username;
        if (this.grace !== undefined) clearTimeout(this.grace);
        this.grace = undefined;
        log.info("ssh authenticated", {
          user: username,
          key: key.fingerprint,
          peer: this.remoteAddress,
        });
      },
      banner: options.banner,
      maxAttempts: options.maxAuthAttempts,
      log,
    });
    this.channels = new Channels({
      send: (payload) => this.transport.send(payload),
      unimplemented: (seq) => this.transport.unimplemented(seq),
      disconnect: (reason, description) =>
        this.transport.disconnect(reason, description),
      onSession: (session) => options.onSession(session),
      // SAFETY: the channel layer only runs after USERAUTH_SUCCESS, which is
      // the same moment `key`/`username` are set.
      get key(): SshPublicKey {
        return self.key!;
      },
      get username(): string {
        return self.username;
      },
      get remoteAddress(): string {
        return self.remoteAddress;
      },
      log,
    });
  }

  get remoteAddress(): string {
    return this.socket.remoteAddress;
  }

  start(): void {
    this.grace = setTimeout(() => {
      this.transport.disconnect(
        DISCONNECT.CONNECTION_LOST,
        "authentication timed out",
      );
    }, this.options.loginGraceMs ?? DEFAULT_LOGIN_GRACE_MS);
    this.transport.start();
  }

  receive(chunk: Uint8Array): void {
    if (this.dead) return;
    this.transport.receive(chunk);
  }

  /** TCP write with backpressure: Bun may accept only part of a buffer. */
  private writeSocket(data: Uint8Array): void {
    if (this.dead) return;
    if (this.backlog.length > 0) {
      this.backlog.push(data);
      return;
    }
    const written = Math.max(0, this.socket.write(data));
    if (written < data.length) this.backlog.push(data.subarray(written));
  }

  drain(): void {
    while (this.backlog.length > 0) {
      // SAFETY: length > 0 was just checked.
      const head = this.backlog[0]!;
      const written = Math.max(0, this.socket.write(head));
      if (written < head.length) {
        this.backlog[0] = head.subarray(written);
        return;
      }
      this.backlog.shift();
    }
  }

  /**
   * Payloads are processed one at a time through an async pump because
   * `authorize` may be a promise; queueing preserves arrival order, which the
   * protocol requires for pipelined channel requests.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0 && !this.dead) {
        // SAFETY: length > 0 was just checked.
        const item = this.pending.shift()!;
        try {
          if (this.auth.authenticated) {
            this.channels.handle(item.payload, item.seq);
          } else {
            await this.auth.handle(item.payload, item.seq);
          }
        } catch (cause) {
          if (cause instanceof WireError) {
            this.transport.disconnect(DISCONNECT.PROTOCOL_ERROR, cause.message);
          } else {
            this.options.log.error("ssh connection fault", {
              error: String(cause),
              peer: this.remoteAddress,
            });
            this.transport.disconnect(
              DISCONNECT.PROTOCOL_ERROR,
              "internal error",
            );
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Called by the transport when it is finished, and by the socket handlers. */
  shutdown(why: string): void {
    if (this.dead) return;
    this.dead = true;
    if (this.grace !== undefined) clearTimeout(this.grace);
    this.grace = undefined;
    this.pending.length = 0;
    this.channels.shutdown();
    this.options.log.debug("ssh connection closed", {
      peer: this.remoteAddress,
      why,
    });
    this.onGone(this);
    try {
      this.socket.end();
    } catch {
      // Already gone.
    }
  }

  /** The socket vanished under us; no point writing a DISCONNECT. */
  socketClosed(): void {
    this.shutdown("socket closed");
  }

  close(): void {
    this.transport.disconnect(
      DISCONNECT.BY_APPLICATION,
      "server shutting down",
    );
  }
}

export function serveSsh(options: SshServerOptions): Promise<SshServer> {
  const hostKey = loadOrCreateHostKey(options.hostKeyDir);
  const connections = new Set<Connection>();
  const limits = new ConnectionLimits({ ...DEFAULT_LIMITS, ...options.limits });
  // Whoever is waiting for the last connection to leave, once draining.
  const drained: (() => void)[] = [];
  const drop = (connection: Connection) => {
    connections.delete(connection);
    if (connections.size === 0) for (const done of drained.splice(0)) done();
  };

  const listener = Bun.listen<Connection | undefined>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port,
    socket: {
      open(socket) {
        // Before a Connection exists, so a refused peer costs no key work.
        // `remoteAddress` is the TCP peer: a proxy's, if one fronts this port.
        const verdict = limits.admit(socket.remoteAddress, Date.now());
        if ("refused" in verdict) {
          options.log.debug("ssh refused", { peer: socket.remoteAddress, why: verdict.refused });
          socket.end(`${verdict.refused}\r\n`);
          return;
        }
        const connection = new Connection(socket, options, hostKey, (gone) => {
          limits.release(verdict.key);
          drop(gone);
        });
        socket.data = connection;
        connections.add(connection);
        connection.start();
      },
      data(socket, chunk) {
        socket.data?.receive(chunk);
      },
      drain(socket) {
        socket.data?.drain();
      },
      close(socket) {
        socket.data?.socketClosed();
      },
      error(socket, error) {
        options.log.debug("ssh socket error", { error: String(error) });
        socket.data?.socketClosed();
      },
    },
  });

  options.log.info("ssh listening", {
    port: listener.port,
    key: hostKey.publicKey.fingerprint,
  });

  return Promise.resolve({
    port: listener.port,
    hostKey: hostKey.publicKey,
    sessions: () => connections.size,
    drain(): Promise<void> {
      // Nothing new is answered; whoever is connected keeps their session
      // until they end it, and this resolves when the last one has.
      listener.stop(false);
      if (connections.size === 0) return Promise.resolve();
      return new Promise((resolve) => drained.push(resolve));
    },
    stop(): void {
      for (const connection of [...connections]) connection.close();
      listener.stop(true);
    },
  });
}
