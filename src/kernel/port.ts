/**
 * A loopback port for a child that binds it later, and the retry for when
 * another process takes it in between. Imports nothing: `release/boot.ts`
 * must run when the rest of the tree is what is broken.
 */

/** How many more times a child that lost its port is started on a fresh one. */
export const PORT_RETRIES = 2;
const ADDRESS_IN_USE_RE = /address (?:already )?in use|EADDRINUSE|port \d+ in use/i;

/** A port the OS says is free right now. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

/** Whether a child's output says it could not bind its port. */
export function lostPort(output: string): boolean {
  return ADDRESS_IN_USE_RE.test(output);
}

/** Run `attempt` on a free port; while it reports the port lost, on a fresh one, up to PORT_RETRIES more times. */
export async function onFreshPort<T>(
  attempt: (port: number) => Promise<{ readonly result: T; readonly portLost: boolean }>,
): Promise<T> {
  let run = await attempt(await freePort());
  for (let retry = 0; retry < PORT_RETRIES && run.portLost; retry++) run = await attempt(await freePort());
  return run.result;
}
