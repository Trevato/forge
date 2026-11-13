/**
 * What a test of a hosted forge's way out needs: a certificate for a name,
 * a git server that speaks smart HTTP over TLS, and a stand-in for the
 * parent's gate (a CONNECT proxy) that can be told what to allow.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { gitClientEnv } from "./git-client.ts";

/** A throwaway self-signed certificate for `name`, made with openssl so no key is committed (RSA: LibreSSL's EC keys are ones Bun cannot read). */
export function selfSigned(
  name: string,
): { cert: string; key: string; certFile: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "forge-cert-"));
  const run = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(dir, "k.pem"),
    "-out",
    join(dir, "c.pem"),
    "-days",
    "2",
    "-subj",
    `/CN=${name}`,
    "-addext",
    `subjectAltName=DNS:${name}`,
  ]);
  if (run.exitCode !== 0) return undefined;
  return {
    cert: readFileSync(join(dir, "c.pem"), "utf8"),
    key: readFileSync(join(dir, "k.pem"), "utf8"),
    certFile: join(dir, "c.pem"),
  };
}

/** A bare repository with one commit on `main`; its path. */
export function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-gate-git-"));
  const bare = join(dir, "r.git");
  const work = join(dir, "w");
  mkdirSync(work);
  const git = (cwd: string, ...args: string[]): void => {
    const run = Bun.spawnSync(["git", ...args], { cwd, env: gitClientEnv() });
    if (run.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  };
  git(dir, "init", "--bare", "-b", "main", bare);
  git(work, "init", "-b", "main");
  writeFileSync(join(work, "hello.txt"), "hello\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "first");
  git(work, "push", bare, "main");
  return bare;
}

const pkt = (text: string): Uint8Array =>
  new TextEncoder().encode(
    `${(text.length + 4).toString(16).padStart(4, "0")}${text}`,
  );

/**
 * `repo` over smart HTTP, on TLS: enough for `ls-remote` and `fetch`. Listens
 * on every address (`::`), so a name that resolves to either loopback reaches it.
 */
export function serveGit(
  repo: string,
  pair: { cert: string; key: string },
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "::",
    port: 0,
    tls: { cert: pair.cert, key: pair.key },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/hello") return new Response("hello over tls");
      if (
        url.pathname.endsWith("/info/refs") &&
        url.searchParams.get("service") === "git-upload-pack"
      ) {
        const proc = Bun.spawn(
          ["git", "upload-pack", "--stateless-rpc", "--advertise-refs", repo],
          { stdout: "pipe", env: gitClientEnv() },
        );
        const refs = new Uint8Array(
          await new Response(proc.stdout).arrayBuffer(),
        );
        const head = pkt("# service=git-upload-pack\n");
        const flush = new TextEncoder().encode("0000");
        return new Response(Buffer.concat([head, flush, refs]), {
          headers: {
            "content-type": "application/x-git-upload-pack-advertisement",
            "cache-control": "no-cache",
          },
        });
      }
      if (
        request.method === "POST" &&
        url.pathname.endsWith("/git-upload-pack")
      ) {
        const raw = new Uint8Array(await request.arrayBuffer());
        const body =
          request.headers.get("content-encoding") === "gzip"
            ? gunzipSync(raw)
            : raw;
        const proc = Bun.spawn(
          ["git", "upload-pack", "--stateless-rpc", repo],
          { stdin: new Blob([body]), stdout: "pipe", env: gitClientEnv() },
        );
        const out = new Uint8Array(
          await new Response(proc.stdout).arrayBuffer(),
        );
        return new Response(out, {
          headers: {
            "content-type": "application/x-git-upload-pack-result",
            "cache-control": "no-cache",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

/** What a stand-in gate does with one `CONNECT`: tunnel it to a local port, or answer with this status and sentence. */
export type GateRule = { tunnelTo: number } | { status: number; why: string };

export interface FakeGate {
  /** `http://127.0.0.1:<port>`: what goes in `HTTPS_PROXY`. */
  readonly url: string;
  readonly port: number;
  /** Every `host:port` that was asked for, in order. */
  readonly connects: string[];
  stop(): void;
}

/**
 * The parent's gate, reduced to what a test can see: it is asked for a
 * destination by name, and it either opens a tunnel to a local server or
 * refuses the way the real one does (`apps/egress.ts`, `X-Forge-Egress: refused`).
 * The names it is asked for resolve nowhere, so a client that looks one up
 * itself, or dials an address, never gets through.
 */
export function fakeGate(
  rule: (host: string, port: number) => GateRule,
): FakeGate {
  const connects: string[] = [];
  const decoder = new TextDecoder();
  const server = Bun.listen<{
    peer?: import("bun").Socket<undefined>;
    head: string;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { head: "" };
      },
      data(socket, chunk) {
        if (socket.data.peer !== undefined) {
          socket.data.peer.write(chunk);
          return;
        }
        socket.data.head += decoder.decode(chunk);
        if (!socket.data.head.includes("\r\n\r\n")) return;
        const target = socket.data.head.split(" ")[1] ?? "";
        connects.push(target);
        const at = target.lastIndexOf(":");
        const decided = rule(target.slice(0, at), Number(target.slice(at + 1)));
        if ("status" in decided) {
          socket.end(
            `HTTP/1.1 ${decided.status} Refused\r\nX-Forge-Egress: refused\r\nContent-Length: ${decided.why.length + 1}\r\n\r\n${decided.why}\n`,
          );
          return;
        }
        const rest = socket.data.head.slice(
          socket.data.head.indexOf("\r\n\r\n") + 4,
        );
        void Bun.connect<undefined>({
          hostname: "127.0.0.1",
          port: decided.tunnelTo,
          socket: {
            data(peer, got) {
              socket.write(got);
            },
            close() {
              socket.end();
            },
            error() {
              socket.end();
            },
          },
        }).then((peer) => {
          socket.data.peer = peer;
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest !== "") peer.write(rest);
        });
      },
      close(socket) {
        socket.data.peer?.end();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    connects,
    stop: () => server.stop(true),
  };
}
