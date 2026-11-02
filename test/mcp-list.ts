/** `tools/list` is paged: these walk `nextCursor` so a test sees every tool. */

/** Every page of `send({ cursor })`, merged into one answer shaped like a page. */
export async function listVia(
  send: (params: { cursor?: string }) => Promise<any>,
): Promise<{ result: { tools: any[] } }> {
  const tools: any[] = [];
  let params: { cursor?: string } = {};
  for (;;) {
    const page = await send(params);
    if (page.error) throw new Error(`tools/list: ${page.error.message}`);
    tools.push(...page.result.tools);
    if (typeof page.result.nextCursor !== "string") return { result: { tools } };
    params = { cursor: page.result.nextCursor };
  }
}

/** Every tool the bearer `token` is listed at `url` (the forge's origin). */
export function listAt(url: string, token: string): Promise<{ result: { tools: any[] } }> {
  return listVia(async (params) =>
    (
      await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params }),
      })
    ).json(),
  );
}
