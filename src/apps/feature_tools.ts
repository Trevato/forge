/**
 * The MCP tools an app declares as part of its `feature`:
 *
 *   "feature": { "name": "Radar", "tools": {
 *     "scan": { "description": "Run a scan now", "writes": true },
 *     "latest": { "description": "The last findings", "writes": false } } }
 *
 * The forge lists them under the `features` MCP tool and, for an absorbed app,
 * calls one by POSTing `{ args }` to the app's `/forge/tools/<name>` over
 * loopback. The app's code stays in its cell; what it answers is data, bounded
 * in size and time. No tool is added to `/mcp` itself, so the manifest does not grow.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** Whether a call changes anything: a write plans first, like the forge's own. */
  readonly writes: boolean;
}

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const TOOLS_MAX = 12;
const DESCRIPTION_MAX = 200;
export const ANSWER_MAX = 64 * 1024;
const WAIT_MS = 10_000;

/** The `tools` of a feature block; an error names the tool. */
export function parseTools(raw: unknown): Result<readonly ToolSpec[], string> {
  if (raw === undefined) return ok([]);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return err("feature: tools must be an object of name → tool");
  const names = Object.keys(raw);
  if (names.length > TOOLS_MAX) return err(`feature: at most ${TOOLS_MAX} tools`);
  const out: ToolSpec[] = [];
  for (const name of names) {
    const t = (raw as Record<string, unknown>)[name];
    if (!NAME.test(name)) return err(`feature: tool ${JSON.stringify(name)}: names are lowercase words with _, at most 40 characters`);
    if (typeof t !== "object" || t === null || Array.isArray(t)) return err(`feature: tool ${name} must be an object`);
    const { description, writes, ...extra } = t as Record<string, unknown>;
    if (typeof description !== "string" || description.trim() === "" || description.length > DESCRIPTION_MAX)
      return err(`feature: tool ${name}: description is text of 1 to ${DESCRIPTION_MAX} characters`);
    if (writes !== undefined && typeof writes !== "boolean") return err(`feature: tool ${name}: writes is true or false`);
    if (Object.keys(extra).length > 0) return err(`feature: tool ${name}: unknown field ${Object.keys(extra)[0]}`);
    out.push({ name, description: description.trim(), writes: writes !== false });
  }
  return ok(out);
}

/** Call a declared tool on the app listening on `port`: its JSON answer, or why not. */
export async function callTool(port: number, tool: string, args: Record<string, unknown>): Promise<Result<unknown, string>> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/forge/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ args }),
      redirect: "manual",
      signal: AbortSignal.timeout(WAIT_MS),
    });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > ANSWER_MAX) {
        await reader.cancel();
        return err("the app's answer is over 64 KB");
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (res.status !== 200) return err(`the app answered ${res.status}`);
    try {
      return ok(JSON.parse(text));
    } catch {
      return err("the app's answer is not JSON");
    }
  } catch {
    return err("the app did not answer");
  }
}
