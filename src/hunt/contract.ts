/**
 * Contract: no documented GET route answers 500 to an anonymous caller, and
 * what it answers is a status its OpenAPI entry documents (or a refusal).
 */

import { found, seenLine, type Finding } from "./finding.ts";
import type { Probe } from "./probe.ts";

const REFUSALS = new Set(["401", "403", "404", "429"]);

interface Doc {
  paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
}

export async function contract(p: Probe): Promise<Finding[]> {
  const out: Finding[] = [];
  const doc = await p.get("/contract/openapi.json");
  let parsed: Doc;
  try {
    parsed = JSON.parse(doc.body) as Doc;
  } catch {
    return [found("contract.openapi", "/contract/openapi.json", "the OpenAPI document is not JSON", seenLine("/contract/openapi.json", doc.status))];
  }
  for (const [path, ops] of Object.entries(parsed.paths ?? {})) {
    const get = ops.get;
    if (get === undefined || /[{}]/.test(path)) continue;
    const r = await p.get(path);
    if (r.status === 0 || r.status >= 500) out.push(found("contract.no-500", path, `${path} answers ${r.status}`, seenLine(path, r.status)));
    else if (get.responses && Object.keys(get.responses).length > 0) {
      const code = String(r.status);
      if (!(code in get.responses) && !REFUSALS.has(code) && !("default" in get.responses))
        out.push(found("contract.documented", path, `${path} answers ${r.status}, which its entry does not document`, `${seenLine(path, r.status)}; documented: ${Object.keys(get.responses).join(", ")}`));
    }
  }
  return out;
}
