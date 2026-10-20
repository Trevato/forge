/**
 * The environment git gets whenever it talks to somebody else's server: no
 * redirects, only the transports a remote may use, and — when the host has
 * been vetted — the vetted address pinned, so git's own lookup cannot answer
 * differently from the one that was judged. One function, shared by the
 * migration clone and the mirror fetch.
 */

/** The transports a mirror will speak. */
export const REMOTE_PROTOCOLS = "https:http";

export interface Pin {
  readonly host: string;
  readonly port: number;
  readonly ip: string;
}

/** `host:port` and the vetted address for a clone URL, ready to pin. */
export function pinFor(url: string, ip: string): Pin {
  const parsed = new URL(url);
  const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port, ip };
}

/**
 * `authEnv` plus `http.followRedirects=false`, `GIT_ALLOW_PROTOCOL`, and a
 * `http.curloptResolve` entry when `pin` is given. Config entries are added
 * after any the credential brought, at the next free indexes.
 */
export function remoteGitEnv(
  authEnv: Record<string, string>,
  pin?: Pin,
  protocols: string = REMOTE_PROTOCOLS,
): Record<string, string> {
  const entries: [string, string][] = [["http.followRedirects", "false"]];
  if (pin !== undefined) {
    const ip = pin.ip.includes(":") ? `[${pin.ip}]` : pin.ip;
    entries.push(["http.curloptResolve", `${pin.host}:${pin.port}:${ip}`]);
  }
  const env: Record<string, string> = { ...authEnv, GIT_ALLOW_PROTOCOL: protocols };
  const n = Number(authEnv["GIT_CONFIG_COUNT"] ?? "0");
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${n + i}`] = key;
    env[`GIT_CONFIG_VALUE_${n + i}`] = value;
  });
  env["GIT_CONFIG_COUNT"] = String(n + entries.length);
  return env;
}
