/**
 * How an app's label attaches to the domain. A bare domain attaches with a
 * dot: `notes.forge.example`. A value that begins with a separator is the
 * whole attachment: `--forge.example` gives `notes--forge.example`, for a
 * host whose wildcard DNS and certificate cover a single label. One rule
 * builds the hostname and reads it back.
 */
export function appHostSuffix(domain: string): string {
  return /^[a-z0-9]/i.test(domain) ? `.${domain}` : domain;
}
