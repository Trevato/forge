/**
 * `bun scripts/hunt.ts <https-origin>`: run the hunters' detectors (GET only)
 * against one app and print the findings as JSON. Exit 1 when there are any.
 * Never run on a person's machine in a loop: it is one pass, then it ends.
 */

import { huntTarget } from "../src/hunt/hunt.ts";

const target = process.argv[2];
if (!target || !/^https?:\/\//.test(target)) {
  console.error("usage: bun scripts/hunt.ts <origin>");
  process.exit(2);
}
const report = await huntTarget(target.replace(/\/$/, ""));
console.log(JSON.stringify(report, null, 2));
process.exit(report.findings.length === 0 ? 0 : 1);
