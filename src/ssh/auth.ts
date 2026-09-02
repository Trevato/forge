/**
 * The `ssh-userauth` service (RFC 4252). `publickey` only: no password, no
 * keyboard-interactive. A client that offers neither gets a FAILURE listing
 * `publickey` and gives up cleanly rather than hanging on a prompt.
 */

import type { Log } from "../kernel/log.ts";
import {
  ACCEPTED_KEY_ALGOS,
  keyAlgorithmMatches,
  publicKeyFromBlob,
  type SshPublicKey,
  verifySshSignature,
} from "./keys.ts";
import { DISCONNECT, MSG, Reader, sshString, Writer } from "./wire.ts";

/** Signature-bearing attempts allowed per connection (OpenSSH's MaxAuthTries). */
const DEFAULT_MAX_ATTEMPTS = 6;
/** Signature-less probes are cheap and a loaded agent makes many of them, so
 *  they get their own, looser cap instead of burning the attempt budget. */
const MAX_QUERIES = 32;

export interface AuthHost {
  send(payload: Uint8Array): void;
  unimplemented(seq: number): void;
  disconnect(reason: number, description: string): void;
  /** H of the first key exchange. Always set by the time auth can run. */
  sessionId(): Uint8Array;
  authorize(key: SshPublicKey, username: string): boolean | Promise<boolean>;
  succeeded(key: SshPublicKey, username: string): void;
  readonly banner: string | undefined;
  readonly maxAttempts: number | undefined;
  readonly log: Log;
}

export class Auth {
  private bannerSent = false;
  private attempts = 0;
  private queries = 0;
  private done = false;

  constructor(private readonly host: AuthHost) {}

  get authenticated(): boolean {
    return this.done;
  }

  /** Handle one pre-auth payload. Throws `WireError` on a malformed packet. */
  async handle(payload: Uint8Array, seq: number): Promise<void> {
    // SAFETY: the transport rejects empty payloads before dispatch.
    const type = payload[0]!;
    if (type === MSG.SERVICE_REQUEST) {
      const r = new Reader(payload);
      r.u8();
      const service = r.text();
      if (service !== "ssh-userauth" && service !== "ssh-connection") {
        this.host.disconnect(
          DISCONNECT.SERVICE_NOT_AVAILABLE,
          `no service ${service}`,
        );
        return;
      }
      // RFC 4253 §10: the accepted service name is echoed back verbatim.
      this.host.send(
        new Writer(64).u8(MSG.SERVICE_ACCEPT).string(service).build(),
      );
      return;
    }
    if (type === MSG.USERAUTH_REQUEST) {
      await this.request(payload);
      return;
    }
    // Channel and global-request traffic before USERAUTH_SUCCESS is illegal.
    if (type >= MSG.GLOBAL_REQUEST) {
      this.host.disconnect(
        DISCONNECT.PROTOCOL_ERROR,
        `message ${type} before authentication`,
      );
      return;
    }
    this.host.unimplemented(seq);
  }

  private sendBanner(): void {
    if (this.bannerSent) return;
    this.bannerSent = true;
    const banner = this.host.banner;
    if (banner === undefined) return;
    // A banner is only legal before USERAUTH_SUCCESS (RFC 4252 §5.4).
    this.host.send(
      new Writer(256)
        .u8(MSG.USERAUTH_BANNER)
        .string(banner.endsWith("\r\n") ? banner : `${banner}\r\n`)
        .string("")
        .build(),
    );
  }

  private failure(): void {
    this.host.send(
      new Writer(32)
        .u8(MSG.USERAUTH_FAILURE)
        .nameList(["publickey"])
        .bool(false)
        .build(),
    );
  }

  private async request(payload: Uint8Array): Promise<void> {
    const r = new Reader(payload);
    r.u8();
    const username = r.text();
    const service = r.text();
    const method = r.text();
    if (service !== "ssh-connection") {
      this.host.disconnect(
        DISCONNECT.SERVICE_NOT_AVAILABLE,
        `no service ${service}`,
      );
      return;
    }
    this.sendBanner();

    if (method !== "publickey") {
      // Includes "none", which OpenSSH always sends first to enumerate the
      // methods we accept. Answering FAILURE is what makes it try its keys.
      this.failure();
      return;
    }

    const signed = r.bool();
    const algo = r.text();
    const keyBlob = r.string().slice();
    // The signature covers the request from byte 0 through the key blob, so
    // remember exactly where that ends before reading the signature itself.
    const signedPrefixEnd = r.offset;

    if (signed) {
      if (++this.attempts > (this.host.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        this.host.disconnect(
          DISCONNECT.NO_MORE_AUTH_METHODS_AVAILABLE,
          "too many authentication attempts",
        );
        return;
      }
    } else if (++this.queries > MAX_QUERIES) {
      this.host.disconnect(
        DISCONNECT.NO_MORE_AUTH_METHODS_AVAILABLE,
        "too many public key probes",
      );
      return;
    }

    if (!(ACCEPTED_KEY_ALGOS as readonly string[]).includes(algo)) {
      this.failure();
      return;
    }
    const parsed = publicKeyFromBlob(keyBlob);
    if (!parsed.ok || !keyAlgorithmMatches(algo, parsed.value.algo)) {
      this.failure();
      return;
    }
    const key = parsed.value;

    let allowed: boolean;
    try {
      allowed = await this.host.authorize(key, username);
    } catch (cause) {
      // The contract says `authorize` must not throw; fail closed if it does.
      this.host.log.error("ssh authorize threw", { error: String(cause) });
      allowed = false;
    }
    if (!allowed) {
      this.failure();
      return;
    }

    if (!signed) {
      r.end();
      // PK_OK is not authentication — it tells the client this key is worth
      // signing with. Echo the algorithm and blob byte-for-byte.
      this.host.send(
        new Writer(512)
          .u8(MSG.USERAUTH_PK_OK)
          .string(algo)
          .string(keyBlob)
          .build(),
      );
      return;
    }

    const signature = r.string();
    r.end();
    // RFC 4252 §7: the signed blob is `string session_id` followed by the
    // whole request up to and including the key blob. Taking the tail from
    // the received bytes rather than re-encoding removes a class of bugs.
    const message = new Writer(payload.length + 64)
      .raw(sshString(this.host.sessionId()))
      .raw(payload.subarray(0, signedPrefixEnd))
      .build();
    const verified = verifySshSignature(algo, keyBlob, signature, message);
    if (!verified.ok) {
      this.host.log.debug("ssh publickey rejected", {
        user: username,
        reason: verified.error,
      });
      this.failure();
      return;
    }

    this.done = true;
    this.host.send(new Uint8Array([MSG.USERAUTH_SUCCESS]));
    this.host.succeeded(key, username);
  }
}
