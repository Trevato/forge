/**
 * Where a check's commands run: `process` (the default, a cell on the
 * forge's own machine) or `job` (a Kubernetes Job, through
 * `cluster/jobs.ts`). Read from the forge's environment once, validated at
 * this boundary; anything malformed leaves the default in place.
 *   FORGE_CHECKS_PLACEMENT      process | job
 *   FORGE_CHECKS_IMAGE          the Job's image
 *   FORGE_CHECKS_CLAIM          a ReadWriteMany claim holding the checks root
 *   FORGE_CHECKS_NODE_SELECTOR  key=value,key=value
 *   FORGE_CHECKS_TOLERATIONS    a JSON list of tolerations
 */
import type { Toleration } from "../cluster/jobs.ts";

export type Placement =
  | { readonly mode: "process" }
  | {
      readonly mode: "job";
      readonly image: string;
      readonly claim: string;
      readonly nodeSelector: Record<string, string>;
      readonly tolerations: Toleration[];
    };

const LABEL = /^[A-Za-z0-9]([-A-Za-z0-9_./]{0,61}[A-Za-z0-9])?$/;
const EFFECTS = ["NoSchedule", "PreferNoSchedule", "NoExecute"];

export function parseSelector(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of text.split(",").filter((p) => p.trim() !== "")) {
    const at = pair.indexOf("=");
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (at < 1 || !LABEL.test(key) || !(value === "" || LABEL.test(value))) return undefined;
    out[key] = value;
  }
  return out;
}

export function parseTolerations(text: string): Toleration[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list) || list.length > 20) return undefined;
  const out: Toleration[] = [];
  for (const t of list as Record<string, unknown>[]) {
    if (typeof t !== "object" || t === null) return undefined;
    const str = (k: string) => (typeof t[k] === "string" ? (t[k] as string) : undefined);
    const key = str("key");
    const operator = str("operator");
    const value = str("value");
    const effect = str("effect");
    if (operator !== undefined && operator !== "Exists" && operator !== "Equal") return undefined;
    if (effect !== undefined && !EFFECTS.includes(effect)) return undefined;
    if ((key !== undefined && !LABEL.test(key)) || (value !== undefined && !(value === "" || LABEL.test(value))))
      return undefined;
    out.push({
      ...(key === undefined ? {} : { key }),
      ...(operator === undefined ? {} : { operator }),
      ...(value === undefined ? {} : { value }),
      ...(effect === undefined ? {} : { effect: effect as NonNullable<Toleration["effect"]> }),
    });
  }
  return out;
}

export function placementFromEnv(env: Record<string, string | undefined> = process.env): Placement {
  if (env["FORGE_CHECKS_PLACEMENT"]?.trim() !== "job") return { mode: "process" };
  const image = env["FORGE_CHECKS_IMAGE"]?.trim() ?? "";
  const claim = env["FORGE_CHECKS_CLAIM"]?.trim() ?? "";
  const nodeSelector = parseSelector(env["FORGE_CHECKS_NODE_SELECTOR"] ?? "");
  const tolerations = parseTolerations(env["FORGE_CHECKS_TOLERATIONS"]?.trim() || "[]");
  // A job placement that cannot be built is not guessed at.
  if (image === "" || /\s/.test(image) || claim === "" || !nodeSelector || !tolerations) return { mode: "process" };
  return { mode: "job", image, claim, nodeSelector, tolerations };
}

/**
 * Where a run ran, in plain words, for a person to read. Nothing for the
 * default `process` or a run that predates the record: only the unusual is
 * said. The node comes from the cluster, so it is cut to printable ASCII
 * here as well as escaped by whatever shows it.
 */
export function placementWords(run: { placement: string; node: string }): string {
  if (run.placement !== "job") return "";
  const node = run.node.replace(/[^\x21-\x7e]/g, "").slice(0, 253);
  return node === "" ? "ran as a cluster job" : `ran as a cluster job on ${node}`;
}
