/**
 * Reads the client bytes (gzip JS and CSS) of each first page of a running forge and
 * judges them against docs/design/size-budget.json (#12018):
 *   bun scripts/client-size.ts https://forge.example [cookie]
 * The cookie ("name=value") signs the walk in; signed-out pages are walked without it.
 * Exits 1 naming each page and the bytes over.
 */
import { readFileSync } from "node:fs";
import { clientSize, sizeFindings, type Ceilings } from "../src/measure/client_size.ts";
import { PAGE_BUDGETS, pagePath } from "../src/perf/page_budget.ts";

const [base, cookie] = process.argv.slice(2);
if (base === undefined || !/^https?:\/\//.test(base)) {
  console.error("usage: bun scripts/client-size.ts <https://forge> [cookie]");
  process.exit(2);
}
const ceilings = JSON.parse(readFileSync(new URL("../docs/design/size-budget.json", import.meta.url), "utf8")) as Ceilings;
const get = (path: string, signedIn: boolean): Promise<Response> =>
  fetch(new URL(path, base), { headers: { "accept-encoding": "identity", ...(signedIn && cookie ? { cookie } : {}) } });

const findings: string[] = [];
for (const b of PAGE_BUDGETS) {
  const res = await get(pagePath(b, "alice", "notes"), b.signedOut !== true);
  if (res.status !== 200) {
    findings.push(`${b.pattern} (${b.page}): answered ${res.status}, not 200`);
    continue;
  }
  const size = await clientSize(await res.text(), async (path) => (await get(path, false)).text());
  console.log(`${b.pattern}\tjs ${size.js}\tcss ${size.css}`);
  findings.push(...sizeFindings(`${b.pattern} (${b.page})`, size, ceilings[b.pattern]));
}
for (const f of findings) console.error(f);
process.exit(findings.length === 0 ? 0 : 1);
