/**
 * Where the forge's internal listener answers: a unix socket path, or
 * `tcp:<host>:<port>` on loopback. Production uses the socket. A sandbox
 * that refuses the bind (an agent running `bun test`) sets
 * `FORGE_TEST_SOCKET=port` and the listener takes a loopback port instead,
 * so no unix socket is ever exposed to the sandbox to get there.
 */

const TCP = /^tcp:(127\.0\.0\.1):([0-9]{1,5})$/;

/** The address of a loopback listener. */
export function tcpAddress(port: number): string {
  return `tcp:127.0.0.1:${port}`;
}

/** Whether the environment asks for a loopback port in place of a unix socket. */
export function portInsteadOfSocket(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env["FORGE_TEST_SOCKET"] === "port";
}

/** The URL and fetch option that reach `path` at `address`. */
export function internalRequest(
  address: string,
  path: string,
): { url: string; init: { unix?: string } } {
  const tcp = TCP.exec(address);
  if (tcp !== null)
    return { url: `http://${tcp[1]}:${tcp[2]}${path}`, init: {} };
  return { url: `http://forge${path}`, init: { unix: address } };
}

/** `fetch` against the internal listener, wherever it is. */
export function fetchInternal(
  address: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const target = internalRequest(address, path);
  return fetch(target.url, { ...init, ...target.init } as RequestInit);
}
