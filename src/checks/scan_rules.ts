/**
 * Code scanning's rules (#9593), pure: a file's path and text in, findings
 * out. Three kinds: `secret` (a credential committed in plain text),
 * `advisory` (a package.json pin a known advisory names) and `static` (a
 * pattern that turns text into code). A finding never carries the matched
 * text: the secret is hashed into the fingerprint and dropped, so a page,
 * a log or a comment that prints a finding cannot print the secret.
 */

import { createHash } from "node:crypto";

export type ScanKind = "secret" | "advisory" | "static";
export type Severity = "high" | "medium";

export interface Finding {
  readonly kind: ScanKind;
  readonly severity: Severity;
  /** The rule's name, as a reader reads it: "AWS access key", "lodash < 4.17.21". */
  readonly rule: string;
  readonly path: string;
  /** 1-based line, 0 when the finding is about the whole file. */
  readonly line: number;
  /** Stable across pushes for the same thing in the same file: rule, path and a hash of the match. */
  readonly fingerprint: string;
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);

const SECRETS: readonly { rule: string; re: RegExp }[] = [
  { rule: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { rule: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "Stripe live key", re: /\b[sr]k_live_[0-9A-Za-z]{24,}\b/g },
  { rule: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
];

/** Lines of `text` with their 1-based numbers; a file with a NUL is binary and has none. */
function lines(text: string): string[] {
  return text.includes("\0") ? [] : text.split("\n");
}

/** Tests and fixtures quote fake credentials on purpose: what they hold is still shown, as medium, and holds nothing. */
export const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures?)\/|\.test\.[cm]?[jt]sx?$/;

export function secretFindings(path: string, text: string): Finding[] {
  const severity: Severity = TEST_PATH.test(path) ? "medium" : "high";
  const out: Finding[] = [];
  lines(text).forEach((l, i) => {
    for (const { rule, re } of SECRETS) {
      for (const m of l.matchAll(re)) {
        out.push({ kind: "secret", severity, rule, path, line: i + 1, fingerprint: hash(`secret\0${rule}\0${path}\0${m[0]}`) });
      }
    }
  });
  return out;
}

/** Known advisories, kept here and read without the network: a package, the first fixed version, and its severity. */
export const ADVISORIES: readonly { name: string; fixed: string; severity: Severity; id: string }[] = [
  { name: "lodash", fixed: "4.17.21", severity: "high", id: "GHSA-35jh-r3h4-6jhm" },
  { name: "minimist", fixed: "1.2.6", severity: "high", id: "GHSA-xvch-5gv4-984h" },
  { name: "node-fetch", fixed: "2.6.7", severity: "high", id: "GHSA-r683-j2x4-v87g" },
  { name: "jsonwebtoken", fixed: "9.0.0", severity: "high", id: "GHSA-27h2-hvpr-p74q" },
  { name: "semver", fixed: "7.5.2", severity: "medium", id: "GHSA-c2qf-rxjj-qqgw" },
  { name: "axios", fixed: "1.6.0", severity: "medium", id: "GHSA-wf5p-g6vw-rhxx" },
  { name: "ws", fixed: "8.17.1", severity: "high", id: "GHSA-3h5v-q93c-6h6q" },
  { name: "tar", fixed: "6.2.1", severity: "medium", id: "GHSA-f5x3-32g6-xq36" },
];

/** `a < b` for dotted numeric versions; anything that is not one compares as not less. */
export function versionBelow(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some((n) => !Number.isInteger(n)) || pb.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The lowest version a range admits, when it says one plainly (`1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`). */
function floorOf(range: string): string | undefined {
  const m = /^\s*(?:\^|~|>=|=|v)?\s*(\d+(?:\.\d+){0,2})(?:[-+][0-9A-Za-z.-]*)?\s*$/.exec(range);
  return m?.[1];
}

export function advisoryFindings(path: string, text: string): Finding[] {
  if (path !== "package.json" && !path.endsWith("/package.json")) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof pkg !== "object" || pkg === null) return [];
  const out: Finding[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const deps = (pkg as Record<string, unknown>)[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range !== "string") continue;
      const floor = floorOf(range);
      if (floor === undefined) continue;
      for (const a of ADVISORIES) {
        if (a.name !== name || !versionBelow(floor, a.fixed)) continue;
        const rule = `${name} < ${a.fixed} (${a.id})`;
        out.push({ kind: "advisory", severity: a.severity, rule, path, line: 0, fingerprint: hash(`advisory\0${a.id}\0${path}`) });
      }
    }
  }
  return out;
}

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const STATIC: readonly { rule: string; re: RegExp }[] = [
  { rule: "eval of a value", re: /(?<![\w.$"'`])eval\s*\(/ },
  { rule: "new Function from text", re: /\bnew\s+Function\s*\(/ },
  { rule: "shell command built from a template", re: /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/ },
  { rule: "HTML written from a value", re: /\.(?:innerHTML|outerHTML)\s*=(?!=)/ },
];

/** Static analysis for the nightly pass: source files only, tests left out (they quote these patterns on purpose). Medium: a reader judges it, no release waits. */
export function staticFindings(path: string, text: string): Finding[] {
  if (!CODE.test(path) || /(?:^|\/)(?:test|tests|__tests__|vendor|node_modules)\//.test(path) || /\.test\.[jt]sx?$/.test(path)) return [];
  const out: Finding[] = [];
  lines(text).forEach((l, i) => {
    const code = l.trimStart();
    if (code.startsWith("//") || code.startsWith("*")) return;
    for (const { rule, re } of STATIC) {
      if (re.test(l)) out.push({ kind: "static", severity: "medium", rule, path, line: i + 1, fingerprint: hash(`static\0${rule}\0${path}\0${l.trim()}`) });
    }
  });
  return out;
}
