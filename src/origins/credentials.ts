/**
 * How a token reaches git, and how it never comes back out.
 *
 * `git` is a subprocess, and a subprocess has exactly three places a secret
 * can leak: argv (world-readable in `ps` and `/proc/<pid>/cmdline`), a config
 * file on disk, and a URL that ends up in `remote.origin.url`, the reflog, or
 * an error message. `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (git ≥ 2.31) is the
 * only mechanism that avoids all three: the config exists for one process,
 * in its environment, which is readable by its owner and root alone.
 *
 * Two details are load-bearing. The header is scoped to the origin's URL, so
 * a redirect cannot carry our credential to another host; and redirects are
 * switched off outright as the second belt. Both are cheap, and a leaked
 * Authorization header is the kind of mistake you only get to make once.
 */

/** `Basic <base64(user:secret)>` — git's credential machinery is bypassed by
 * `http.extraHeader`, so the encoding is ours to do. */
export const basicHeader = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

/**
 * Env that authenticates exactly one git invocation against one host.
 * `scopeUrl` is the origin the credential belongs to (`https://github.com`);
 * the header is attached to that URL prefix and nothing else.
 */
export function gitAuthEnv(
  scopeUrl: string,
  header: string,
): Record<string, string> {
  let scope: string;
  try {
    const url = new URL(scopeUrl);
    scope = `${url.protocol}//${url.host}/`;
  } catch {
    // A credential we cannot scope is a credential we do not send.
    return {};
  }
  return {
    GIT_CONFIG_COUNT: "3",
    // `http.extraHeader` takes a whole header line, name included — git adds
    // nothing of its own here, which is also why we base64 the credential
    // ourselves rather than letting the credential machinery do it.
    GIT_CONFIG_KEY_0: `http.${scope}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${header}`,
    // A redirect off-host must not carry the header, belt and braces.
    GIT_CONFIG_KEY_1: "http.followRedirects",
    GIT_CONFIG_VALUE_1: "false",
    // Helper values are a list; an empty one clears anything inherited.
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
  };
}

/**
 * Scrub anything that might carry a credential out of git's stderr before it
 * reaches a log line, an event payload, or a pusher's terminal. Two hazards:
 * git echoes URLs on failure (and a URL may carry userinfo), and a token we
 * hold could appear verbatim if a remote quotes it back.
 */
export function redact(text: string, ...secrets: string[]): string {
  let out = text.replace(/:\/\/[^/@\s]*@/g, "://");
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(
    /\b(Authorization|Basic|Bearer|token)\s+\S{16,}/gi,
    "$1 [redacted]",
  );
}

/**
 * An http(s) URL we are willing to hand to git as a remote. Anything else —
 * a `-`-leading string that would become a flag, an `ext::`/`file://` URL
 * that would run a command or read the disk — is refused (invariant 8).
 */
export function safeRemoteUrl(url: string): string | undefined {
  if (url.startsWith("-") || /[\s\x00-\x1f]/.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    // Userinfo in a mirror URL is exactly the plaintext-on-disk mistake this
    // whole module exists to avoid; the credential rides in the env instead.
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * The secret material a git auth env carries, in every form it could be
 * echoed back by a remote: the base64 `Basic` blob and the plaintext token
 * inside it. Feed these to `redact` wherever a remote's words reach a user.
 */
export function secretsIn(authEnv: Record<string, string>): string[] {
  const secrets: string[] = [];
  for (const value of Object.values(authEnv)) {
    const match = /^Authorization:\s*Basic\s+(\S+)$/i.exec(value);
    const blob = match?.[1];
    if (blob === undefined) continue;
    secrets.push(blob);
    const decoded = Buffer.from(blob, "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon >= 0) secrets.push(decoded.slice(colon + 1));
  }
  return secrets;
}
