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

/**
 * Whether `domain` gives a hostname a URL can hold once a slug attaches to
 * it. WHATWG rejects a hostname whose last label is all digits unless the
 * whole host parses as an IPv4 address — which is exactly what attaching a
 * slug to an IP address does: `notes.127.0.0.1` is not a URL, dot or `--`
 * attachment alike.
 */
export function domainHoldsAppHosts(domain: string): boolean {
  try {
    new URL(`http://check${appHostSuffix(domain)}`);
    return true;
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.startsWith("127.");
}

export interface AppDomainInput {
  /** `FORGE_APP_DOMAIN`, trimmed — undefined when the operator set none. */
  readonly explicit: string | undefined;
  /** Whether this forge is itself an app of another (docs/APPS.md). */
  readonly hosted: boolean;
  /** The forge's own public hostname — `publicUrl.hostname`. */
  readonly hostname: string;
}

export type AppDomainResolution =
  | { readonly ok: true; readonly domain: string; readonly note?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * What app hostnames attach to, decided once at boot. `FORGE_APP_DOMAIN`
 * wins outright, unchanged from before this existed. Otherwise the forge's
 * own host is the default — unless it is one a URL cannot hold once a slug
 * attaches, an IP address forge's own hostname most often: a loopback
 * address falls back to `localhost`, which parses and which browsers
 * already resolve to loopback (docs/APPS.md, "Hostnames and the proxy");
 * anything else leaves apps off rather than start ones guaranteed to crash
 * at boot (`FORGE_APP_URL` failing `new URL()` in the scaffold's own
 * `src/env.ts`, and in any app that parses the URL it was handed).
 */
export function resolveAppDomain(input: AppDomainInput): AppDomainResolution {
  const domain =
    input.explicit ?? (input.hosted ? `--${input.hostname}` : input.hostname);
  if (domainHoldsAppHosts(domain)) return { ok: true, domain };
  if (input.explicit === undefined && isLoopbackHost(input.hostname)) {
    return {
      ok: true,
      domain: input.hosted ? "--localhost" : "localhost",
      note:
        `apps: ${input.hostname} is not a hostname a URL can hold once a slug attaches to it; using localhost instead, which browsers resolve to loopback — ` +
        "set FORGE_APP_DOMAIN to serve apps at a real hostname",
    };
  }
  return {
    ok: false,
    reason:
      `apps: ${domain} is not a hostname a URL can hold once a slug attaches to it — apps are off; ` +
      "set FORGE_APP_DOMAIN to a hostname that works",
  };
}
