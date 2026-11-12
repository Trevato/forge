/**
 * What certificate a name is served with, and when it ends. The proxy issues
 * it on the first request and renews it on its own, so a renewal that fails
 * is silent until the day it expires. A check asks the name over TLS and says
 * the expiry in a sentence; a name that cannot be asked says why.
 */

import { connect } from "node:tls";
import { vetHost, type OutboundOptions } from "../kernel/outbound.ts";

/** The expiry of the certificate served at a host, or why there is none. */
export type CertificateProbe = (
  host: string,
) => Promise<{ expires: Date } | { error: string }>;

const WARN_DAYS = 14;
const DAY_MS = 86_400_000;

/** Where to dial and how to resolve; tests point these at a local port. */
export interface ProbeOptions extends OutboundOptions {
  readonly port?: number;
}

/**
 * Ask `host:443` for its certificate. The name is resolved and judged first
 * (`vetHost`: loopback, private and link-local answers are refused), then the
 * connection goes to the address that was judged, with the name as the TLS
 * server name, so a rebind between the check and the connect changes nothing.
 * Never throws; gives up after 5 seconds.
 */
export async function probeCertificate(
  host: string,
  options: ProbeOptions = {},
): Promise<{ expires: Date } | { error: string }> {
  const vetted = await vetHost(host, options);
  if (!vetted.ok)
    return {
      error:
        vetted.error === "refused"
          ? "it resolves to a private address"
          : "it does not resolve",
    };
  const address = vetted.value[0]!;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { expires: Date } | { error: string }) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    // rejectUnauthorized stays off only to read an expired certificate's date;
    // nothing is sent over this connection.
    const socket = connect(
      {
        host: address,
        port: options.port ?? 443,
        servername: host,
        rejectUnauthorized: false,
        timeout: 5000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const end = cert?.valid_to ? new Date(cert.valid_to) : undefined;
        finish(
          end && !Number.isNaN(end.getTime())
            ? { expires: end }
            : { error: "it presented no certificate" },
        );
      },
    );
    socket.on("timeout", () => finish({ error: "it did not answer on port 443" }));
    socket.on("error", () => finish({ error: "it could not be reached on port 443" }));
  });
}

/** The probe's answer as one sentence, measured from `now`. */
export function certificateSaid(
  found: { expires: Date } | { error: string },
  now: Date,
): string {
  if ("error" in found)
    return `Certificate: not read — ${found.error}. The proxy issues it on the first https request.`;
  const day = found.expires.toISOString().slice(0, 10);
  const left = Math.floor((found.expires.getTime() - now.getTime()) / DAY_MS);
  if (left < 0) return `Certificate expired on ${day}: renewal has failed.`;
  if (left <= WARN_DAYS)
    return `Certificate expires on ${day} (${left} day${left === 1 ? "" : "s"}): it expires soon.`;
  return `Certificate valid until ${day}.`;
}
