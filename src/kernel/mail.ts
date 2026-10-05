/**
 * Mail out, by the open standard: SMTP submission (RFC 6409) over implicit
 * TLS (`smtps://user:pass@host:465`), so any provider works and nothing is
 * added to `dependencies`. Plain `smtp://` is accepted only for this machine
 * (a local relay, or a test's stand-in server).
 *
 * One message, one connection, no queue: a send that fails returns false and
 * the caller decides (a verification link can be sent again). The URL holds
 * a password and is never logged; neither is a message's body, which may
 * carry a one-time link.
 */

import { checkServerIdentity, type PeerCertificate } from "node:tls";

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailConfig {
  /** `smtps://user:pass@host:465`, or `smtp://…` on this machine only. */
  readonly url: string;
  /** The envelope and header sender, e.g. `forge@example.com`. */
  readonly from: string;
  /**
   * PEM roots to trust instead of the system's — a private relay with its
   * own CA. The certificate must still verify and name the host.
   */
  readonly ca?: string;
}

/** What the forge hands a message to: SMTP in production, a capture in tests. */
export type Mailer = (mail: Mail) => Promise<boolean>;

const TIMEOUT_MS = 15_000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** An address fit for an envelope and a header: one line, one `@`, no brackets. */
const ADDRESS = /^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+$/;
const ONE_LINE = /^[^\r\n]*$/;

export async function sendMail(
  config: MailConfig,
  mail: Mail,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return false;
  }
  const tls = url.protocol === "smtps:";
  if (!tls && !(url.protocol === "smtp:" && LOOPBACK.has(url.hostname)))
    return false;
  if (!ADDRESS.test(mail.to) || !ADDRESS.test(config.from)) return false;
  if (!ONE_LINE.test(mail.subject)) return false;
  const port = Number(url.port || (tls ? 465 : 25));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);

  const message = [
    `From: ${config.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${config.from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...mail.text.replace(/\r\n/g, "\n").split("\n"),
  ]
    // Dot-stuffing (RFC 5321 §4.5.2): a line starting with "." gets another.
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");

  const steps: { send?: string; expect: number }[] = [
    { expect: 220 },
    { send: `EHLO ${config.from.split("@")[1]}`, expect: 250 },
    ...(user !== ""
      ? [
          {
            send: `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString("base64")}`,
            expect: 235,
          },
        ]
      : []),
    { send: `MAIL FROM:<${config.from}>`, expect: 250 },
    { send: `RCPT TO:<${mail.to}>`, expect: 250 },
    { send: "DATA", expect: 354 },
    { send: `${message}\r\n.`, expect: 250 },
    { send: "QUIT", expect: 221 },
  ];

  return await new Promise<boolean>((resolve) => {
    let buffer = "";
    let step = 0;
    let done = false;
    const finish = (ok: boolean, socket?: { end(): void }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.end();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), TIMEOUT_MS);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // Nothing is said to a TLS peer until its certificate has verified and
    // names the host: Bun completes a handshake with a bad certificate
    // unless told otherwise, so the handshake is judged here, and replies
    // that arrive before it are held, not answered.
    let trusted = !tls;
    const advance = (socket: { write(data: string): unknown; end(): void }): void => {
      // A reply is complete at a line whose code is followed by a space;
      // "250-" lines are a multi-line reply's continuation.
      for (;;) {
        const lines = buffer.split("\r\n");
        const last = lines.findIndex(
          (l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l),
        );
        if (last === -1) return;
        const code = Number(lines[last]!.slice(0, 3));
        buffer = lines.slice(last + 1).join("\r\n");
        const expected = steps[step]!.expect;
        if (code !== expected) return finish(false, socket);
        step += 1;
        if (step === steps.length) return finish(true, socket);
        socket.write(`${steps[step]!.send}\r\n`);
      }
    };
    Bun.connect({
      hostname: host,
      port,
      ...(tls
        ? {
            tls: {
              serverName: host,
              rejectUnauthorized: true,
              ...(config.ca === undefined ? {} : { ca: config.ca }),
            },
          }
        : {}),
      socket: {
        handshake(socket, success, authorizationError) {
          if (!success || authorizationError) return finish(false, socket);
          const named = checkServerIdentity(
            host,
            socket.getPeerCertificate() as PeerCertificate,
          );
          if (named !== undefined) return finish(false, socket);
          trusted = true;
          advance(socket);
        },
        data(socket, chunk) {
          buffer += new TextDecoder().decode(chunk);
          if (trusted) advance(socket);
        },

        error() {
          finish(false);
        },
        close() {
          finish(step === steps.length);
        },
        connectError() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}
